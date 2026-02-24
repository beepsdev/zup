/**
 * Run Types
 *
 * Types for externally-submitted work items that flow through the OODA loop.
 */

export type RunStatus = 'pending' | 'investigating' | 'completed' | 'failed' | 'cancelled';
export type RunPriority = 'low' | 'medium' | 'high' | 'critical';

export type RunResult = {
  summary: string;
  findings: string[];
  actionsPerformed: Array<{
    action: string;
    success: boolean;
    description: string;
  }>;
  loopIterations: number;
  duration: number;
  situationAssessment?: string;
  recommendations?: string[];
};

export type Run = {
  id: string;
  title: string;
  description: string;
  priority: RunPriority;
  status: RunStatus;
  context: Record<string, unknown>;
  source: string;
  callbackUrl?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: RunResult;
};

export type CreateRunInput = {
  title: string;
  description: string;
  priority?: RunPriority;
  context?: Record<string, unknown>;
  source?: string;
  callbackUrl?: string;
};
