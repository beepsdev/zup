---
title: Historian
description: Store incident resolutions and recall similar past incidents using RAG-powered search.
---

The `historian` plugin stores successful incident resolutions in SQLite and retrieves similar past incidents during the Orient phase using RAG (Retrieval-Augmented Generation). When embeddings are configured, it uses vector similarity search via sqlite-vec. Without embeddings, it falls back to keyword-based text search.

As incidents are resolved, the historian accumulates a searchable record of what worked. Future loops can reference this history during the Orient phase to inform decisions.

## Installation

```ts
import { createAgent } from '@beepsdev/zup';
import { historianPlugin } from '@beepsdev/zup/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  sqlite: { path: './data/agent.db' },
  plugins: [
    historianPlugin({
      minConfidence: 0.75,
      maxSimilarIncidents: 5,
    }),
  ],
});
```

## Requirements

This plugin requires SQLite to be configured on the agent. Without SQLite, the plugin initializes but logs a warning and does nothing.

For vector search, you also need:
- sqlite-vec extension loaded (see [SQLite & Embeddings](/docs/integrations/sqlite/))
- An embedding configuration pointing to an OpenAI-compatible embeddings API

## Plugin options

| Field | Type | Default | Description |
|---|---|---|---|
| `minConfidence` | `number` | `0.75` | Minimum decision confidence required to store a resolution. Resolutions from low-confidence decisions are skipped. |
| `includeHighRisk` | `boolean` | `false` | Whether to store resolutions from high-risk or critical-risk actions. Disabled by default to avoid reinforcing risky patterns. |
| `maxSimilarIncidents` | `number` | `5` | Maximum number of similar incidents to return during RAG queries. |
| `embedding` | `EmbeddingConfig` | -- | Optional OpenAI-compatible embedding configuration for vector search. If not provided, text search is used instead. |

## How it works

### Storing resolutions

At the end of each OODA loop iteration (via the `onLoopComplete` hook), the historian evaluates whether the loop result should be stored. A resolution is stored only when all of these conditions are met:

1. A decision was made (not a no-op)
2. At least one action was executed successfully
3. The decision confidence meets the `minConfidence` threshold
4. The decision risk is not `high` or `critical` (unless `includeHighRisk` is enabled)

Each stored incident includes:
- A generated incident summary combining the situation, decision rationale, and resolution
- The contributing factor (if identified during orient)
- Full JSON snapshots of observations, situation, decision, and action results
- Agent ID and loop iteration number

### Retrieving similar incidents

During the Orient phase, the historian orienter summarizes all current observations into a query string and searches for similar past incidents.

**With embeddings (vector search):** The query text is embedded using the configured model, and sqlite-vec performs a nearest-neighbor search against stored incident embeddings. Similarity is computed as `1 - distance`.

**Without embeddings (text search):** Keywords are extracted from the query text (words longer than 3 characters, up to 10 keywords), and a `LIKE` search is performed against incident summaries. Similarity is approximated by the fraction of keywords that match.

### Context enrichment

When similar incidents are found, the orienter returns a `SituationAssessment` with:
- Findings listing each similar incident with its match percentage
- The contributing factor from the most similar incident (if available)
- Confidence based on the average similarity score (capped at 0.9)

This assessment is combined with other orienters' assessments to help the decide phase benefit from historical context.

## OODA phase contributions

### Orient: `historical-context`

Searches for similar past incidents and returns findings about historical matches.

- **Source:** `historian/similar-incidents`
- Returns `historian/no-db` if SQLite is unavailable
- Returns `historian/no-history` if no incidents have been stored yet
- Returns `historian/no-matches` if no similar incidents are found

### Hook: `onLoopComplete`

Evaluates each completed loop and stores qualifying resolutions to SQLite. If embeddings are configured, also stores the embedding vector for future vector search.

## Embedding configuration

To enable vector search, provide an `embedding` configuration:

```ts
historianPlugin({
  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    apiKey: process.env.OPENAI_API_KEY,
  },
}),
```

Vector search requires the sqlite-vec extension. If the extension is not available, the plugin falls back to text search and logs a warning.

## Full example

```ts
import { createAgent } from '@beepsdev/zup';
import { historianPlugin } from '@beepsdev/zup/plugins/historian';
import { httpMonitor } from '@beepsdev/zup/plugins/http-monitor';

const agent = await createAgent({
  name: 'infra-agent',
  mode: 'continuous',
  loopInterval: 30000,
  sqlite: {
    path: './data/agent.db',
    enableVec: true,
  },
  plugins: [
    httpMonitor({
      endpoints: [
        {
          id: 'api',
          name: 'API Server',
          url: 'https://api.example.com/health',
          restartStrategy: {
            type: 'command',
            command: 'systemctl restart api-server',
          },
        },
      ],
    }),
    historianPlugin({
      minConfidence: 0.8,
      includeHighRisk: false,
      maxSimilarIncidents: 3,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: process.env.OPENAI_API_KEY,
      },
    }),
  ],
});

await agent.start();
```

Here the historian stores resolutions from the http-monitor plugin whenever the agent successfully restarts a service. On future incidents, it retrieves similar past incidents during the orient phase -- so the agent can recognize patterns like "this service crashes every time after a deployment" or "the last three times this happened, a restart fixed it."
