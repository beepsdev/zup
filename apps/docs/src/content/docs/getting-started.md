---
title: Quickstart
description: Install Zup and run your first OODA loop in under five minutes.
---

## Install

```bash
bun add @beepsdev/zup
```

## Minimal agent

Create an agent with no plugins and run a single loop:

```ts
import { createAgent } from '@beepsdev/zup';

const agent = await createAgent({ name: 'my-agent' });
const result = await agent.runLoop();

console.log('Loop completed in', result.duration, 'ms');
console.log('Observations:', result.observations.length);
```

Without plugins there are no observers, so the loop completes instantly with zero observations. The next sections add real capabilities.

## Add HTTP monitoring

Install the http-monitor plugin to watch your endpoints:

```ts
import { createAgent } from '@beepsdev/zup';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';

const agent = await createAgent({
  name: 'my-agent',
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
        { id: 'web', name: 'Website', url: 'https://example.com' },
      ],
    }),
  ],
});

const result = await agent.runLoop();
console.log('Situation:', result.situation?.summary);
```

The http-monitor plugin registers an observer, an orienter, a decision strategy, and a restart action. A single `runLoop()` call runs through all four OODA phases.

## Add an LLM

Plugins like the investigation-orienter and historian require an LLM for deeper analysis. Configure one under the `llm` key:

```ts
const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
  ],
});
```

OpenAI and OpenAI-compatible providers are also supported:

```ts
llm: {
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
}
```

## Add SQLite for persistence

The historian plugin stores incident history in SQLite and uses it for RAG during future loops:

```ts
import { createAgent } from '@beepsdev/zup';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';
import { historianPlugin } from '@beepsdev/zup/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-20250514',
  },
  sqlite: { path: './zup.db' },
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
    historianPlugin({ minConfidence: 0.75 }),
  ],
});
```

## Start the REST API

Expose an HTTP API so external systems can trigger loops, submit runs, and approve actions:

```ts
const agent = await createAgent({
  name: 'my-agent',
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
  ],
});

const server = agent.startApi({
  port: 3000,
  apiKeys: ['my-secret-key'],
});

console.log(`API running on port ${server.port}`);
```

Test it:

```bash
# Health check (no auth)
curl http://localhost:3000/api/v0/health

# Trigger a loop
curl -X POST http://localhost:3000/api/v0/loop/trigger \
  -H "Authorization: Bearer my-secret-key"

# Submit a run
curl -X POST http://localhost:3000/api/v0/runs \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"title": "Check API latency", "description": "Users report slow responses"}'
```

## Run continuously

Set `mode: 'continuous'` and `loopInterval` when creating the agent. Then call `start()` with no arguments:

```ts
const agent = await createAgent({
  name: 'my-agent',
  mode: 'continuous',
  loopInterval: 30000, // 30 seconds
  plugins: [
    httpMonitor({
      endpoints: [
        { id: 'api', name: 'API', url: 'https://api.example.com/health' },
      ],
    }),
  ],
});

// start() reads mode and loopInterval from the agent config
const stop = await agent.start();

// Later, stop the loop:
// stop();
```

## Next steps

- [Core Concepts](/docs/core-concepts/) -- understand observers, orienters, strategies, and actions.
- [Agent Configuration](/docs/agent-config/) -- full reference for `createAgent()` options.
- [Plugin Overview](/docs/plugins/) -- catalog of all built-in plugins.
- [Writing a Plugin](/docs/plugins/authoring/) -- build your own observer, orienter, or action.
- [REST API](/docs/api/) -- full endpoint reference.
