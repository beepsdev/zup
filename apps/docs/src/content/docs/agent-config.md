---
title: Agent Configuration
description: Full reference for createAgent() options.
---

The `createAgent(options)` function accepts an `AgentOptions` object. All fields are optional.

## Complete example

```ts
import { createAgent } from 'zupdev';
import { httpMonitor } from 'zupdev/plugins/http-monitor';
import { historianPlugin } from 'zupdev/plugins/historian';

const agent = await createAgent({
  // Identity
  id: 'sre-agent-prod',
  name: 'Production SRE',
  systemPrompt: 'You are an SRE agent monitoring production infrastructure.',

  // LLM
  llm: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  },

  // Loop
  mode: 'continuous',
  loopInterval: 30000,

  // SQLite
  sqlite: {
    path: './zup.db',
    enableWAL: true,
    enableVec: true,
  },

  // State persistence
  statePersistence: {
    enabled: true,
    type: 'database',
    config: {
      tableName: 'agent_state',
    },
  },

  // API
  api: {
    port: 3000,
    host: 'localhost',
    auth: {
      apiKeys: [
        { key: 'sk-prod-abc123', name: 'production' },
      ],
      allowUnauthenticated: false,
    },
  },

  // Approvals
  approvals: {
    autoExpire: true,
    ttlMs: 3600000,
  },

  // Plugins
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

## Reference

### Identity

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | Random UUID | Unique agent identifier. |
| `name` | `string` | `'Zup'` | Human-readable agent name. |
| `systemPrompt` | `string` | Default SRE prompt | System prompt passed to the LLM. |
| `logger` | `Logger` | `console` | Logger instance. Must implement `debug`, `info`, `warn`, `error`. |

### LLM

The `llm` field configures the language model. It is optional -- many plugins work without an LLM. Zup supports 16+ providers via the Vercel AI SDK.

```ts
// Anthropic
llm: {
  provider: 'anthropic',
  apiKey: string,
  model: string,
  baseURL?: string,
}

// OpenAI
llm: {
  provider: 'openai',
  apiKey: string,
  model: string,
  baseURL?: string,
  organization?: string,
}

// Google Gemini
llm: {
  provider: 'google',
  apiKey: string,
  model: string,
}

// Simple API-key providers (mistral, groq, xai, cohere, perplexity,
// togetherai, deepinfra, cerebras, openrouter)
llm: {
  provider: 'groq',      // or any of the above
  apiKey: string,
  model: string,
  baseURL?: string,
}

// Azure OpenAI
llm: {
  provider: 'azure',
  apiKey: string,
  model: string,
  resourceName: string,
  apiVersion?: string,
}

// Amazon Bedrock
llm: {
  provider: 'amazon-bedrock',
  model: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
}

// Google Vertex AI
llm: {
  provider: 'google-vertex',
  model: string,
  project: string,
  location: string,
}

// OpenAI-compatible (Ollama, vLLM, LiteLLM, etc.)
llm: {
  provider: 'openai-compatible',
  baseURL: string,
  apiKey: string,
  model: string,
}
```

See [LLM Providers](/docs/integrations/llm/) for detailed configuration for each provider.

### Loop

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `'manual' \| 'continuous' \| 'event-driven'` | `'manual'` | Agent operating mode. |
| `loopInterval` | `number` | `60000` | Milliseconds between loops in `continuous` mode. |

**Modes:**

- **manual** -- Call `agent.runLoop()` yourself. `start()` just logs readiness.
- **continuous** -- `start()` runs the loop on a timer at `loopInterval` intervals.
- **event-driven** -- `start()` logs readiness. Loops are triggered by external events (e.g., incoming runs via the API).

### SQLite

| Field | Type | Default | Description |
|---|---|---|---|
| `sqlite.path` | `string` | `':memory:'` | Path to the SQLite database file. |
| `sqlite.enableWAL` | `boolean` | `true` | Enable Write-Ahead Logging for better concurrent read performance. |
| `sqlite.enableVec` | `boolean` | `true` | Load the `sqlite-vec` extension for vector search. |
| `sqlite.vecExtensionPath` | `string` | Auto-detected | Path to the `sqlite-vec` shared library. |

### State persistence

| Field | Type | Default | Description |
|---|---|---|---|
| `statePersistence.enabled` | `boolean` | `false` | Enable state persistence. |
| `statePersistence.type` | `'memory' \| 'file' \| 'database'` | `'memory'` | Storage backend. |
| `statePersistence.config.path` | `string` | -- | File path when `type` is `'file'`. |
| `statePersistence.config.flushIntervalMs` | `number` | `1000` | Debounce interval for file flushes. |
| `statePersistence.config.tableName` | `string` | -- | Table name when `type` is `'database'`. |

### API

| Field | Type | Default | Description |
|---|---|---|---|
| `api.port` | `number` | `3000` | Server port. |
| `api.host` | `string` | `'localhost'` | Bind address. |
| `api.auth.apiKeys` | `Array<{ key, name, permissions? }>` | `[]` | API keys for Bearer token auth. |
| `api.auth.allowUnauthenticated` | `boolean` | `false` | Allow requests without an API key. |

The API server is started separately via `agent.startApi()`. You can pass overrides:

```ts
const server = agent.startApi({
  port: 8080,
  hostname: '0.0.0.0',
  apiKeys: ['override-key'],
  allowUnauthenticated: false,
});
```

### Approvals

| Field | Type | Default | Description |
|---|---|---|---|
| `approvals.autoExpire` | `boolean` | `true` | Automatically expire stale pending approvals. |
| `approvals.ttlMs` | `number` | `3600000` (1 hour) | Time-to-live for pending approvals in milliseconds. |

### Plugins

```ts
plugins: ZupPlugin[]
```

An array of initialized plugin objects. Plugins are loaded sequentially -- earlier plugins can modify context that later plugins see.

```ts
plugins: [
  httpMonitor({ endpoints: [...] }),
  historianPlugin({ minConfidence: 0.75 }),
  myCustomPlugin(),
]
```
