/**
 * Playbook Module
 *
 * Exports for the playbook system — markdown-based operational knowledge
 * that augments LLM context during orient/decide phases.
 */

export type { Playbook, PlaybookTrigger } from './types';

export { parseFrontmatter, parsePlaybook, loadPlaybooksFromDir } from './loader';
export type { ParsePlaybookOptions } from './loader';

export { matchPlaybooks } from './matcher';

export { buildAugmentedSystemPrompt, buildPlaybookSection } from './inject';
