/**
 * ACT Phase Types
 */

import type { AgentContext } from './context';
import type { RiskLevel } from './common';

export type ActionResult = {
  action: string;
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number; // ms
  sideEffects?: string[];
  metrics?: Record<string, number>;
};

/**
 * Schema validator interface - compatible with Zod and other validators
 */
export type SchemaValidator = {
  parse: (data: unknown) => Record<string, unknown>;
};

export type Action = {
  name: string;
  description: string;
  execute: (params: Record<string, unknown>, ctx: AgentContext) => Promise<ActionResult>;
  risk?: RiskLevel;
  schema?: SchemaValidator; // Parameter validation (e.g., Zod schema)
  rollback?: (params: Record<string, unknown>, ctx: AgentContext) => Promise<void>;
  dryRun?: (params: Record<string, unknown>, ctx: AgentContext) => Promise<string>;

  // Autonomy control (simplified for v1)
  autonomy?: {
    mode: 'auto' | 'approval-required' | 'human-only';
    minConfidence?: number;
  };
};
