/**
 * OBSERVE Phase Types
 */

import type { AgentContext } from './context';
import type { Awaitable, ObservationType, ObservationSeverity } from './common';

export type Observation = {
  source: string;
  timestamp: Date;
  type: ObservationType;
  severity?: ObservationSeverity;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type Observer = {
  name: string;
  description: string;
  observe: (ctx: AgentContext) => Promise<Observation[]>;
  interval?: number; // For continuous monitoring (ms)
  cost?: number; // API call cost estimate
};

export type ObserverRegistration = {
  id: string;
  observer: Observer;
};
