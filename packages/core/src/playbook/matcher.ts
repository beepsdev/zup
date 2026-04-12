/**
 * Playbook Matcher
 *
 * Determines which playbooks activate given current observations and OODA phase.
 */

import type { Playbook } from './types';
import type { Observation } from '../types/observation';
import type { Situation } from '../types/situation';
import type { ObservationSeverity } from '../types/common';

const SEVERITY_ORDER: ObservationSeverity[] = ['info', 'warning', 'error', 'critical'];

/**
 * Match playbooks against current observations for a given OODA phase.
 *
 * A playbook matches if:
 * 1. It applies to the given phase
 * 2. ALL specified trigger conditions are met (AND logic)
 *    - severity: any observation meets the threshold
 *    - keywords: any keyword found in any observation's data
 *    - sources: any observation source matches a prefix
 *    - custom: custom function returns true
 * 3. No trigger = always matches (catch-all playbook)
 *
 * Returns matched playbooks sorted by priority descending (highest first).
 */
export function matchPlaybooks(
  playbooks: Playbook[],
  observations: Observation[],
  phase: 'orient' | 'decide',
  situation?: Situation
): Playbook[] {
  const matched = playbooks.filter(pb => {
    if (!pb.phases.includes(phase)) return false;

    const trigger = pb.trigger;
    if (!trigger) return true;

    const hasSeverity = trigger.severity !== undefined;
    const hasKeywords = trigger.keywords !== undefined && trigger.keywords.length > 0;
    const hasSources = trigger.sources !== undefined && trigger.sources.length > 0;
    const hasCustom = trigger.custom !== undefined;

    // If no trigger conditions are specified, always match
    if (!hasSeverity && !hasKeywords && !hasSources && !hasCustom) return true;

    if (hasSeverity && !matchesSeverity(observations, trigger.severity!)) return false;
    if (hasKeywords && !matchesKeywords(observations, trigger.keywords!)) return false;
    if (hasSources && !matchesSources(observations, trigger.sources!)) return false;
    if (hasCustom) {
      try {
        if (!trigger.custom!(observations, situation)) return false;
      } catch {
        return false;
      }
    }

    return true;
  });

  return matched.sort((a, b) => b.priority - a.priority);
}

function matchesSeverity(observations: Observation[], threshold: ObservationSeverity): boolean {
  const thresholdIdx = SEVERITY_ORDER.indexOf(threshold);
  return observations.some(obs => {
    if (!obs.severity) return false;
    const obsIdx = SEVERITY_ORDER.indexOf(obs.severity as ObservationSeverity);
    return obsIdx >= thresholdIdx;
  });
}

function matchesKeywords(observations: Observation[], keywords: string[]): boolean {
  const obsText = observations
    .map(o => `${o.source} ${JSON.stringify(o.data)}`.toLowerCase())
    .join(' ');
  return keywords.some(kw => obsText.includes(kw.toLowerCase()));
}

function matchesSources(observations: Observation[], sources: string[]): boolean {
  return observations.some(obs =>
    sources.some(src => obs.source.startsWith(src))
  );
}
