import type { LoopResult } from '../../types/index';

export type ScribeOptions = {
  /**
   * Directory where incident markdown files are written and loaded from.
   * Default: './playbooks/incidents'
   */
  dir?: string;

  /** Only record resolutions with decision confidence >= this. Default: 0.7 */
  minConfidence?: number;

  /** Record incidents resolved by high/critical-risk actions. Default: false */
  includeHighRisk?: boolean;

  /**
   * Use the agent's LLM (when configured) to write the incident description,
   * trigger keywords, and lesson. Falls back to deterministic extraction when
   * false, when no LLM is configured, or when the LLM call fails.
   * Default: true
   */
  useLLM?: boolean;

  /**
   * Maximum number of existing incident files loaded at startup (newest
   * first, by filename — filenames embed the incident timestamp).
   * Default: 200
   */
  maxIncidents?: number;
};

/** The pieces of an incident record that the LLM (or fallback) generates. */
export type IncidentNarrative = {
  /** One-line description used in frontmatter and logging */
  description: string;
  /** Trigger keywords matched against future observations (lowercase) */
  keywords: string[];
  /** What future investigations should know — the "lesson learned" */
  lesson: string;
};

export type IncidentRecord = {
  id: string;
  narrative: IncidentNarrative;
  sources: string[];
  loopResult: LoopResult;
  date: Date;
};
