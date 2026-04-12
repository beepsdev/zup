/**
 * Playbook Injection
 *
 * Formats matched playbooks and appends them to LLM system prompts.
 */

import type { Playbook } from './types';

/**
 * Format playbooks into a section suitable for system prompt injection.
 */
export function buildPlaybookSection(playbooks: Playbook[]): string {
  return playbooks
    .map(pb => `### Playbook: ${pb.name}\n\n${pb.content}`)
    .join('\n\n---\n\n');
}

/**
 * Build an augmented system prompt by appending matched playbooks.
 *
 * Returns the base prompt unchanged if no playbooks are provided.
 * Otherwise, appends a formatted section containing operational knowledge
 * from the matched playbooks.
 */
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
