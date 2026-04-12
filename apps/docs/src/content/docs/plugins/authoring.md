---
title: Writing a Plugin
description: Step-by-step guide to building a custom Zup plugin.
---

This guide walks through building a plugin from scratch. By the end you will have a plugin with an observer, orienter, decision strategy, action, custom endpoint, and lifecycle hooks.

## Plugin structure

A plugin is a function that returns a `ZupPlugin` object via `definePlugin()`:

```ts
import { definePlugin } from 'zupdev';

export const myPlugin = (options?: { threshold?: number }) => definePlugin({
  id: 'my-plugin',

  // Lifecycle
  init: async (ctx) => { ... },

  // OODA phases
  observers: { ... },
  orienters: { ... },
  decisionStrategies: { ... },
  actions: { ... },

  // Hooks
  onLoopStart: async (ctx) => { ... },
  onObserve: async (observations, ctx) => { ... },
  onOrient: async (situation, ctx) => { ... },
  onDecide: async (decision, ctx) => { ... },
  onBeforeAct: async (action, params, ctx) => { ... },
  onAfterAct: async (result, ctx) => { ... },
  onLoopComplete: async (loopResult, ctx) => { ... },

  // REST API
  endpoints: { ... },
  middleware: [ ... ],

  // State schema declaration
  schema: { ... },
});
```

All fields except `id` are optional. Include only what your plugin needs.

## Step 1: Create the observer

Observers run during the Observe phase and return `Observation[]`:

```ts
import { definePlugin, createObserver } from 'zupdev';
import type { Observation, AgentContext } from 'zupdev';

export const diskMonitor = (options: { mountPath: string; thresholdPercent?: number }) => {
  const threshold = options.thresholdPercent ?? 90;

  return definePlugin({
    id: 'disk-monitor',

    observers: {
      checkDisk: createObserver({
        name: 'disk-usage',
        description: 'Check disk usage on a mount point',
        interval: 60000, // Only run once per 60s in continuous mode
        cost: 0,         // No API cost

        observe: async (ctx: AgentContext): Promise<Observation[]> => {
          // Your monitoring logic here
          const usage = await getDiskUsage(options.mountPath);

          return [{
            source: 'disk-monitor/usage',
            timestamp: new Date(),
            type: 'metric',
            severity: usage.percent > threshold ? 'critical' : 'info',
            data: {
              mountPath: options.mountPath,
              percent: usage.percent,
              availableGb: usage.availableGb,
              totalGb: usage.totalGb,
            },
          }];
        },
      }),
    },
  });
};
```

**Observer fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name. |
| `description` | `string` | Yes | What this observer monitors. |
| `observe` | `(ctx) => Promise<Observation[]>` | Yes | The monitoring function. |
| `interval` | `number` | No | Minimum ms between runs in continuous mode. |
| `cost` | `number` | No | Estimated API call cost (for budgeting). |

## Step 2: Create the orienter

Orienters analyze observations and return a `SituationAssessment`:

```ts
import { createOrienter } from 'zupdev';
import type { Observation, SituationAssessment } from 'zupdev';

// Inside your definePlugin call:
orienters: {
  analyzeDisk: createOrienter({
    name: 'disk-analysis',
    description: 'Analyze disk usage observations for problems',

    orient: async (observations: Observation[], ctx): Promise<SituationAssessment> => {
      const diskObs = observations.filter(o => o.source === 'disk-monitor/usage');
      const critical = diskObs.filter(o => o.severity === 'critical');

      if (critical.length === 0) {
        return {
          source: 'disk-monitor/analysis',
          findings: ['Disk usage is within normal bounds'],
          confidence: 1.0,
        };
      }

      return {
        source: 'disk-monitor/analysis',
        findings: critical.map(o =>
          `${o.data.mountPath}: ${o.data.percent}% used (${o.data.availableGb}GB free)`
        ),
        contributingFactor: 'Disk space running low',
        impactAssessment: 'Service may fail if disk fills up',
        confidence: 0.95,
      };
    },
  }),
},
```

**Orienter fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name. |
| `description` | `string` | Yes | What this orienter analyzes. |
| `orient` | `(observations, ctx) => Promise<SituationAssessment>` | Yes | The analysis function. |

## Step 3: Create the decision strategy

Decision strategies evaluate the situation and propose an action:

```ts
import { createDecisionStrategy } from 'zupdev';

// Inside your definePlugin call:
decisionStrategies: {
  cleanupDisk: createDecisionStrategy({
    name: 'cleanup-disk',
    description: 'Decide to clean up disk when usage is critical',

    applicableWhen: (situation) => {
      return situation.assessments.some(a =>
        a.source === 'disk-monitor/analysis' &&
        a.findings.some(f => f.includes('% used'))
      );
    },

    decide: async (situation, ctx) => {
      return {
        action: 'disk-monitor:cleanupDisk',
        params: { mountPath: '/data' },
        rationale: 'Disk usage exceeds threshold, cleaning up old files',
        confidence: 0.9,
        risk: 'low',
        requiresApproval: false,
      };
    },
  }),
},
```

**DecisionStrategy fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name. |
| `description` | `string` | Yes | What this strategy decides. |
| `decide` | `(situation, ctx) => Promise<Decision>` | Yes | The decision function. |
| `applicableWhen` | `(situation) => boolean` | No | Guard predicate. Strategy is skipped if this returns `false`. |

## Step 4: Create the action

Actions execute remediation. They can have parameter validation (Zod), autonomy controls, and rollback:

```ts
import { createAction } from 'zupdev';
import { z } from 'zod';

// Inside your definePlugin call:
actions: {
  cleanupDisk: createAction({
    name: 'cleanup-disk',
    description: 'Remove old log files and temp data',
    risk: 'low',

    autonomy: {
      mode: 'auto',           // 'auto' | 'approval-required' | 'human-only'
      minConfidence: 0.8,     // Below this, queue for approval
    },

    schema: z.object({
      mountPath: z.string(),
      maxAgeDays: z.number().optional().default(7),
    }),

    execute: async (params, ctx) => {
      const startTime = Date.now();

      const cleaned = await cleanOldFiles(params.mountPath, params.maxAgeDays);

      return {
        action: 'cleanup-disk',
        success: true,
        output: `Removed ${cleaned.count} files, freed ${cleaned.freedMb}MB`,
        duration: Date.now() - startTime,
        sideEffects: [`Deleted ${cleaned.count} files from ${params.mountPath}`],
        metrics: { filesDeleted: cleaned.count, mbFreed: cleaned.freedMb },
      };
    },

    dryRun: async (params, ctx) => {
      return `Would clean files older than ${params.maxAgeDays} days from ${params.mountPath}`;
    },

    rollback: async (params, ctx) => {
      ctx.logger.warn('Disk cleanup cannot be rolled back');
    },
  }),
},
```

**Action fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name. |
| `description` | `string` | Yes | What this action does. |
| `execute` | `(params, ctx) => Promise<ActionResult>` | Yes | The execution function. |
| `risk` | `'low' \| 'medium' \| 'high' \| 'critical'` | No | Risk level. |
| `schema` | Zod schema | No | Parameter validation. |
| `autonomy` | `{ mode, minConfidence? }` | No | Autonomy controls. |
| `rollback` | `(params, ctx) => Promise<void>` | No | Undo the action. |
| `dryRun` | `(params, ctx) => Promise<string>` | No | Preview what the action would do. |

**Autonomy modes:**

- `auto` -- Execute immediately if confidence meets `minConfidence`. Queue for approval if below.
- `approval-required` -- Always queue for human approval.
- `human-only` -- Always queue; intended for actions that should never be automated.

## Step 5: Add a custom endpoint

Plugins can register REST API endpoints:

```ts
import { createEndpoint, json } from 'zupdev';

// Inside your definePlugin call:
endpoints: {
  getDiskStatus: createEndpoint({
    method: 'GET',
    path: '/disk-monitor/status',
    description: 'Get current disk usage',
    auth: true,  // Require auth (default)

    handler: async (ctx) => {
      const usage = await getDiskUsage('/data');
      return json({ usage });
    },
  }),
},
```

Endpoints are mounted under `/api/v0` alongside the core routes.

## Step 6: Use the init hook

The `init` hook runs once when the plugin loads. Use it to set up state, validate config, or modify the agent context:

```ts
init: async (ctx) => {
  ctx.logger.info('[disk-monitor] Initializing');

  // Validate requirements
  if (!ctx.sqlite) {
    ctx.logger.warn('[disk-monitor] SQLite not available, history disabled');
  }

  // Add plugin-specific data to context
  return {
    context: {
      diskMonitor: {
        mountPath: options.mountPath,
        threshold,
        cleanupCount: 0,
      },
    },
    // Optionally merge additional agent options
    options: {
      // These are merged with defu (defaults merge)
    },
  };
},
```

Access plugin data from context in any phase:

```ts
observe: async (ctx) => {
  const pluginData = ctx.diskMonitor as { mountPath: string; threshold: number };
  // ...
},
```

## Step 7: Add lifecycle hooks

Hooks let you react to loop events without registering full observers or orienters:

```ts
// Runs before the observe phase
onLoopStart: async (ctx) => {
  ctx.logger.debug('[disk-monitor] Loop starting');
},

// Called after all observers run. Can inject additional observations.
onObserve: async (observations, ctx) => {
  return {
    observations: [/* additional observations */],
  };
},

// Called after orient. Can enrich the situation.
onOrient: async (situation, ctx) => {
  return {
    situation: { /* partial overrides merged into situation */ },
  };
},

// Called after decide. Can modify or veto the decision.
onDecide: async (decision, ctx) => {
  if (decision.risk === 'critical') {
    return { veto: true }; // Block the action
  }
  return {
    decision: { requiresApproval: true }, // Force approval
  };
},

// Called before an action executes
onBeforeAct: async (action, params, ctx) => {
  ctx.logger.info(`About to execute: ${action.name}`);
},

// Called after an action completes
onAfterAct: async (result, ctx) => {
  if (!result.success) {
    ctx.logger.error(`Action failed: ${result.error}`);
  }
},

// Called after the full loop completes
onLoopComplete: async (loopResult, ctx) => {
  ctx.logger.info(`Loop done in ${loopResult.duration}ms`);
},
```

## Step 8: Declare a state schema

If your plugin uses the agent's state store, declare the keys in the `schema` field for documentation and validation:

```ts
schema: {
  'disk-monitor:lastCleanup': {
    type: 'number',
    description: 'Timestamp of the last disk cleanup',
    default: 0,
  },
  'disk-monitor:totalFreed': {
    type: 'number',
    description: 'Total MB freed across all cleanups',
    default: 0,
  },
},
```

## Step 9: Bundle playbooks

Plugins can ship [playbooks](/docs/playbooks/) -- markdown that gets fed to the LLM during orient/decide:

```ts
// Inside your definePlugin call:
playbooks: [
  {
    id: 'disk-monitor/cleanup-patterns',
    name: 'Disk Cleanup Patterns',
    description: 'Known patterns for disk space issues',
    phases: ['orient'],
    priority: 0,
    content: `When disk usage spikes suddenly, check:
1. Log rotation -- logs that stopped rotating fill disks fast
2. Core dumps -- crashed processes may leave large core files
3. Temp files -- build artifacts or uploads not being cleaned up

If /tmp is full, it's almost always a process leak, not real data growth.`,
    source: 'plugin',
  },
],
```

Bundled playbooks are collected at plugin init and matched against observations like any other playbook.

## Putting it all together

```ts
import {
  definePlugin,
  createObserver,
  createOrienter,
  createDecisionStrategy,
  createAction,
  createEndpoint,
  json,
} from 'zupdev';
import type { AgentContext, Observation, SituationAssessment } from 'zupdev';
import { z } from 'zod';

export type DiskMonitorOptions = {
  mountPath: string;
  thresholdPercent?: number;
  cleanupMaxAgeDays?: number;
};

export const diskMonitor = (options: DiskMonitorOptions) => {
  const threshold = options.thresholdPercent ?? 90;
  const maxAgeDays = options.cleanupMaxAgeDays ?? 7;

  return definePlugin({
    id: 'disk-monitor',

    init: async (ctx: AgentContext) => {
      ctx.logger.info(`[disk-monitor] Watching ${options.mountPath} (threshold: ${threshold}%)`);
      return {
        context: {
          diskMonitor: { mountPath: options.mountPath, threshold },
        },
      };
    },

    observers: {
      checkDisk: createObserver({
        name: 'disk-usage',
        description: 'Check disk usage on a mount point',
        interval: 60000,
        observe: async (ctx) => {
          const usage = await getDiskUsage(options.mountPath);
          return [{
            source: 'disk-monitor/usage',
            timestamp: new Date(),
            type: 'metric',
            severity: usage.percent > threshold ? 'critical' : 'info',
            data: {
              mountPath: options.mountPath,
              percent: usage.percent,
              availableGb: usage.availableGb,
            },
          }];
        },
      }),
    },

    orienters: {
      analyzeDisk: createOrienter({
        name: 'disk-analysis',
        description: 'Analyze disk usage observations',
        orient: async (observations, ctx) => {
          const critical = observations.filter(
            o => o.source === 'disk-monitor/usage' && o.severity === 'critical'
          );
          return {
            source: 'disk-monitor/analysis',
            findings: critical.length > 0
              ? critical.map(o => `${o.data.mountPath}: ${o.data.percent}% used`)
              : ['Disk usage is normal'],
            contributingFactor: critical.length > 0 ? 'Disk space running low' : undefined,
            confidence: 0.95,
          };
        },
      }),
    },

    decisionStrategies: {
      cleanup: createDecisionStrategy({
        name: 'cleanup-disk',
        description: 'Clean up disk when usage is critical',
        applicableWhen: (situation) =>
          situation.assessments.some(a =>
            a.source === 'disk-monitor/analysis' &&
            a.findings.some(f => f.includes('% used'))
          ),
        decide: async (situation, ctx) => ({
          action: 'disk-monitor:cleanup',
          params: { mountPath: options.mountPath, maxAgeDays },
          rationale: 'Disk usage exceeds threshold',
          confidence: 0.9,
          risk: 'low',
          requiresApproval: false,
        }),
      }),
    },

    actions: {
      cleanup: createAction({
        name: 'cleanup-disk',
        description: 'Remove old files to free disk space',
        risk: 'low',
        autonomy: { mode: 'auto', minConfidence: 0.8 },
        schema: z.object({
          mountPath: z.string(),
          maxAgeDays: z.number().default(7),
        }),
        execute: async (params, ctx) => {
          const start = Date.now();
          const result = await cleanOldFiles(params.mountPath, params.maxAgeDays);
          return {
            action: 'cleanup-disk',
            success: true,
            output: `Freed ${result.freedMb}MB`,
            duration: Date.now() - start,
            metrics: { mbFreed: result.freedMb },
          };
        },
      }),
    },

    endpoints: {
      status: createEndpoint({
        method: 'GET',
        path: '/disk-monitor/status',
        handler: async (ctx) => {
          const usage = await getDiskUsage(options.mountPath);
          return json({ mountPath: options.mountPath, threshold, ...usage });
        },
      }),
    },

    onLoopComplete: async (result, ctx) => {
      const cleanups = result.actionResults.filter(r => r.action === 'cleanup-disk' && r.success);
      if (cleanups.length > 0) {
        ctx.logger.info(`[disk-monitor] Cleaned up disk, freed ${cleanups[0]?.metrics?.mbFreed}MB`);
      }
    },
  });
};
```

Use it:

```ts
import { createAgent } from 'zupdev';
import { diskMonitor } from './plugins/disk-monitor';

const agent = await createAgent({
  name: 'my-agent',
  mode: 'continuous',
  loopInterval: 60000,
  plugins: [
    diskMonitor({ mountPath: '/data', thresholdPercent: 85 }),
  ],
});

await agent.start();
```
