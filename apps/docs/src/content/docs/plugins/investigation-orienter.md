---
title: Investigation Orienter
description: Run deep multi-turn LLM investigations during the Orient phase using tool calling.
---

The `investigation-orienter` plugin spawns a multi-turn LLM tool-calling loop during the Orient phase for deep incident investigation. Instead of a single-pass analysis, it gives the LLM access to investigation tools (log queries, metric lookups, health checks, event correlation) and lets it iteratively gather information before producing structured findings.

This is similar to how an on-call engineer would investigate an incident -- checking logs, querying metrics, correlating events -- except the LLM drives the investigation autonomously.

## Installation

```ts
import { createAgent } from 'zupdev';
import { investigationOrienter } from 'zupdev/plugins/investigation-orienter';
import { queryLogs, queryMetrics, checkHealth } from 'zupdev/plugins/investigation-orienter/tools';

const agent = await createAgent({
  name: 'my-agent',
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  plugins: [
    investigationOrienter({
      tools: [queryLogs, queryMetrics, checkHealth],
      maxTurns: 15,
      triggerSeverity: 'warning',
    }),
  ],
});
```

## Requirements

This plugin requires an LLM to be configured on the agent. The LLM drives the investigation loop by deciding which tools to call and interpreting the results.

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `tools` | `InvestigationTool[]` | -- | **Required.** Tools available for the LLM to call during investigation. At least one tool must be provided. |
| `maxTurns` | `number` | `15` | Maximum number of LLM tool-calling turns before the investigation is stopped. Prevents runaway investigations. |
| `systemPrompt` | `string` | -- | Custom system prompt for the investigation LLM. Overrides the default investigation prompt. |
| `triggerSeverity` | `ObservationSeverity` | `'warning'` | Minimum observation severity required to trigger an investigation. Observations below this threshold are skipped. |

## How it works

1. **Severity check:** The orienter scans all observations from the Observe phase. If none meet the `triggerSeverity` threshold, it returns a simple "no significant observations" assessment without invoking the LLM.

2. **Prompt construction:** When triggered, the plugin builds a prompt from the current observations, asking the LLM to determine root cause, impact, affected services, and recommended actions.

3. **Tool-calling loop:** The LLM enters a multi-turn loop where it can call any of the configured tools. Each tool call is executed and the result is fed back to the LLM. This continues until the LLM produces a final answer or `maxTurns` is reached.

4. **Assessment extraction:** The LLM's final findings are parsed into a `SituationAssessment` with extracted root cause (as `contributingFactor`) and impact assessment. If the investigation completed normally, confidence is set to `0.85`. If it was cut short by the turn limit, confidence drops to `0.6` and the assessment is marked incomplete.

## Investigation tools

Tools are the building blocks of an investigation. Each tool has a name, description, Zod parameter schema, and an async execute function.

### InvestigationTool type

```ts
type InvestigationTool = {
  name: string;
  description: string;
  parameters: z.ZodSchema<unknown>;
  execute: (params: unknown, ctx: AgentContext) => Promise<ToolResult>;
};
```

### ToolResult type

```ts
type ToolResult = {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
};
```

### InvestigationResult type

```ts
type InvestigationResult = {
  findings: string;
  turnsUsed: number;
  toolsUsed: string[];
  incomplete?: boolean;
};
```

### Creating custom tools

Use `createInvestigationTool` to define tools with type-safe parameters:

```ts
import { createInvestigationTool } from 'zupdev/plugins/investigation-orienter/tools';
import { z } from 'zod';

const queryLogs = createInvestigationTool({
  name: 'query_logs',
  description: 'Search logs for a service. Returns matching log entries.',
  parameters: z.object({
    service: z.string().describe('Service name to query logs for'),
    query: z.string().describe('Search query (supports regex)'),
    timeRange: z.string().optional().describe('Time range like "15m", "1h", "24h"'),
    limit: z.number().optional().describe('Max entries to return'),
  }),
  execute: async (params, ctx) => {
    // Integrate with your log provider (Datadog, Loki, CloudWatch, etc.)
    const logs = await myLogProvider.search(params);
    return {
      output: JSON.stringify(logs),
      metadata: { service: params.service, resultCount: logs.length },
    };
  },
});
```

### Reference tools

The plugin ships with reference tool implementations that demonstrate the tool pattern. These return placeholder data and should be replaced with integrations to your actual observability stack:

| Tool | Description |
|---|---|
| `queryLogs` | Search logs for a service |
| `queryMetrics` | Query metrics (error rate, latency, CPU) |
| `checkHealth` | Check health status of a service |
| `correlateEvents` | Find related events across services within a time window |
| `getRecentDeployments` | Get recent deployments for a service |
| `checkDatabaseStatus` | Check database health, connections, and query performance |

Import all reference tools as a bundle:

```ts
import { referenceTools } from 'zupdev/plugins/investigation-orienter/tools';
```

## OODA phase contributions

### Orient: `Deep Investigation`

When observations meet the severity threshold, spawns a multi-turn LLM investigation loop using configured tools.

- **Source:** `investigation-orienter`
- **Confidence:** `0.85` (complete) or `0.6` (incomplete / hit turn limit)
- Extracts `contributingFactor` from root cause mentions in findings
- Extracts `impactAssessment` from impact mentions in findings

## Full example

```ts
import { createAgent } from 'zupdev';
import { investigationOrienter } from 'zupdev/plugins/investigation-orienter';
import { httpMonitor } from 'zupdev/plugins/http-monitor';
import { createInvestigationTool } from 'zupdev/plugins/investigation-orienter/tools';
import { z } from 'zod';

// Define tools that integrate with your observability stack
const queryDatadogLogs = createInvestigationTool({
  name: 'query_logs',
  description: 'Search Datadog logs for a service',
  parameters: z.object({
    service: z.string(),
    query: z.string(),
    timeRange: z.string().optional(),
  }),
  execute: async (params, ctx) => {
    const response = await fetch('https://api.datadoghq.com/api/v2/logs/events/search', {
      method: 'POST',
      headers: {
        'DD-API-KEY': process.env.DD_API_KEY!,
        'DD-APPLICATION-KEY': process.env.DD_APP_KEY!,
      },
      body: JSON.stringify({
        filter: { query: `service:${params.service} ${params.query}` },
      }),
    });
    const data = await response.json();
    return { output: JSON.stringify(data.data?.slice(0, 20)) };
  },
});

const queryPrometheus = createInvestigationTool({
  name: 'query_metrics',
  description: 'Query Prometheus metrics',
  parameters: z.object({
    query: z.string().describe('PromQL query'),
    timeRange: z.string().optional(),
  }),
  execute: async (params, ctx) => {
    const response = await fetch(
      `${process.env.PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(params.query)}`
    );
    const data = await response.json();
    return { output: JSON.stringify(data.data?.result) };
  },
});

const agent = await createAgent({
  name: 'incident-investigator',
  mode: 'continuous',
  loopInterval: 30000,
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
    investigationOrienter({
      tools: [queryDatadogLogs, queryPrometheus],
      maxTurns: 10,
      triggerSeverity: 'warning',
    }),
  ],
});

await agent.start();
```

When the http-monitor detects a failing endpoint (severity `warning` or above), the investigation orienter activates. The LLM queries Datadog logs and Prometheus metrics iteratively to determine root cause and impact, then produces a structured assessment that feeds into the Decide phase.
