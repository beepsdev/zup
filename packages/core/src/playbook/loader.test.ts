import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter, parsePlaybook, loadPlaybooksFromDir } from './loader';

describe('parseFrontmatter', () => {
  test('parses simple key-value pairs', () => {
    const raw = `---
name: Test Playbook
description: A test playbook
priority: 10
---
Body content here.`;

    const { metadata, content } = parseFrontmatter(raw);
    expect(metadata.name).toBe('Test Playbook');
    expect(metadata.description).toBe('A test playbook');
    expect(metadata.priority).toBe(10);
    expect(content).toBe('Body content here.');
  });

  test('parses inline arrays', () => {
    const raw = `---
name: Test
description: Test
tags: [alpha, beta, gamma]
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('parses dash-style arrays', () => {
    const raw = `---
name: Test
description: Test
keywords:
  - error rate
  - 5xx
  - timeout
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.keywords).toEqual(['error rate', '5xx', 'timeout']);
  });

  test('parses nested objects (one level)', () => {
    const raw = `---
name: Test
description: Test
trigger:
  severity: warning
  keywords: [cpu, memory]
  sources: [kubernetes]
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.trigger).toEqual({
      severity: 'warning',
      keywords: ['cpu', 'memory'],
      sources: ['kubernetes'],
    });
  });

  test('parses booleans', () => {
    const raw = `---
name: Test
description: Test
enabled: true
disabled: false
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.enabled).toBe(true);
    expect(metadata.disabled).toBe(false);
  });

  test('parses quoted strings', () => {
    const raw = `---
name: "Quoted Name"
description: 'Single quoted'
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.name).toBe('Quoted Name');
    expect(metadata.description).toBe('Single quoted');
  });

  test('handles multiline content after frontmatter', () => {
    const raw = `---
name: Test
description: Test
---
Line 1
Line 2
Line 3`;

    const { content } = parseFrontmatter(raw);
    expect(content).toBe('Line 1\nLine 2\nLine 3');
  });

  test('throws on missing frontmatter', () => {
    expect(() => parseFrontmatter('No frontmatter here')).toThrow('Missing frontmatter');
  });

  test('throws on unclosed frontmatter', () => {
    expect(() => parseFrontmatter('---\nname: Test\nNo closing')).toThrow('Missing frontmatter');
  });

  test('handles empty inline arrays', () => {
    const raw = `---
name: Test
description: Test
tags: []
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.tags).toEqual([]);
  });

  test('skips comment lines', () => {
    const raw = `---
name: Test
# This is a comment
description: Test
---
Content`;

    const { metadata } = parseFrontmatter(raw);
    expect(metadata.name).toBe('Test');
    expect(metadata.description).toBe('Test');
  });
});

describe('parsePlaybook', () => {
  const VALID_PLAYBOOK = `---
name: High Error Rate
description: Handling sustained high error rates
trigger:
  severity: warning
  keywords: [error rate, 5xx]
priority: 5
---
## Investigation Steps

1. Check error logs
2. Look for recent deployments`;

  test('parses a valid playbook', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK);
    expect(pb.name).toBe('High Error Rate');
    expect(pb.description).toBe('Handling sustained high error rates');
    expect(pb.trigger?.severity).toBe('warning');
    expect(pb.trigger?.keywords).toEqual(['error rate', '5xx']);
    expect(pb.priority).toBe(5);
    expect(pb.phases).toEqual(['orient', 'decide']);
    expect(pb.content).toContain('## Investigation Steps');
    expect(pb.source).toBe('inline');
  });

  test('generates ID from filename when not in frontmatter', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK, {
      sourcePath: '/path/to/High-Error-Rate.md',
    });
    expect(pb.id).toBe('high-error-rate');
  });

  test('uses explicit ID from frontmatter', () => {
    const raw = `---
id: custom-id
name: Test
description: Test
---
Content`;
    const pb = parsePlaybook(raw);
    expect(pb.id).toBe('custom-id');
  });

  test('defaults phases to orient and decide', () => {
    const raw = `---
name: Test
description: Test
---
Content`;
    const pb = parsePlaybook(raw);
    expect(pb.phases).toEqual(['orient', 'decide']);
  });

  test('respects explicit phases', () => {
    const raw = `---
name: Test
description: Test
phases: [orient]
---
Content`;
    const pb = parsePlaybook(raw);
    expect(pb.phases).toEqual(['orient']);
  });

  test('defaults priority to 0', () => {
    const raw = `---
name: Test
description: Test
---
Content`;
    const pb = parsePlaybook(raw);
    expect(pb.priority).toBe(0);
  });

  test('sets source metadata from options', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK, {
      source: 'plugin',
      pluginId: 'http-monitor',
    });
    expect(pb.source).toBe('plugin');
    expect(pb.pluginId).toBe('http-monitor');
  });

  test('throws on missing required fields', () => {
    const raw = `---
name: Test
---
Content`;
    expect(() => parsePlaybook(raw)).toThrow();
  });

  test('playbook with no trigger', () => {
    const raw = `---
name: General Guidance
description: Always-active playbook
---
Content`;
    const pb = parsePlaybook(raw);
    expect(pb.trigger).toBeUndefined();
  });
});

describe('loadPlaybooksFromDir', () => {
  let tmpDir: string;

  test('loads .md files from directory', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zup-playbook-test-'));

    await writeFile(join(tmpDir, 'error-rate.md'), `---
name: Error Rate
description: Handle error rates
---
Check error logs`);

    await writeFile(join(tmpDir, 'cpu-usage.md'), `---
name: CPU Usage
description: Handle CPU spikes
trigger:
  severity: warning
---
Check CPU metrics`);

    const playbooks = await loadPlaybooksFromDir(tmpDir);
    expect(playbooks).toHaveLength(2);

    const names = playbooks.map(p => p.name).sort();
    expect(names).toEqual(['CPU Usage', 'Error Rate']);

    for (const pb of playbooks) {
      expect(pb.source).toBe('filesystem');
      expect(pb.sourcePath).toBeDefined();
    }

    await rm(tmpDir, { recursive: true });
  });

  test('skips non-.md files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zup-playbook-test-'));

    await writeFile(join(tmpDir, 'valid.md'), `---
name: Valid
description: Valid playbook
---
Content`);

    await writeFile(join(tmpDir, 'readme.txt'), 'Not a playbook');

    const playbooks = await loadPlaybooksFromDir(tmpDir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]!.name).toBe('Valid');

    await rm(tmpDir, { recursive: true });
  });

  test('returns empty array for nonexistent directory', async () => {
    const playbooks = await loadPlaybooksFromDir('/nonexistent/path');
    expect(playbooks).toEqual([]);
  });

  test('skips files with invalid frontmatter', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zup-playbook-test-'));

    await writeFile(join(tmpDir, 'valid.md'), `---
name: Valid
description: Valid playbook
---
Content`);

    await writeFile(join(tmpDir, 'invalid.md'), 'No frontmatter here');

    const warnings: string[] = [];
    const mockLogger = {
      warn: (msg: string) => warnings.push(msg),
    };

    const playbooks = await loadPlaybooksFromDir(tmpDir, mockLogger);
    expect(playbooks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invalid.md');

    await rm(tmpDir, { recursive: true });
  });
});
