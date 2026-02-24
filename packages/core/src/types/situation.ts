/**
 * ORIENT Phase Types
 */

import type { AgentContext } from './context';
import type { Observation } from './observation';
import type { Priority } from './common';

export type SituationAssessment = {
  source: string;
  findings: string[];
  contributingFactor?: string;
  impactAssessment?: string;
  confidence: number; // 0-1
};

export type Anomaly = {
  type: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedResources?: string[];
};

export type Correlation = {
  observations: string[]; // observation sources
  description: string;
  confidence: number; // 0-1
};

export type Situation = {
  summary: string; // LLM-generated summary
  assessments: SituationAssessment[];
  anomalies: Anomaly[];
  correlations: Correlation[];
  priority: Priority;
  confidence: number; // 0-1
};

export type Orienter = {
  name: string;
  description: string;
  orient: (observations: Observation[], ctx: AgentContext) => Promise<SituationAssessment>;
};
