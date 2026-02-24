---
title: Core Concepts
description: The OODA loop and the plugin system.
---

# Core Concepts

## OODA Loop

Each loop iteration:

1. **Observe** — Collect data via observers (metrics, health checks, alerts).
2. **Orient** — Analyze observations via orienters (pattern detection, LLM analysis).
3. **Decide** — Choose actions via decision strategies.
4. **Act** — Execute remediation via actions.

## Plugins

Plugins provide capabilities at each phase. A plugin can register observers, orienters, decision strategies, actions, and API endpoints.

```ts
import { definePlugin, createObserver, createOrienter, createDecisionStrategy, createAction } from '@beepsdev/zup';

export const myPlugin = () => definePlugin({
  id: 'my-plugin',

  observers: {
    checkHealth: createObserver({
      name: 'health-check',
      observe: async () => [{
        source: 'my-plugin/health',
        timestamp: new Date(),
        type: 'state',
        severity: 'critical',
        data: { status: 'down' },
      }],
    }),
  },

  orienters: {
    analyze: createOrienter({
      name: 'analyze',
      orient: async () => ({
        source: 'my-plugin/analysis',
        findings: ['Service is down'],
        contributingFactor: 'Process crashed',
        confidence: 0.9,
      }),
    }),
  },

  decisionStrategies: {
    restart: createDecisionStrategy({
      name: 'restart-if-down',
      decide: async () => ({
        action: 'my-plugin:restart',
        params: { service: 'api' },
        rationale: 'Service is down',
        confidence: 0.85,
        risk: 'low',
        requiresApproval: false,
      }),
    }),
  },

  actions: {
    restart: createAction({
      name: 'restart',
      execute: async () => ({
        action: 'restart',
        success: true,
        duration: 1000,
      }),
    }),
  },
});
```
