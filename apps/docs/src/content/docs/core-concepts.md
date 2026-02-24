---
title: Core Concepts
description: The OODA loop, plugin system, and agent lifecycle.
---

## The OODA loop

Every iteration follows four phases:

1. **Observe** -- Observers collect data: HTTP health checks, Kubernetes pod status, deployment activity, alerts. Each observer returns `Observation[]`.
2. **Orient** -- Orienters analyze the observations and produce `SituationAssessment` objects. The framework merges these into a `Situation` with a summary, anomalies, correlations, priority, and confidence score.
3. **Decide** -- Decision strategies evaluate the situation and propose an action. Strategies declare `applicableWhen` predicates so only relevant strategies run. The output is a `Decision` with an action ID, parameters, rationale, confidence, and risk level.
4. **Act** -- The chosen action executes. Actions can require approval (queued for a human), run automatically, or be skipped (`no-op`). Each action returns an `ActionResult` with success/failure, duration, and optional side effects.

See [The OODA Loop](/docs/ooda-loop/) for the deep dive.

## Plugins

Plugins are the extension mechanism. A plugin can contribute components to any phase:

| Component | Phase | Purpose |
|---|---|---|
| `observers` | Observe | Collect signals from your systems |
| `orienters` | Orient | Analyze observations into assessments |
| `decisionStrategies` | Decide | Propose actions based on the situation |
| `actions` | Act | Execute remediation or automation |
| `endpoints` | API | Add custom REST routes |

Plugins also have lifecycle hooks: `onLoopStart`, `onObserve`, `onOrient`, `onDecide`, `onBeforeAct`, `onAfterAct`, `onLoopComplete`.

A minimal plugin:

```ts
import { definePlugin, createObserver } from 'zupdev';

export const myPlugin = () => definePlugin({
  id: 'my-plugin',
  observers: {
    check: createObserver({
      name: 'my-check',
      description: 'Check something important',
      observe: async (ctx) => [{
        source: 'my-plugin/check',
        timestamp: new Date(),
        type: 'state',
        severity: 'info',
        data: { status: 'ok' },
      }],
    }),
  },
});
```

See [Plugin Overview](/docs/plugins/) for the full catalog and [Writing a Plugin](/docs/plugins/authoring/) for a step-by-step guide.

## Agent lifecycle

```ts
import { createAgent } from 'zupdev';

// 1. Create -- plugins are initialized, capabilities registered
const agent = await createAgent({ name: 'my-agent', plugins: [...] });

// 2. Run -- execute a single OODA loop
const result = await agent.runLoop();

// 3. Or start continuous mode
const stop = await agent.start();

// 4. Optionally start the REST API
const server = agent.startApi({ port: 3000 });
```

The agent exposes these methods:

| Method | Description |
|---|---|
| `runLoop()` | Execute one full OODA iteration. Returns `LoopResult`. |
| `executeAction(id, params)` | Run a specific action directly, bypassing the loop. |
| `start()` | Start the agent in the configured mode (`manual`, `continuous`, `event-driven`). |
| `startApi(options)` | Start the REST API server. |
| `getContext()` | Return the current `AgentContext`. |
| `getCapabilities()` | List registered observers, orienters, strategies, and actions. |
| `getHistory()` | Return past `LoopResult[]` from this session. |
| `getState()` | Return the `StateStore` for reading/writing agent state. |

## State and persistence

The agent maintains a key-value `StateStore` used by plugins and the approval queue. State can be persisted to memory (default), a JSON file, or a SQLite database.

See [State & Persistence](/docs/state/) for configuration details.

## Approvals

When an action's risk is high, its confidence is below a threshold, or its autonomy mode is `approval-required` or `human-only`, the action is queued for approval instead of executing. Pending approvals can be listed, approved, or denied via the REST API.

See [Approval Queue](/docs/approvals/) for details.

## Runs

External systems can submit work items called **runs** via the REST API. A run flows through the OODA loop and its results are returned via polling or webhook callback.

See [REST API](/docs/api/) for the runs endpoints.
