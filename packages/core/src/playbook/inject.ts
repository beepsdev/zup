import type { Playbook } from './types';

export function buildPlaybookSection(playbooks: Playbook[]): string {
  return playbooks
    .map(pb => `### Playbook: ${pb.name}\n\n${pb.content}`)
    .join('\n\n---\n\n');
}

export function buildAugmentedSystemPrompt(
  basePrompt: string,
  playbooks: Playbook[]
): string {
  if (playbooks.length === 0) return basePrompt;

  const section = buildPlaybookSection(playbooks);

  return `${basePrompt}

---

## Operational Playbooks

The following playbooks contain institutional knowledge from the team. Use them to guide your investigation and analysis — they describe system-specific context, known patterns, and decision heuristics that aren't derivable from raw metrics alone.

${section}`;
}
