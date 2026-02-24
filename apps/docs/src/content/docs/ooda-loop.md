---
title: The OODA Loop
description: Detailed walkthrough of each OODA phase, the data flow between them, plugin hooks, and internal mechanics.
---

The OODA loop is the core execution model in Zup. Every iteration cycles through four phases -- **Observe**, **Orient**, **Decide**, **Act** -- and then records the result.

## Loop lifecycle

Each call to `agent.runLoop()` (or each tick in continuous mode) executes `runOODALoop(ctx, plugins)` from `loop.ts`. Here is the high-level sequence:

```
increment iteration, set startTime
       |
purge expired approvals
       |
  onLoopStart hooks
       |
  +--OBSERVE--+
  |           |
  +--ORIENT---+
  |           |
  +--DECIDE---+
  |           |
  +---ACT-----+
       |
update investigating runs
       |
  onLoopComplete hooks
       |
push LoopResult to history
```

The loop phase is tracked on `ctx.loop.phase` and transitions through: `observe` -> `orient` -> `decide` -> `act` -> `idle`. This value is exposed via the `GET /loop/status` API endpoint, allowing external systems to know exactly what the agent is doing at any moment.

## Before the phases begin

Before entering the Observe phase, two things happen:

1. **Iteration counter** -- `ctx.loop.iteration` is incremented and `ctx.loop.startTime` is set to the current time.

2. **Approval purge** -- If `options.approvals.autoExpire` is enabled (the default), `purgeExpiredApprovals` runs against the state store. Any pending approval items whose `expiresAt` timestamp has passed are moved from the `pending` list to `history` with status `'expired'`. The TTL defaults to one hour (`3600000` ms) and is configurable via `options.approvals.ttlMs`.

3. **`onLoopStart` hooks** -- All plugins with an `onLoopStart` hook are called sequentially, receiving the `AgentContext`. This is the place for setup work like refreshing tokens or resetting per-loop counters.

## Phase 1: Observe

**Goal:** Collect raw signals from all registered data sources.

**Input:** `AgentContext`
**Output:** `Observation[]`

### What happens internally

```ts
// Simplified from loop.ts
const observations: Observation[] = [];
const enforceIntervals = ctx.options.mode === 'continuous';

for (const [observerId, observer] of ctx.capabilities.observers) {
  // Skip if interval hasn't elapsed (continuous mode only)
  if (enforceIntervals && observer.interval && observer.interval > 0) {
    const last = lastRun[observerId];
    if (typeof last === 'number' && now - last < observer.interval) {
      continue;
    }
  }

  const obs = await observer.observe(ctx);
  observations.push(...obs);
  lastRun[observerId] = now;
}
```

Key behaviors:

- **Observer intervals are only enforced in continuous mode.** In `manual` and `event-driven` modes, every observer runs on every iteration. In `continuous` mode, observers with an `interval` property are skipped if their interval has not yet elapsed since the last run.
- **Last-run timestamps** are stored in `ctx.state` under the key `observer:lastRun` as a `Record<string, number>`. This survives across loop iterations and even across restarts if state persistence is enabled.
- **Error isolation** -- If an observer throws, the error is logged and the loop continues with the remaining observers. One broken observer does not crash the entire loop.

### Run injection

After all observers have run, the loop checks for **pending runs** -- work items submitted via the REST API:

```ts
const pendingRuns = listRuns(ctx, { status: 'pending' });
for (const run of pendingRuns) {
  observations.push(runToObservation(run));
  updateRunStatus(ctx, run.id, 'investigating');
}
```

Each pending run is converted into an `Observation` with `type: 'alert'` and severity mapped from the run's priority. The run's status transitions from `'pending'` to `'investigating'`.

### `onObserve` hooks

After all observations (both from observers and runs) are collected, `onObserve` hooks fire. These hooks receive the full `Observation[]` array and the context. They can **inject additional observations** by returning `{ observations: [...] }`:

```ts
// In a plugin
onObserve: async (observations, ctx) => {
  // Enrich observations, deduplicate, or inject synthetic ones
  return {
    observations: [
      {
        source: 'my-plugin/enrichment',
        timestamp: new Date(),
        type: 'event',
        severity: 'info',
        data: { enriched: true },
      },
    ],
  };
},
```

### Observation type reference

```ts
type Observation = {
  source: string;           // e.g., 'http-monitor/health-check'
  timestamp: Date;
  type: ObservationType;    // 'metric' | 'log' | 'alert' | 'event' | 'state'
  severity?: ObservationSeverity;  // 'info' | 'warning' | 'error' | 'critical'
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};
```

## Phase 2: Orient

**Goal:** Analyze observations and build a picture of what is happening.

**Input:** `Observation[]`, `AgentContext`
**Output:** `Situation`

### What happens internally

Every registered orienter is called with the full observation array:

```ts
const assessments = [];

for (const [orienterId, orienter] of ctx.capabilities.orienters) {
  const assessment = await orienter.orient(observations, ctx);
  assessments.push(assessment);
}
```

The assessments are then merged into a `Situation` object:

```ts
let situation: Situation = {
  summary: assessments.map(a => a.findings.join('; ')).join(' | '),
  assessments,
  anomalies: [],
  correlations: [],
  priority: 'low',
  confidence: assessments.reduce((sum, a) => sum + a.confidence, 0)
              / assessments.length,
};
```

Key behaviors:

- **All orienters run** -- unlike decision strategies, there is no filtering. Every orienter sees every observation.
- **Summary** is auto-generated by joining all findings with `' | '` as a delimiter between assessments.
- **Confidence** is the arithmetic mean of all assessment confidence values.
- **Priority** starts at `'low'` and can be upgraded by `onOrient` hooks.
- If no orienters are registered, the situation summary defaults to `'No significant observations'` with confidence `0`.

### `onOrient` hooks

After the situation is assembled, `onOrient` hooks fire. These can **partially override the situation** by returning `{ situation: Partial<Situation> }`:

```ts
onOrient: async (situation, ctx) => {
  // Upgrade priority based on custom logic
  if (situation.confidence > 0.8 && situation.assessments.length > 2) {
    return { situation: { priority: 'high' } };
  }
},
```

The returned partial is spread over the existing situation, so you can override `priority`, `summary`, `anomalies`, or any other field without replacing the entire object.

### Situation type reference

```ts
type Situation = {
  summary: string;
  assessments: SituationAssessment[];
  anomalies: Anomaly[];
  correlations: Correlation[];
  priority: Priority;      // 'low' | 'medium' | 'high' | 'critical'
  confidence: number;       // 0-1
};

type SituationAssessment = {
  source: string;
  findings: string[];
  contributingFactor?: string;
  impactAssessment?: string;
  confidence: number;       // 0-1
};
```

## Phase 3: Decide

**Goal:** Choose an action to take based on the situation.

**Input:** `Situation`, `AgentContext`
**Output:** `Decision`

### Strategy selection

Decision strategies declare an optional `applicableWhen` predicate. The framework filters strategies and selects the **first applicable one**:

```ts
const applicableStrategies = Array.from(ctx.capabilities.decisionStrategies)
  .filter(([_, strategy]) => {
    if (strategy.applicableWhen) {
      return strategy.applicableWhen(situation);
    }
    return true;  // No predicate = always applicable
  });

if (applicableStrategies.length === 0) {
  return { action: 'no-op', ... };
}

const [strategyId, strategy] = applicableStrategies[0];
const decision = await strategy.decide(situation, ctx);
```

Important: **First applicable wins.** Plugin registration order determines priority. If two strategies both match, the one from the plugin registered first in the `plugins` array takes precedence.

If no strategies are applicable, a `no-op` decision is returned with zero confidence.

### `onDecide` hooks

After a decision is produced, `onDecide` hooks fire. These hooks have two special powers:

1. **Veto** -- Return `{ veto: true }` to replace the decision with a `no-op`:

```ts
onDecide: async (decision, ctx) => {
  // Block high-risk actions during business hours
  if (decision.risk === 'high' && isDuringBusinessHours()) {
    return { veto: true };
  }
},
```

2. **Modify** -- Return `{ decision: Partial<Decision> }` to adjust the decision:

```ts
onDecide: async (decision, ctx) => {
  // Force approval for medium-risk actions
  if (decision.risk === 'medium') {
    return { decision: { requiresApproval: true } };
  }
},
```

### Decision type reference

```ts
type Decision = {
  action: string;            // Action ID to execute (or 'no-op')
  params: Record<string, unknown>;
  rationale: string;
  alternatives?: Decision[];
  confidence: number;        // 0-1
  risk: RiskLevel;           // 'low' | 'medium' | 'high' | 'critical'
  requiresApproval: boolean;
  estimatedImpact?: string;
};
```

## Phase 4: Act

**Goal:** Execute the chosen action, or queue it for approval.

**Input:** `Decision`, `AgentContext`
**Output:** `ActionResult[]`

### No-op short circuit

If `decision.action === 'no-op'`, the Act phase returns immediately with an empty `ActionResult[]` array. No hooks fire.

### Approval gating

Before executing an action, the framework checks whether it requires approval. An action requires approval if **any** of these conditions are true:

| Condition | Source |
|---|---|
| `decision.requiresApproval === true` | Decision strategy or `onDecide` hook set it |
| `action.autonomy.mode === 'approval-required'` | Action definition |
| `action.autonomy.mode === 'human-only'` | Action definition |
| `decision.confidence < action.autonomy.minConfidence` | Confidence below threshold |

When approval is required, the action is **queued** rather than executed:

```ts
const approval = enqueueApproval(ctx.state, {
  decision,
  actionId: decision.action,
  actionName: action.name,
  params: decision.params,
  risk: action.risk,
  confidence: decision.confidence,
  autonomy: action.autonomy,
  loopIteration: ctx.loop.iteration,
  situationSummary: ctx.loop.situation?.summary,
}, ttlMs);
```

The resulting `ActionResult` has `success: false`, `error: 'Approval required'`, and the approval ID in `metrics.approvalId`.

### Action execution

When no approval is needed, the action is executed directly:

```ts
// Before execution
await executePluginHooks(plugins, 'onBeforeAct', action, params, ctx);

// Validate params against schema if defined
if (action.schema) {
  params = action.schema.parse(params);
}

// Execute
const result = await action.execute(params, ctx);

// After execution
await executePluginHooks(plugins, 'onAfterAct', result, ctx);
```

The `onBeforeAct` hook fires before execution and receives the action definition and parameters. The `onAfterAct` hook fires after, receiving the `ActionResult` -- regardless of whether the action succeeded or failed.

### ActionResult type reference

```ts
type ActionResult = {
  action: string;
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number;            // milliseconds
  sideEffects?: string[];
  metrics?: Record<string, number>;
};
```

## After the phases

### Updating investigating runs

If any runs had status `'investigating'`, the loop builds a `RunResult` from the `LoopResult` and transitions the run to `'completed'` or `'failed'`. If the run has a `callbackUrl`, a POST request is sent with the result.

### `onLoopComplete` hooks

All plugins with an `onLoopComplete` hook are called with the complete `LoopResult` and context. This is the place for logging summaries, sending notifications, or persisting metrics.

### History

The `LoopResult` is pushed to `ctx.history`, an in-memory array of all past loop results for this session. This is accessible via `agent.getHistory()`.

## LoopResult type reference

```ts
type LoopResult = {
  observations: Observation[];
  situation?: Situation;
  decision?: Decision;
  actionResults: ActionResult[];
  duration: number;     // Total loop time in ms
  success: boolean;
  error?: string;       // Set if the loop threw an error
};
```

## Error handling

If any phase throws an unhandled error, the loop catches it at the top level and returns a `LoopResult` with `success: false` and the error message. Partial results from phases that completed before the error are still included in the result. The loop phase is reset to `'idle'`.

## Data flow diagram

```
Observers ──> Observation[]
                   │
  Pending runs ──> │ (injected as observations)
                   │
  onObserve hooks ─┤ (can add more observations)
                   │
                   v
Orienters ──> SituationAssessment[] ──> Situation
                                           │
             onOrient hooks ───────────────┤ (can modify situation)
                                           │
                                           v
   applicableWhen filter ──> Strategy ──> Decision
                                           │
              onDecide hooks ──────────────┤ (can veto or modify)
                                           │
                                           v
                                  Approval check
                                    /         \
                              needs            does not
                              approval         need approval
                                |                    |
                          enqueueApproval     onBeforeAct
                                |              action.execute()
                                |              onAfterAct
                                v                    v
                            ActionResult[]   ActionResult[]
                                         \   /
                                          v v
                                      LoopResult
```

## Hook execution order

For a complete loop iteration, hooks fire in this order:

1. `onLoopStart(ctx)`
2. Observers run
3. `onObserve(observations, ctx)`
4. Orienters run
5. `onOrient(situation, ctx)`
6. Strategy runs
7. `onDecide(decision, ctx)`
8. `onBeforeAct(action, params, ctx)` -- only if action executes
9. `action.execute(params, ctx)`
10. `onAfterAct(result, ctx)` -- only if action executes
11. `onLoopComplete(loopResult, ctx)`

All hooks are called sequentially across plugins in registration order. Errors in hooks are logged but do not abort the loop.

## Continuous mode timing

When the agent runs in `continuous` mode, the loop executes on a timer at `loopInterval` intervals. Observer intervals are enforced per-observer:

```ts
// An observer with interval: 60000 in continuous mode with loopInterval: 10000
// The loop runs every 10 seconds, but this observer only runs once per minute

createObserver({
  name: 'expensive-check',
  interval: 60000,  // Only run every 60 seconds
  observe: async (ctx) => {
    // This won't run on every loop iteration
    return [...];
  },
});
```

In `manual` and `event-driven` modes, observer intervals are ignored -- every observer runs on every call to `runLoop()`.
