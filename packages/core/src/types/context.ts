/**
 * Agent Context Types
 */

import type { Observer, Observation } from './observation';
import type { Orienter } from './situation';
import type { DecisionStrategy } from './decision';
import type { Action, ActionResult } from './action';
import type { Situation, Decision } from './index';
import type { LoopPhase, Logger } from './common';
import type { LLMConfig, LLMCapability } from '../llm/types';
import type { SQLiteConfig, SQLiteCapability } from '../db/index';
import type { Playbook } from '../playbook/types';

export type StateStore = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  has: (key: string) => boolean;
};

export type LoopResult = {
  observations: Observation[];
  situation?: Situation;
  decision?: Decision;
  actionResults: ActionResult[];
  duration: number;
  success: boolean;
  error?: string;
};

export type AgentOptions = {
  // Agent identity
  id?: string;
  name?: string;
  model?: string; // Deprecated: use llm.model instead
  systemPrompt?: string;

  // Logging
  logger?: Logger;

  // LLM configuration (optional)
  llm?: LLMConfig;

  // Loop configuration
  mode?: 'manual' | 'continuous' | 'event-driven';
  loopInterval?: number; // For continuous mode (ms)

  // API configuration
  api?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    auth?: {
      apiKeys?: Array<{
        key: string;
        name: string;
        permissions?: string[];
      }>;
      /**
       * Allow unauthenticated access when no API keys are configured.
       * Defaults to false.
       */
      allowUnauthenticated?: boolean;
    };
  };

  // Approval queue configuration
  approvals?: {
    /** Enable auto-expire for pending approvals (default: true) */
    autoExpire?: boolean;
    /** Expiration TTL in milliseconds (default: 3600000) */
    ttlMs?: number;
  };

  // Plugins
  plugins?: unknown[]; // ZupPlugin[] - circular dependency avoided with unknown

  // State persistence
  statePersistence?: {
    enabled: boolean;
    type: 'memory' | 'file' | 'database';
    config?: {
      /** File path for persisted state (used when type = "file"). */
      path?: string;
      /** Debounce interval for flushes (ms). Defaults to 1000. */
      flushIntervalMs?: number;
      /** Table name for persisted state (used when type = "database"). */
      tableName?: string;
      [key: string]: unknown;
    };
  };

  // SQLite database configuration (optional)
  sqlite?: SQLiteConfig;

  // Playbooks — markdown-based operational knowledge for LLM context
  /** Directory path to load playbook .md files from */
  playbooksDir?: string;
  /** Inline playbook definitions */
  playbooks?: Playbook[];

  // Other configuration
  [key: string]: unknown;
};

export type AgentContext = {
  // Agent identity
  agent: {
    id: string;
    name: string;
    model: string; // LLM model
    systemPrompt: string;
  };

  // Logging
  logger: Logger;

  // LLM capability (optional - only if configured)
  llm?: LLMCapability;

  // SQLite database capability (optional - only if configured)
  sqlite?: SQLiteCapability;

  // Current OODA loop state
  loop: {
    iteration: number;
    phase: LoopPhase;
    startTime: Date;
    observations: Observation[];
    situation?: Situation;
    decision?: Decision;
    actionResults: ActionResult[];
  };

  // Available capabilities (populated by plugins)
  capabilities: {
    observers: Map<string, Observer>;
    orienters: Map<string, Orienter>;
    decisionStrategies: Map<string, DecisionStrategy>;
    actions: Map<string, Action>;
  };

  // State/Memory
  state: StateStore;
  history: LoopResult[];

  // Configuration
  options: AgentOptions;

  // Plugin-specific data (plugins can add their own data here)
  [pluginId: string]: unknown;
};
