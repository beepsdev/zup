/**
 * Generate llms-full.txt from all documentation markdown files.
 *
 * Concatenates every doc page into a single markdown file for LLM consumption.
 * Run: bun apps/docs/scripts/generate-llms-full.ts
 */

import { Glob } from 'bun';

const DOCS_DIR = new URL('../src/content/docs', import.meta.url).pathname;
const OUTPUT = new URL('../public/llms-full.txt', import.meta.url).pathname;

// Ordered sections matching the sidebar structure
const ordered = [
  'index.md',
  'getting-started.md',
  'examples.md',
  'core-concepts.md',
  'agent-config.md',
  'ooda-loop.md',
  'state.md',
  'approvals.md',
  'plugins/index.md',
  'plugins/authoring.md',
  'plugins/http-monitor.md',
  'plugins/historian.md',
  'plugins/investigation-orienter.md',
  'plugins/kubernetes.md',
  'plugins/cloud-run.md',
  'plugins/fly-machines.md',
  'plugins/vercel-deploys.md',
  'plugins/github-activity.md',
  'integrations/llm.md',
  'integrations/sqlite.md',
  'api/index.md',
  'api/typescript.md',
];

const parts: string[] = [];

parts.push('# Zup');
parts.push('');
parts.push('> Zup is an open source reliability agent framework that runs the OODA loop (Observe, Orient, Decide, Act) on your production systems.');
parts.push('');

for (const relPath of ordered) {
  const filePath = `${DOCS_DIR}/${relPath}`;
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    console.warn(`Skipping missing file: ${relPath}`);
    continue;
  }

  let content = await file.text();

  // Strip YAML frontmatter
  content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  content = content.trim();

  if (content) {
    parts.push(content);
    parts.push('');
    parts.push('---');
    parts.push('');
  }
}

await Bun.write(OUTPUT, parts.join('\n'));
console.log(`Generated ${OUTPUT}`);
