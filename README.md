<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/blocky-zup-inverted.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/blocky-zup.svg" />
    <img src="./assets/blocky-zup.svg" alt="Zup" width="520" />
  </picture>
</p>

<p align="center">
  <a href="https://zup.dev">zup.dev</a> &middot; <a href="https://zup.dev/docs">docs</a> &middot; <a href="https://github.com/beepsdev/zup/issues">issues</a>
</p>

Zup is an open source reliability agent that continuously runs the OODA loop (Observe, Orient, Decide, Act) on your production systems.

Zup observes signals across your stack, correlates them with current state and past incidents, decides on the safest response, and acts (automatically or with human approval) to keep systems up.

## Install

```bash
bun install
```

## Usage

```typescript
import { createAgent } from 'zupdev';
import { httpMonitor } from 'zupdev/plugins/http-monitor';
import { historianPlugin } from 'zupdev/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  mode: 'continuous',   // 'manual' (default) | 'continuous' | 'event-driven'
  loopInterval: 30000,  // ms between loops in continuous mode
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6',
  },
  sqlite: { path: './zup.db' },
  plugins: [
    httpMonitor({
      endpoints: [{ id: 'api', name: 'API', url: 'https://api.example.com/health' }],
    }),
    historianPlugin({ minConfidence: 0.75 }),
  ],
});

// Run single loop
const result = await agent.runLoop();
// Note: observer intervals are enforced only in continuous mode.

// Or run continuously (uses mode/loopInterval from createAgent)
await agent.start();

// Graceful shutdown: stops the loop, API servers, and flushes state
await agent.stop();
```

## Core Concepts

### OODA Loop

Each loop iteration:

1. **Observe** - Collect data via observers (metrics, health checks, alerts)
2. **Orient** - Analyze observations via orienters (pattern detection, LLM analysis)
3. **Decide** - Choose action via decision strategies
4. **Act** - Execute remediation via actions

### Playbooks

Playbooks are markdown files containing runbooks, incident learnings, and system-specific context that anyone on the team can write. They are currently consumed by the `investigation-orienter` plugin: during the Orient phase, playbooks matching the current observations are appended to the investigation system prompt. (They do not yet influence the Decide phase, and have no effect unless an orienter that reads them — like `investigation-orienter` — is installed.)

```typescript
const agent = await createAgent({
  playbooksDir: './playbooks',
  plugins: [
    investigationOrienter({ tools: [...] }),
  ],
});
```

A playbook file (`playbooks/high-error-rate.md`):

```markdown
---
name: High Error Rate
description: Handling sustained high error rates
trigger:
  severity: warning
  keywords: [error rate, 5xx]
---

When error rates spike after a recent deployment:
1. Check if a rollback is safer than debugging
2. If < 10 minutes since deploy, prefer rollback
3. The /health endpoint returns 200 even when degraded -- check the response body
```

Playbooks are matched against observations and appended to the investigation system prompt. See the [Playbooks docs](https://zup.dev/docs/playbooks/) for details.

### Plugins

Plugins provide capabilities at each phase:

```typescript
import { definePlugin, createObserver, createOrienter, createDecisionStrategy, createAction } from 'zupdev';
import { z } from 'zod';

export const myPlugin = () => definePlugin({
  id: 'my-plugin',

  observers: {
    checkHealth: createObserver({
      name: 'health-check',
      description: 'Check service health',
      observe: async (ctx) => [{
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
      description: 'Analyze health observations',
      orient: async (observations, ctx) => ({
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
      description: 'Restart the service when it is down',
      applicableWhen: (situation) => situation.priority === 'critical',
      decide: async (situation, ctx) => ({
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
      description: 'Restart a service',
      risk: 'low',
      schema: z.object({ service: z.string() }),
      execute: async (params, ctx) => ({
        action: 'restart',
        success: true,
        duration: 1000,
      }),
    }),
  },
});
```

## Built-in Plugins

Available plugins in this repo:
- `http-monitor` - Monitor HTTP endpoints, analyze failure patterns, and optionally restart services.
- `cloud-run` - Observe Google Cloud Run services and rollouts with optional auto-rollback.
- `fly-machines` - Observe Fly.io machines and detect deployments via instance/image changes.
- `vercel-deploys` - Poll Vercel deployments with git metadata for incident correlation.
- `github-activity` - Track commits and merged PRs (plus changed files) for correlation.
- `kubernetes` - Monitor cluster health and (optionally) restart/scale/delete pods or fetch logs.
- `historian` - Store successful incident resolutions in SQLite and retrieve similar incidents.
- `investigation-orienter` - Run a tool-calling investigation loop during Orient on severe signals.
- `example` (reference) - `packages/core/src/plugins/example.ts` demonstrates full plugin wiring.

### http-monitor

Health check monitoring with automatic restarts.

```typescript
import { httpMonitor } from 'zupdev/plugins/http-monitor';

httpMonitor({
  endpoints: [{
    id: 'api',
    name: 'API Server',
    url: 'https://api.example.com/health',
    expectedStatus: 200,
    timeout: 5000,
    failureThreshold: 3,
    cooldownPeriod: 300000,
    restartStrategy: {
      type: 'http',
      url: 'https://api.example.com/restart',
      method: 'POST',
    },
  }],
});
```

### cloud-run

Monitor Cloud Run services and rollouts with optional auto-rollback.

```typescript
import { cloudRun } from 'zupdev/plugins/cloud-run';

cloudRun({
  projects: [
    {
      projectId: 'my-project',
      regions: ['us-central1'],
    },
  ],
  readOnly: true,
  autoRollback: false,
  autoRollbackMinReadyMinutes: 5,
  includeLogs: false,
  includeMetrics: false,
});
```

### fly-machines

Monitor Fly.io machines and detect deployments via instance/image changes. Observe-only: this plugin provides no restart/scale/manage actions.

```typescript
import { flyMachines } from 'zupdev/plugins/fly-machines';

flyMachines({
  token: process.env.FLY_API_TOKEN,
  apps: [{
    name: 'my-app',
    serviceName: 'api',
    regions: ['iad', 'lax'],
  }],
});
```

### vercel-deploys

Monitor Vercel deployments.

```typescript
import { vercelDeploys } from 'zupdev/plugins/vercel-deploys';

vercelDeploys({
  token: process.env.VERCEL_TOKEN,
  projects: [{
    id: 'prj_xxx',
    serviceName: 'web',
    environments: ['production'],
  }],
});
```

### github-activity

Monitor GitHub repository activity: commits and merged PRs, including changed files, for incident correlation. (Issues and deployments are not tracked.)

```typescript
import { githubActivity } from 'zupdev/plugins/github-activity';

githubActivity({
  token: process.env.GITHUB_TOKEN,
  repos: [{
    owner: 'my-org',
    repo: 'my-app',
    serviceName: 'api',
  }],
});
```

### historian

Store incident resolutions and use them as RAG context for future incidents.

```typescript
import { historianPlugin } from 'zupdev/plugins/historian';

historianPlugin({
  minConfidence: 0.75,        // Only store high-confidence resolutions
  includeHighRisk: false,     // Exclude high-risk actions from history
  maxSimilarIncidents: 5,     // Number of similar incidents to retrieve
  embedding: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
  },
});
```

Requires SQLite configured on the agent. When sqlite-vec extension is available, uses vector search; otherwise falls back to keyword matching.

### kubernetes

Monitor Kubernetes cluster health and optionally perform write operations.

```typescript
import { kubernetes } from 'zupdev/plugins/kubernetes';

kubernetes({
  clusterName: 'prod-cluster',
  namespaces: ['default', 'production'],
  readOnly: true, // Set false to enable restart/scale/delete actions
});
```

### investigation-orienter

Run a deep, tool-calling investigation loop during the Orient phase.

```typescript
import { investigationOrienter, type InvestigationTool } from 'zupdev/plugins/investigation-orienter';

const tools: InvestigationTool[] = [
  // Provide your own tools (logs, metrics, deploys, etc.)
];

investigationOrienter({
  tools,
  triggerSeverity: 'warning',
});
```

The tools exported from `zupdev/plugins/investigation-orienter/tools` (`queryLogs`, `queryMetrics`, `checkHealth`, etc.) are reference implementations that return canned data. Use them as templates for the tool shape, but wire up your own integrations for production.

## LLM Integration

Supports 16+ providers via the Vercel AI SDK, including Anthropic, OpenAI, Google Gemini, Mistral, Groq, xAI, OpenRouter, Azure, Bedrock, and Vertex AI.

```typescript
const agent = await createAgent({
  llm: {
    provider: 'anthropic', // or 'openai', 'google', 'mistral', 'groq', etc.
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6',
  },
});

// Use in orienters
const assessment = await ctx.llm.generateStructured(prompt, schema);
```

## SQLite

Global SQLite with plugin namespacing:

```typescript
const agent = await createAgent({
  sqlite: {
    path: './zup.db',      // or ':memory:'
    enableWAL: true,
    enableVec: true,        // Enable sqlite-vec if available
  },
});

// In plugins
ctx.sqlite.createTable('my-plugin', 'events', 'id INTEGER PRIMARY KEY, data TEXT');
ctx.sqlite.run('INSERT INTO my_plugin_events (data) VALUES ($data)', { data: 'test' });
```

## API Server

```typescript
const agent = await createAgent({
  api: {
    port: 3000,
    auth: {
      apiKeys: [{ key: process.env.ZUP_API_TOKEN, name: 'default' }],
    },
  },
});

// The API server is started separately from the OODA loop
agent.startApi();
await agent.start();
```

Endpoints:
- `GET /api/v0/health` - Health check (no auth)
- `GET /api/v0/state` - Agent state
- `GET /api/v0/observations` - Recent observations
- `GET /api/v0/actions` - Available actions
- `POST /api/v0/actions/:id` - Execute action
- `GET /api/v0/approvals` - Pending approvals
- `POST /api/v0/approvals/:id/approve` - Approve queued action
- `POST /api/v0/approvals/:id/deny` - Deny queued action
- `POST /api/v0/loop/trigger` - Trigger OODA loop (pass `{ "async": true }` to get an immediate 202 and poll `/loop/status` instead of waiting)
- `GET /api/v0/loop/status` - Loop status

Plugins can register additional endpoints.

Approval queue defaults to auto-expire after 1 hour. Configure via:

```typescript
const agent = await createAgent({
  approvals: {
    autoExpire: true,
    ttlMs: 2 * 60 * 60 * 1000, // 2 hours
  },
});
```

## Project Structure

```
packages/
  core/src/
    agent.ts      # Agent lifecycle
    loop.ts       # OODA loop implementation
    plugin.ts     # Plugin system
    types/        # TypeScript types
    llm/          # LLM providers (via Vercel AI SDK)
    db/           # SQLite with namespacing
    embedding/    # Embedding capability
    api/          # HTTP API server
    playbook/     # Playbook loading and matching
    plugins/
      http-monitor/    # Health check monitoring
      cloud-run/       # Google Cloud Run integration
      fly-machines/    # Fly.io integration
      vercel-deploys/  # Vercel integration
      github-activity/ # GitHub integration
      kubernetes/      # Kubernetes integration
      historian/       # Incident memory with RAG
      investigation-orienter/ # Deep investigation orienter
```

## Development

```bash
bun test                       # Run tests
bun typecheck                  # Type check
bun run examples/demo.ts       # Run demo
bun run examples/llm-demo.ts   # Run LLM demo (requires API key)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
