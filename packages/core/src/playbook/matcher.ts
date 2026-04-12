import type { Playbook } from './types';
import type { Observation } from '../types/observation';
import type { Situation } from '../types/situation';
import type { ObservationSeverity } from '../types/common';
import { meetsThreshold } from '../types/common';

/**
 * Returns playbooks matching current observations for a given OODA phase.
 * Trigger conditions use AND logic. No trigger = always matches.
 * Input playbooks should be pre-sorted by priority (loader does this).
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
  return observations.some(obs => meetsThreshold(obs.severity, threshold));
}

// Keywords are pre-lowercased at parse time
function matchesKeywords(observations: Observation[], keywords: string[]): boolean {
  const obsText = observations
    .map(o => `${o.source} ${JSON.stringify(o.data)}`.toLowerCase())
    .join(' ');
  return keywords.some(kw => obsText.includes(kw));
}

function matchesSources(observations: Observation[], sources: string[]): boolean {
  return observations.some(obs =>
    sources.some(src => obs.source.startsWith(src))
  );
}
