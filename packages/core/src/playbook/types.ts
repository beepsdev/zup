/**
 * Playbook Types
 *
 * Playbooks are markdown files containing operational knowledge that gets
 * injected into LLM context during orient/decide phases when triggered
 * by matching observations.
 */

import type { Observation } from '../types/observation';
import type { Situation } from '../types/situation';
import type { ObservationSeverity } from '../types/common';

/**
 * Trigger conditions that determine when a playbook activates.
 * Multiple conditions use AND logic — all specified must match.
 */
export type PlaybookTrigger = {
  /** Minimum observation severity to activate this playbook */
  severity?: ObservationSeverity;
  /** Keywords matched against observation data (case-insensitive, any keyword match activates) */
  keywords?: string[];
  /** Observation source prefixes to match (e.g., "http-monitor", "kubernetes") */
  sources?: string[];
  /** Custom match function for complex conditions */
  custom?: (observations: Observation[], situation?: Situation) => boolean;
};

/**
 * A playbook definition — operational knowledge for LLM context injection.
 */
export type Playbook = {
  /** Unique identifier (derived from filename or explicit in frontmatter) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description — used for logging and relevance matching */
  description: string;
  /** When this playbook activates */
  trigger?: PlaybookTrigger;
  /** Which OODA phases receive this playbook's content */
  phases: ('orient' | 'decide')[];
  /** Ordering when multiple playbooks match (higher = injected first). Default: 0 */
  priority: number;
  /** The full markdown body (below frontmatter) */
  content: string;
  /** Where this playbook came from */
  source: 'inline' | 'filesystem' | 'plugin';
  /** File path if loaded from filesystem */
  sourcePath?: string;
  /** Plugin ID if bundled with a plugin */
  pluginId?: string;
};
