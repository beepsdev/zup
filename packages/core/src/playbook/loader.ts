import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { z } from 'zod';
import { SEVERITY_LEVELS } from '../types/common';
import type { Playbook, PlaybookTrigger } from './types';

const PlaybookFrontmatterSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  trigger: z.object({
    severity: z.enum(SEVERITY_LEVELS).optional(),
    keywords: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
  }).optional(),
  phases: z.array(z.enum(['orient', 'decide'])).optional(),
  priority: z.number().optional(),
});

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
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indented = line.startsWith('  ') || line.startsWith('\t');

    if (indented && currentKey !== null) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('- ')) {
        const value = trimmedLine.slice(2).trim();
        if (currentArray === null) {
          currentArray = [];
        }
        currentArray.push(stripQuotes(value));
        result[currentKey] = currentArray;
        continue;
      }

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

    const topMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (topMatch) {
      currentArray = null;

      const [, key, rawValue] = topMatch;
      const value = rawValue!.trim();

      if (value === '') {
        // Key with no inline value -- next indented lines are nested object or array
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
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(item => stripQuotes(item.trim()));
  }

  if (value === 'true') return true;
  if (value === 'false') return false;

  const num = Number(value);
  if (value !== '' && !isNaN(num) && String(num) === value) return num;

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

export function parsePlaybook(raw: string, options: ParsePlaybookOptions = {}): Playbook {
  const { metadata, content } = parseFrontmatter(raw);
  const validated = PlaybookFrontmatterSchema.parse(metadata);

  const id = validated.id
    || (options.sourcePath
      ? basename(options.sourcePath, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : 'unknown');

  // Pre-lowercase keywords so the matcher doesn't repeat this every loop iteration
  const trigger: PlaybookTrigger | undefined = validated.trigger
    ? {
        severity: validated.trigger.severity,
        keywords: validated.trigger.keywords?.map(kw => kw.toLowerCase()),
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

  const results = await Promise.allSettled(
    entries.map(async (filename) => {
      const filePath = join(dirPath, filename);
      const raw = await Bun.file(filePath).text();
      return parsePlaybook(raw, {
        source: 'filesystem',
        sourcePath: filePath,
      });
    })
  );

  const playbooks: Playbook[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      playbooks.push(result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger?.warn(`Failed to parse playbook ${entries[i]}: ${message}`);
    }
  }

  // Pre-sort by priority so matchPlaybooks can skip sorting on the hot path
  playbooks.sort((a, b) => b.priority - a.priority);

  return playbooks;
}
