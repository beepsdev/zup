/**
 * Plugin System Types
 *
 * Following better-auth plugin patterns:
 * - Plugin as function returning object
 * - Init hook for context/options modification
 * - Sequential plugin initialization with merging
 */

import type { AgentContext, AgentOptions } from './context';
import type { Observer, Observation } from './observation';
import type { Orienter, Situation } from './situation';
import type { DecisionStrategy, Decision } from './decision';
import type { Action, ActionResult } from './action';
import type { LoopResult } from './context';
import type { Awaitable } from './common';

/**
 * Endpoint definition for REST API
 */
export type Endpoint = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description?: string;
  handler: (ctx: import('../api/types').RequestContext) => Awaitable<Response>;
  auth?: boolean; // true = auth required (default), false = no auth
  schema?: unknown; // Zod schema for validation
};

/**
 * Middleware function
 */
export type Middleware = (req: Request, ctx: AgentContext, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * State schema definition
 */
export type StateSchema = {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    default?: unknown;
  };
};

/**
 * Main plugin type - follows better-auth pattern
 *
 * Pattern: Plugin is a function that returns an object
 */
export type ZupPlugin = {
  /** Unique plugin identifier */
  id: string;

  /**
   * Initialization hook - runs when plugin is loaded
   * Can modify context and options (will be merged)
   * Runs sequentially for all plugins
   */
  init?: (ctx: AgentContext) => Awaitable<{
    context?: Partial<Omit<AgentContext, 'options'>>;
    options?: Partial<AgentOptions>;
  } | void>;

  /**
   * OBSERVE Phase
   */
  observers?: Record<string, Observer>;
  onObserve?: (observations: Observation[], ctx: AgentContext) => Awaitable<{
    observations?: Observation[]; // Can add more observations
  } | void>;

  /**
   * ORIENT Phase
   */
  orienters?: Record<string, Orienter>;
  onOrient?: (situation: Situation, ctx: AgentContext) => Awaitable<{
    situation?: Partial<Situation>; // Can enrich situation
  } | void>;

  /**
   * DECIDE Phase
   */
  decisionStrategies?: Record<string, DecisionStrategy>;
  onDecide?: (decision: Decision, ctx: AgentContext) => Awaitable<{
    decision?: Partial<Decision>; // Can modify decision
    veto?: boolean; // Can block decision
  } | void>;

  /**
   * ACT Phase
   */
  actions?: Record<string, Action>;
  onBeforeAct?: (action: Action, params: Record<string, unknown>, ctx: AgentContext) => Awaitable<void>;
  onAfterAct?: (result: ActionResult, ctx: AgentContext) => Awaitable<void>;

  /**
   * Loop-level hooks
   */
  onLoopStart?: (ctx: AgentContext) => Awaitable<void>;
  onLoopComplete?: (loopResult: LoopResult, ctx: AgentContext) => Awaitable<void>;

  /**
   * REST API endpoints
   */
  endpoints?: Record<string, Endpoint>;

  /**
   * Middleware
   */
  middleware?: Middleware[];

  /**
   * State/Memory schema
   */
  schema?: StateSchema;

  /**
   * Type inference helper (advanced, optional)
   */
  $Infer?: Record<string, unknown>;
};

/**
 * Helper type for creating plugins
 */
export type ZupPluginFunction<TOptions = Record<string, unknown>> = (options?: TOptions) => ZupPlugin;
