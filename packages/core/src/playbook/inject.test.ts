import { describe, test, expect } from 'bun:test';
import { buildAugmentedSystemPrompt, buildPlaybookSection } from './inject';
import type { Playbook } from './types';

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'test',
    name: 'Test Playbook',
    description: 'Test',
    phases: ['orient'],
    priority: 0,
    content: 'Test playbook content.',
    source: 'inline',
    ...overrides,
  };
}

describe('buildPlaybookSection', () => {
  test('formats a single playbook', () => {
    const section = buildPlaybookSection([makePlaybook({ name: 'Error Rate' })]);
    expect(section).toContain('### Playbook: Error Rate');
    expect(section).toContain('Test playbook content.');
  });

  test('formats multiple playbooks with separators', () => {
    const playbooks = [
      makePlaybook({ name: 'First', content: 'First content' }),
      makePlaybook({ name: 'Second', content: 'Second content' }),
    ];
    const section = buildPlaybookSection(playbooks);
    expect(section).toContain('### Playbook: First');
    expect(section).toContain('### Playbook: Second');
    expect(section).toContain('---');
    expect(section).toContain('First content');
    expect(section).toContain('Second content');
  });
});

describe('buildAugmentedSystemPrompt', () => {
  const BASE_PROMPT = 'You are an SRE agent.';

  test('returns base prompt unchanged when no playbooks', () => {
    const result = buildAugmentedSystemPrompt(BASE_PROMPT, []);
    expect(result).toBe(BASE_PROMPT);
  });

  test('appends playbook section when playbooks provided', () => {
    const playbooks = [makePlaybook({ name: 'CPU Guide', content: 'Check CPU metrics.' })];
    const result = buildAugmentedSystemPrompt(BASE_PROMPT, playbooks);

    expect(result).toContain(BASE_PROMPT);
    expect(result).toContain('## Operational Playbooks');
    expect(result).toContain('### Playbook: CPU Guide');
    expect(result).toContain('Check CPU metrics.');
  });

  test('base prompt appears before playbooks', () => {
    const playbooks = [makePlaybook()];
    const result = buildAugmentedSystemPrompt(BASE_PROMPT, playbooks);

    const baseIdx = result.indexOf(BASE_PROMPT);
    const playbookIdx = result.indexOf('## Operational Playbooks');
    expect(baseIdx).toBeLessThan(playbookIdx);
  });

  test('includes institutional knowledge framing', () => {
    const playbooks = [makePlaybook()];
    const result = buildAugmentedSystemPrompt(BASE_PROMPT, playbooks);
    expect(result).toContain('institutional knowledge');
  });
});
