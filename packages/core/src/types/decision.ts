/**
 * DECIDE Phase Types
 */

import type { AgentContext } from './context';
import type { Situation } from './situation';
import type { RiskLevel } from './common';

export type Decision = {
  action: string; // Which action to take
  params: Record<string, unknown>;
  rationale: string; // Why this decision
  alternatives?: Decision[];
  confidence: number; // 0-1
  risk: RiskLevel;
  requiresApproval: boolean;
  estimatedImpact?: string;
};

export type DecisionStrategy = {
  name: string;
  description: string;
  decide: (situation: Situation, ctx: AgentContext) => Promise<Decision>;
  applicableWhen?: (situation: Situation) => boolean;
};
