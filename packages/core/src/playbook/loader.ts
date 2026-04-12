/**
 * Playbook Loader
 *
 * Parses markdown files with YAML frontmatter into Playbook objects.
 * Uses a minimal frontmatter parser — no external YAML dependency needed.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { z } from 'zod';
import type { Playbook, PlaybookTrigger } from './types';

/**
 * Zod schema for validated playbook frontmatter.
 */
const PlaybookFrontmatterSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  trigger: z.object({
    severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
    keywords: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
  }).optional(),
  phases: z.array(z.enum(['orient', 'decide'])).optional(),
  priority: z.number().optional(),
});

type ParsedFrontmatter = z.infer<typeof PlaybookFrontmatterSchema>;

/**
 * Minimal YAML frontmatter parser.
 *
 * Handles the subset needed for playbooks:
 * - Simple key: value pairs (strings, numbers, booleans)
 * - Inline arrays: [a, b, c]
 * - Dash arrays under a key
 * - One-level nested objects (e.g., trigger.severity)
 */
export function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    throw new Error('Missing frontmatter: file must start with ---');
  }

  const firstNewline = trimmed.indexOf('\n');
  const rest = trimmed.slice(firstNewline + 1);
  const closingIdx = rest.indexOf('\n---');

  if (closingIdx === -1) {
    throw new Error('Missing frontmatter: no closing ---');
  }

  const yamlBlock = rest.slice(0, closingIdx);
  // Content starts after the closing --- and its newline
  const afterClosing = rest.slice(closingIdx + 4); // '\n---'.length = 4
  const content = afterClosing.startsWith('\n') ? afterClosing.slice(1) : afterClosing;

  const metadata = parseYamlBlock(yamlBlock);
  return { metadata, content };
}

function parseYamlBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indented = line.startsWith('  ') || line.startsWith('\t');

    if (indented && currentKey !== null) {
      const trimmedLine = line.trim();

      // Dash array item: - value
      if (trimmedLine.startsWith('- ')) {
        const value = trimmedLine.slice(2).trim();
        if (currentArray === null) {
          currentArray = [];
        }
        currentArray.push(stripQuotes(value));
        result[currentKey] = currentArray;
        continue;
      }

      // Nested key: value (one level deep)
      const nestedMatch = trimmedLine.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (nestedMatch) {
        const [, nestedKey, nestedValue] = nestedMatch;
        if (typeof result[currentKey] !== 'object' || Array.isArray(result[currentKey])) {
          result[currentKey] = {};
        }
        (result[currentKey] as Record<string, unknown>)[nestedKey!] = parseValue(nestedValue!.trim());
        currentArray = null;
        continue;
      }
    }

    // Top-level key: value
    const topMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (topMatch) {
      // Flush any pending array
      currentArray = null;

      const [, key, rawValue] = topMatch;
      const value = rawValue!.trim();

      if (value === '' || value === '|' || value === '>') {
        // Key with no inline value — next indented lines are nested object or array
        currentKey = key!;
        result[currentKey] = {};
        continue;
      }

      currentKey = key!;
      result[currentKey] = parseValue(value);
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  // Inline array: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(item => stripQuotes(item.trim()));
  }

  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Number
  const num = Number(value);
  if (value !== '' && !isNaN(num) && String(num) === value) return num;

  // String (strip quotes if present)
  return stripQuotes(value);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export type ParsePlaybookOptions = {
  source?: 'inline' | 'filesystem' | 'plugin';
  sourcePath?: string;
  pluginId?: string;
};

/**
 * Parse a raw markdown string (with frontmatter) into a Playbook.
 */
export function parsePlaybook(raw: string, options: ParsePlaybookOptions = {}): Playbook {
  const { metadata, content } = parseFrontmatter(raw);
  const validated = PlaybookFrontmatterSchema.parse(metadata);

  const id = validated.id
    || (options.sourcePath
      ? basename(options.sourcePath, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : 'unknown');

  const trigger: PlaybookTrigger | undefined = validated.trigger
    ? {
        severity: validated.trigger.severity,
        keywords: validated.trigger.keywords,
        sources: validated.trigger.sources,
      }
    : undefined;

  return {
    id,
    name: validated.name,
    description: validated.description,
    trigger,
    phases: validated.phases || ['orient', 'decide'],
    priority: validated.priority ?? 0,
    content,
    source: options.source || 'inline',
    sourcePath: options.sourcePath,
    pluginId: options.pluginId,
  };
}

/**
 * Load all playbook .md files from a directory.
 * Skips files that fail to parse (logs warning). Returns empty array for missing directories.
 */
export async function loadPlaybooksFromDir(
  dirPath: string,
  logger?: { warn: (msg: string, ...args: unknown[]) => void }
): Promise<Playbook[]> {
  let entries: string[];
  try {
    const dirEntries = await readdir(dirPath);
    entries = dirEntries.filter(f => f.endsWith('.md'));
  } catch {
    logger?.warn(`Playbooks directory not found: ${dirPath}`);
    return [];
  }

  const playbooks: Playbook[] = [];

  for (const filename of entries) {
    const filePath = join(dirPath, filename);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const playbook = parsePlaybook(raw, {
        source: 'filesystem',
        sourcePath: filePath,
      });
      playbooks.push(playbook);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`Failed to parse playbook ${filename}: ${message}`);
    }
  }

  return playbooks;
}
