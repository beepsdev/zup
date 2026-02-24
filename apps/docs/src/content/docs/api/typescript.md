---
title: TypeScript API Reference
description: Complete reference for all exported functions, types, and interfaces from zupdev.
---

All public APIs are exported from the `zupdev` package. Types can also be imported from `zupdev/types`.

```ts
import { createAgent, definePlugin, createObserver } from 'zupdev';
import type { AgentContext, Observation } from 'zupdev';
```

## Agent

### createAgent(options?)

Creates and initializes a Zup agent. Plugins are loaded, capabilities are registered, and the state store is configured.

```ts
function createAgent(options?: AgentOptions): Promise<ZupAgent>
```

Returns a `ZupAgent` with these methods:

| Method | Signature | Description |
|---|---|---|
| `runLoop()` | `() => Promise<LoopResult>` | Execute one OODA loop iteration. Concurrent calls return the same promise. |
| `executeAction(id, params?)` | `(id: string, params?: Record<string, unknown>) => Promise<ActionResult>` | Execute a registered action directly, bypassing the loop. |
| `start()` | `() => Promise<(() => void) \| undefined>` | Start the agent in its configured mode. Returns a stop function in continuous mode. |
| `startApi(options?)` | `(options?) => ApiServer` | Start the REST API server. |
| `getContext()` | `() => AgentContext` | Return the current agent context. |
| `getCapabilities()` | `() => { observers, orienters, decisionStrategies, actions }` | List registered capability IDs as string arrays. |
| `getHistory()` | `() => LoopResult[]` | Return all past loop results from this session. |
| `getState()` | `() => StateStore` | Return the state store for reading/writing. |

### AgentOptions

All fields are optional.

```ts
type AgentOptions = {
  id?: string;                    // Default: random UUID
  name?: string;                  // Default: 'Zup'
  systemPrompt?: string;          // Default: SRE agent prompt
  logger?: Logger;                // Default: console

  llm?: LLMConfig;                // LLM provider configuration
  mode?: 'manual' | 'continuous' | 'event-driven';  // Default: 'manual'
  loopInterval?: number;          // Continuous mode interval in ms (default: 60000)

  sqlite?: SQLiteConfig;          // SQLite database configuration
  statePersistence?: {
    enabled: boolean;
    type: 'memory' | 'file' | 'database';
    config?: {
      path?: string;
      flushIntervalMs?: number;
      tableName?: string;
    };
  };

  api?: {
    port?: number;
    host?: string;
    auth?: {
      apiKeys?: Array<{ key: string; name: string; permissions?: string[] }>;
      allowUnauthenticated?: boolean;
    };
  };

  approvals?: {
    autoExpire?: boolean;          // Default: true
    ttlMs?: number;                // Default: 3600000 (1 hour)
  };

  plugins?: ZupPlugin[];
};
```

### AgentContext

The context object available to all plugins and observers. Passed as `ctx` throughout the framework.

```ts
type AgentContext = {
  agent: {
    id: string;
    name: string;
    model: string;
    systemPrompt: string;
  };

  logger: Logger;
  llm?: LLMCapability;
  sqlite?: SQLiteCapability;

  loop: {
    iteration: number;
    phase: LoopPhase;
    startTime: Date;
    observations: Observation[];
    situation?: Situation;
    decision?: Decision;
    actionResults: ActionResult[];
  };

  capabilities: {
    observers: Map<string, Observer>;
    orienters: Map<string, Orienter>;
    decisionStrategies: Map<string, DecisionStrategy>;
    actions: Map<string, Action>;
  };

  state: StateStore;
  history: LoopResult[];
  options: AgentOptions;

  // Plugin-specific data (plugins can add their own keys)
  [pluginId: string]: unknown;
};
```

---

## Plugin system

### definePlugin(plugin)

Identity function that returns the plugin object. Provides type checking and IDE autocomplete.

```ts
function definePlugin(plugin: ZupPlugin): ZupPlugin
```

### ZupPlugin

The full plugin type. All fields except `id` are optional.

```ts
type ZupPlugin = {
  id: string;

  // Lifecycle
  init?: (ctx: AgentContext) => Awaitable<{
    context?: Partial<Omit<AgentContext, 'options'>>;
    options?: Partial<AgentOptions>;
  } | void>;

  // OODA components
  observers?: Record<string, Observer>;
  orienters?: Record<string, Orienter>;
  decisionStrategies?: Record<string, DecisionStrategy>;
  actions?: Record<string, Action>;

  // Phase hooks
  onObserve?: (observations: Observation[], ctx: AgentContext) => Awaitable<{
    observations?: Observation[];
  } | void>;
  onOrient?: (situation: Situation, ctx: AgentContext) => Awaitable<{
    situation?: Partial<Situation>;
  } | void>;
  onDecide?: (decision: Decision, ctx: AgentContext) => Awaitable<{
    decision?: Partial<Decision>;
    veto?: boolean;
  } | void>;

  // Action hooks
  onBeforeAct?: (action: Action, params: Record<string, unknown>, ctx: AgentContext) => Awaitable<void>;
  onAfterAct?: (result: ActionResult, ctx: AgentContext) => Awaitable<void>;

  // Loop hooks
  onLoopStart?: (ctx: AgentContext) => Awaitable<void>;
  onLoopComplete?: (loopResult: LoopResult, ctx: AgentContext) => Awaitable<void>;

  // API
  endpoints?: Record<string, Endpoint>;
  middleware?: Middleware[];

  // State
  schema?: StateSchema;
};
```

### ZupPluginFunction

Helper type for plugin factory functions:

```ts
type ZupPluginFunction<TOptions = Record<string, unknown>> =
  (options?: TOptions) => ZupPlugin;
```

### initializePlugins(ctx, plugins)

Runs plugin `init` hooks sequentially and registers all capabilities. Used internally by `createAgent`.

```ts
function initializePlugins(
  ctx: AgentContext,
  plugins: ZupPlugin[]
): Promise<{ context: AgentContext; options: AgentOptions }>
```

### executePluginHooks(plugins, hookName, ...args)

Execute a named hook on all plugins sequentially. Returns the non-`undefined` results.

```ts
function executePluginHooks<T extends keyof ZupPlugin>(
  plugins: ZupPlugin[],
  hookName: T,
  ...args: unknown[]
): Promise<unknown[]>
```

---

## Component factories

These functions are identity functions that provide type checking. They do not transform the input.

### createObserver(observer)

```ts
function createObserver(observer: Observer): Observer

type Observer = {
  name: string;
  description: string;
  observe: (ctx: AgentContext) => Promise<Observation[]>;
  interval?: number;   // For continuous mode (ms)
  cost?: number;       // API call cost estimate
};
```

### createOrienter(orienter)

```ts
function createOrienter(orienter: Orienter): Orienter

type Orienter = {
  name: string;
  description: string;
  orient: (observations: Observation[], ctx: AgentContext) => Promise<SituationAssessment>;
};
```

### createDecisionStrategy(strategy)

```ts
function createDecisionStrategy(strategy: DecisionStrategy): DecisionStrategy

type DecisionStrategy = {
  name: string;
  description: string;
  decide: (situation: Situation, ctx: AgentContext) => Promise<Decision>;
  applicableWhen?: (situation: Situation) => boolean;
};
```

### createAction(action)

```ts
function createAction(action: Action): Action

type Action = {
  name: string;
  description: string;
  execute: (params: Record<string, unknown>, ctx: AgentContext) => Promise<ActionResult>;
  risk?: RiskLevel;
  schema?: SchemaValidator;
  rollback?: (params: Record<string, unknown>, ctx: AgentContext) => Promise<void>;
  dryRun?: (params: Record<string, unknown>, ctx: AgentContext) => Promise<string>;
  autonomy?: {
    mode: 'auto' | 'approval-required' | 'human-only';
    minConfidence?: number;
  };
};
```

### createEndpoint(endpoint)

```ts
function createEndpoint(endpoint: Endpoint): Endpoint

type Endpoint = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description?: string;
  handler: (ctx: RequestContext) => Awaitable<Response>;
  auth?: boolean;    // Default: true
  schema?: unknown;  // Zod schema for validation
};
```

---

## OODA loop

### runOODALoop(ctx, plugins)

Execute a single OODA loop iteration. Used internally by `agent.runLoop()`.

```ts
function runOODALoop(ctx: AgentContext, plugins: ZupPlugin[]): Promise<LoopResult>
```

### LoopResult

```ts
type LoopResult = {
  observations: Observation[];
  situation?: Situation;
  decision?: Decision;
  actionResults: ActionResult[];
  duration: number;    // Total loop time in ms
  success: boolean;
  error?: string;
};
```

---

## Data types

### Observe phase

```ts
type Observation = {
  source: string;
  timestamp: Date;
  type: ObservationType;         // 'metric' | 'log' | 'alert' | 'event' | 'state'
  severity?: ObservationSeverity; // 'info' | 'warning' | 'error' | 'critical'
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type ObserverRegistration = {
  id: string;
  observer: Observer;
};
```

### Orient phase

```ts
type SituationAssessment = {
  source: string;
  findings: string[];
  contributingFactor?: string;
  impactAssessment?: string;
  confidence: number;            // 0-1
};

type Anomaly = {
  type: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedResources?: string[];
};

type Correlation = {
  observations: string[];        // observation source names
  description: string;
  confidence: number;            // 0-1
};

type Situation = {
  summary: string;
  assessments: SituationAssessment[];
  anomalies: Anomaly[];
  correlations: Correlation[];
  priority: Priority;            // 'low' | 'medium' | 'high' | 'critical'
  confidence: number;            // 0-1
};
```

### Decide phase

```ts
type Decision = {
  action: string;                // Action ID or 'no-op'
  params: Record<string, unknown>;
  rationale: string;
  alternatives?: Decision[];
  confidence: number;            // 0-1
  risk: RiskLevel;               // 'low' | 'medium' | 'high' | 'critical'
  requiresApproval: boolean;
  estimatedImpact?: string;
};
```

### Act phase

```ts
type ActionResult = {
  action: string;
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number;              // ms
  sideEffects?: string[];
  metrics?: Record<string, number>;
};

type SchemaValidator = {
  parse: (data: unknown) => Record<string, unknown>;
};
```

---

## State

### createStateStore(options?)

Create a state store with optional persistence.

```ts
function createStateStore(options?: {
  persistence?: {
    enabled: boolean;
    type: 'memory' | 'file' | 'database';
    config?: {
      path?: string;
      flushIntervalMs?: number;
      tableName?: string;
    };
  };
  logger?: Logger;
  sqlite?: SQLiteCapability;
}): StateStore

type StateStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  has(key: string): boolean;
};
```

---

## Database

### createSQLiteCapability(config?, logger?)

Create a SQLite database capability.

```ts
function createSQLiteCapability(
  config?: SQLiteConfig,
  logger?: Logger
): SQLiteCapability

type SQLiteConfig = {
  path?: string;           // Default: ':memory:'
  enableWAL?: boolean;     // Default: true
  enableVec?: boolean;     // Default: true
  vecExtensionPath?: string;
};
```

See [SQLite & Embeddings](/docs/integrations/sqlite/) for the full `SQLiteCapability` method reference.

### createEmbeddingCapability(config, logger?)

Create an embedding capability for vector search.

```ts
function createEmbeddingCapability(
  config: EmbeddingConfig,
  logger?: Logger
): EmbeddingCapability

type EmbeddingConfig = {
  provider: 'openai';
  apiKey: string;
  model?: string;          // Default: 'text-embedding-3-small'
  dimensions?: number;     // Default: 1536
};

type EmbeddingCapability = {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
};
```

---

## LLM

### createLLMProvider(config)

Create a raw LLM provider instance.

```ts
function createLLMProvider(config: LLMConfig): LLMProvider
```

### createLLMCapability(config)

Create an `LLMCapability` object (the same type that appears on `ctx.llm`).

```ts
function createLLMCapability(config: LLMConfig): LLMCapability
```

### createAnthropicProvider(options)

Create an Anthropic provider directly.

```ts
function createAnthropicProvider(options: {
  apiKey: string;
  model: string;
  baseURL?: string;
}): LLMProvider
```

### createOpenAIProvider(options)

Create an OpenAI provider directly. Also used for OpenAI-compatible APIs.

```ts
function createOpenAIProvider(options: {
  apiKey: string;
  model: string;
  baseURL?: string;
  organization?: string;
}): LLMProvider
```

See [LLM Providers](/docs/integrations/llm/) for usage patterns and the full type reference.

---

## API server

### createApiServer(ctx, options?)

Create the REST API server. Used internally by `agent.startApi()`.

```ts
function createApiServer(ctx: AgentContext, options?: ApiServerOptions): ApiServer

type ApiServerOptions = {
  port?: number;
  hostname?: string;
  basePath?: string;
  apiKeys?: string[];
  allowUnauthenticated?: boolean;
};

type ApiServer = {
  server: ReturnType<typeof Bun.serve>;
  route: (method: string, path: string, handler: RouteHandler, auth?: boolean) => void;
  stop: () => void;
};
```

### API helpers

Utility functions for building responses in custom endpoints:

```ts
function json(data: unknown, status?: number): Response
function error(message: string, status?: number): Response
function parseBody<T = unknown>(req: Request): Promise<T | null>

const responses: {
  ok: <T>(data: T) => Response;
  created: <T>(data: T) => Response;
  noContent: () => Response;
  badRequest: (message: string) => Response;
  unauthorized: (message?: string) => Response;
  forbidden: (message?: string) => Response;
  notFound: (message?: string) => Response;
  internalError: (message?: string) => Response;
};
```

---

## Runs

### createRun(ctx, input)

Create a new run in the state store.

```ts
function createRun(ctx: AgentContext, input: CreateRunInput): Run

type CreateRunInput = {
  title: string;
  description: string;
  priority?: RunPriority;            // Default: 'medium'
  context?: Record<string, unknown>;
  source?: string;                   // Default: 'api'
  callbackUrl?: string;
};
```

### getRun(ctx, runId)

Retrieve a run by ID. Returns `undefined` if not found.

```ts
function getRun(ctx: AgentContext, runId: string): Run | undefined
```

### listRuns(ctx, opts?)

List runs, optionally filtered by status and limited in count.

```ts
function listRuns(
  ctx: AgentContext,
  opts?: { status?: RunStatus; limit?: number }
): Run[]
```

### updateRunStatus(ctx, runId, status, result?)

Update a run's status and optionally attach a result.

```ts
function updateRunStatus(
  ctx: AgentContext,
  runId: string,
  status: RunStatus,
  result?: RunResult
): Run | undefined
```

### runToObservation(run)

Convert a run into an `Observation` for injection into the observe phase.

```ts
function runToObservation(run: Run): Observation
```

### buildRunResult(loopResult, run)

Build a `RunResult` from a completed loop iteration.

```ts
function buildRunResult(loopResult: LoopResult, run: Run): RunResult
```

### sendCallback(run)

POST the run's result to its `callbackUrl`, if one is set.

```ts
function sendCallback(run: Run): Promise<void>
```

### Run types

```ts
type RunStatus = 'pending' | 'investigating' | 'completed' | 'failed' | 'cancelled';
type RunPriority = 'low' | 'medium' | 'high' | 'critical';

type Run = {
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

type RunResult = {
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
```

---

## Common types

```ts
type Awaitable<T> = T | Promise<T>;

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type LoopPhase = 'observe' | 'orient' | 'decide' | 'act' | 'idle';
type ObservationType = 'metric' | 'log' | 'alert' | 'event' | 'state';
type ObservationSeverity = 'info' | 'warning' | 'error' | 'critical';
type Priority = 'low' | 'medium' | 'high' | 'critical';

interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

The `Logger` interface is compatible with `console`, Winston, Pino, and most logging libraries.

---

## Plugin types

```ts
type Endpoint = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description?: string;
  handler: (ctx: RequestContext) => Awaitable<Response>;
  auth?: boolean;
  schema?: unknown;
};

type Middleware = (
  req: Request,
  ctx: AgentContext,
  next: () => Promise<unknown>
) => Promise<unknown>;

type StateSchema = {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    default?: unknown;
  };
};

type RequestContext = {
  request: Request;
  params: Record<string, string>;
  context: AgentContext;
};

type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

type Route = {
  method: string;
  path: string;
  handler: RouteHandler;
  auth?: boolean;
};
```

---

## Using exports outside the plugin system

All factory functions work independently of the agent. You can use them in scripts, tests, or external tools:

```ts
import {
  createStateStore,
  createSQLiteCapability,
  createEmbeddingCapability,
  createLLMCapability,
} from 'zupdev';

// Standalone state store with file persistence
const state = createStateStore({
  persistence: { enabled: true, type: 'file', config: { path: './state.json' } },
});

state.set('counter', 42);
console.log(state.get('counter')); // 42

// Standalone SQLite
const sqlite = createSQLiteCapability({ path: './data.db' });
sqlite.createTable('app', 'logs', 'id INTEGER PRIMARY KEY, message TEXT');
sqlite.run('INSERT INTO app_logs (message) VALUES ($msg)', { msg: 'hello' });
sqlite.close();

// Standalone LLM
const llm = createLLMCapability({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
});

const result = await llm.generateText('What is 2 + 2?');
console.log(result.text);
```
