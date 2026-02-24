---
title: SQLite & Embeddings
description: SQLite database capability, plugin table namespacing, WAL mode, vector search with sqlite-vec, and the embedding provider for RAG.
---

Zup provides an optional SQLite database layer built on Bun's native `bun:sqlite`. Plugins use it to store structured data with automatic table namespacing. When combined with the `sqlite-vec` extension and an embedding provider, it enables vector similarity search for RAG workflows.

## Configuring SQLite

Set the `sqlite` field in your agent options:

```ts
import { createAgent } from '@beepsdev/zup';

const agent = await createAgent({
  name: 'my-agent',
  sqlite: {
    path: './zup.db',
    enableWAL: true,
    enableVec: true,
  },
  plugins: [...],
});
```

### SQLiteConfig reference

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `':memory:'` | Path to the SQLite database file. Use `':memory:'` for an in-memory database. |
| `enableWAL` | `boolean` | `true` | Enable Write-Ahead Logging. Only applies to file-based databases (not `:memory:`). |
| `enableVec` | `boolean` | `true` | Attempt to load the `sqlite-vec` extension for vector search. |
| `vecExtensionPath` | `string` | Auto-detected | Explicit path to the `sqlite-vec` shared library. When omitted, the system tries `vec0` and then `sqlite-vec` from the default extension search paths. |

The database is opened in `strict` mode with `create: true`. A metadata table (`_zup_metadata`) is automatically created to track which plugin tables exist.

## SQLiteCapability

When SQLite is configured, `ctx.sqlite` is populated with an `SQLiteCapability` object:

```ts
type SQLiteCapability = {
  db: Database;
  vecEnabled: boolean;

  getNamespacedTable(pluginId: string, tableName: string): string;
  createTable(pluginId: string, tableName: string, schema: string): void;
  dropTable(pluginId: string, tableName: string): void;
  query<T>(sql: string, params?: Record<string, unknown>): T[];
  get<T>(sql: string, params?: Record<string, unknown>): T | undefined;
  run(sql: string, params?: Record<string, unknown>): { lastInsertRowid: number; changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
};
```

### Method reference

**`getNamespacedTable(pluginId, tableName)`** -- Returns the full table name for a plugin, formatted as `pluginId_tableName`. Non-alphanumeric characters (except underscores) are replaced with `_`.

```ts
ctx.sqlite.getNamespacedTable('historian', 'incidents');
// => 'historian_incidents'

ctx.sqlite.getNamespacedTable('http-monitor', 'check_results');
// => 'http_monitor_check_results'
```

**`createTable(pluginId, tableName, schema)`** -- Creates a table with automatic namespacing and registers it in `_zup_metadata`. The `schema` parameter is the column definitions (everything inside the parentheses of `CREATE TABLE`):

```ts
ctx.sqlite.createTable('my-plugin', 'events', `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
`);
// Creates: my_plugin_events
```

Uses `CREATE TABLE IF NOT EXISTS`, so calling it multiple times is safe.

**`dropTable(pluginId, tableName)`** -- Drops a namespaced table and removes its metadata entry.

**`query<T>(sql, params?)`** -- Execute a query and return all matching rows. Uses named parameters with the `$param` or `:param` syntax:

```ts
const rows = ctx.sqlite.query<{ id: number; name: string }>(
  'SELECT id, name FROM my_plugin_events WHERE event_type = $type',
  { type: 'deployment' }
);
```

**`get<T>(sql, params?)`** -- Execute a query and return the first matching row, or `undefined` if none match.

```ts
const row = ctx.sqlite.get<{ count: number }>(
  'SELECT COUNT(*) as count FROM my_plugin_events'
);
```

**`run(sql, params?)`** -- Execute an INSERT, UPDATE, or DELETE and return the result:

```ts
const result = ctx.sqlite.run(
  'INSERT INTO my_plugin_events (event_type, payload) VALUES ($type, $payload)',
  { type: 'deployment', payload: '{"version": "1.2.3"}' }
);

console.log(result.lastInsertRowid); // The inserted row's ID
console.log(result.changes);         // Number of rows affected
```

**`transaction<T>(fn)`** -- Execute a function inside a SQLite transaction. If the function throws, the transaction is rolled back:

```ts
ctx.sqlite.transaction(() => {
  ctx.sqlite.run('INSERT INTO table_a ...', { ... });
  ctx.sqlite.run('INSERT INTO table_b ...', { ... });
  // Both inserts succeed or neither does
});
```

**`close()`** -- Close the database connection. Called automatically when the agent shuts down.

## Plugin table namespacing

Every plugin table is prefixed with the plugin ID to prevent name collisions. The naming convention is `pluginId_tableName`, with special characters sanitized to underscores:

| Plugin ID | Table name | Full table name |
|---|---|---|
| `historian` | `incidents` | `historian_incidents` |
| `http-monitor` | `check_results` | `http_monitor_check_results` |
| `core` | `state` | `core_state` |

The `_zup_metadata` table tracks all created tables with their plugin ID, table name, and creation timestamp. This metadata is used internally but can be queried for debugging:

```ts
const tables = ctx.sqlite.query<{ key: string; value: string }>(
  'SELECT key, value FROM _zup_metadata WHERE key LIKE $pattern',
  { pattern: 'table:%' }
);
```

## WAL mode

Write-Ahead Logging (`enableWAL: true`) is the default for file-based databases. WAL mode provides better concurrent read performance and does not block readers during writes. It is automatically skipped for in-memory databases where it has no effect.

WAL mode creates two additional files alongside the database: `<dbname>-wal` and `<dbname>-shm`. These are managed by SQLite and should not be deleted while the database is open.

## Vector search with sqlite-vec

The `sqlite-vec` extension adds vector similarity search to SQLite, enabling RAG (Retrieval-Augmented Generation) workflows. When `enableVec` is `true`, Zup attempts to load the extension at startup.

### Extension loading

The loading process tries multiple paths in order:

1. `vecExtensionPath` if explicitly provided.
2. `vec0` from the default extension search path.
3. `sqlite-vec` from the default extension search path.

If all attempts fail, `vecEnabled` is set to `false` and a warning is logged. The agent continues to work normally -- plugins that depend on vector search fall back to text-based search.

### Creating a vector table

Vector tables use SQLite's virtual table syntax:

```ts
if (ctx.sqlite.vecEnabled) {
  const tableName = ctx.sqlite.getNamespacedTable('my-plugin', 'embeddings');
  ctx.sqlite.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding float[1536]
    )
  `);
}
```

The `float[1536]` declaration sets the vector dimension. This must match the dimension of the embedding model you are using.

### Querying vectors

```ts
const results = ctx.sqlite.query<{ item_id: number; distance: number }>(
  `SELECT item_id, distance
   FROM my_plugin_embeddings
   WHERE embedding MATCH $query
   ORDER BY distance
   LIMIT $k`,
  {
    query: JSON.stringify(queryVector),
    k: 5,
  }
);
```

The `MATCH` clause performs a nearest-neighbor search. Results are ordered by distance (lower is more similar). To convert distance to a similarity score: `similarity = 1 - distance`.

## Embedding capability

The embedding capability generates vector representations of text for use with sqlite-vec. It currently supports OpenAI's embedding models.

### Configuration

```ts
import { createEmbeddingCapability } from '@beepsdev/zup';

const embedding = createEmbeddingCapability({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',    // Optional, this is the default
  dimensions: 1536,                    // Optional, this is the default
});
```

### EmbeddingConfig reference

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `'openai'` | -- | Embedding provider (currently only OpenAI). |
| `apiKey` | `string` | -- | OpenAI API key. |
| `model` | `string` | `'text-embedding-3-small'` | Embedding model name. |
| `dimensions` | `number` | `1536` | Output vector dimensions. Must match your vector table definition. |

### EmbeddingCapability methods

```ts
type EmbeddingCapability = {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
};
```

**`embed(text)`** -- Generate an embedding vector for a single text string. Returns a `number[]` of length `dimensions`.

**`embedBatch(texts)`** -- Generate embeddings for multiple texts in a single API call. More efficient than calling `embed()` in a loop.

**`dimensions`** -- The configured vector dimension, useful for creating matching vector tables.

## How the historian uses SQLite and embeddings

The `historian` plugin is the primary consumer of both SQLite and embeddings. It demonstrates the full RAG workflow:

1. **Storage (onLoopComplete):** After each loop with a successful, high-confidence action, the historian stores the incident summary, contributing factor, resolution, and full loop data in the `historian_incidents` table. If embeddings are configured, it also generates and stores a vector in the `historian_incident_embeddings` table.

2. **Retrieval (orient phase):** During the orient phase, the historian's orienter takes the current observations, generates an embedding, and performs a vector similarity search against past incidents. The most similar incidents are included in the `SituationAssessment` to give the agent historical context.

3. **Fallback:** When vector search is unavailable (no sqlite-vec or no embedding provider), the historian falls back to keyword-based text search using SQL `LIKE` clauses.

### Configuration

```ts
import { createAgent } from '@beepsdev/zup';
import { historianPlugin } from '@beepsdev/zup/plugins/historian';

const agent = await createAgent({
  name: 'my-agent',
  sqlite: { path: './zup.db', enableVec: true },
  plugins: [
    historianPlugin({
      minConfidence: 0.75,         // Only store incidents above this confidence
      includeHighRisk: false,      // Skip storing high/critical risk actions
      maxSimilarIncidents: 5,      // Max incidents returned during RAG
      embedding: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
      },
    }),
  ],
});
```

## Using SQLite directly

If you need SQLite outside of an agent context, you can create the capability directly:

```ts
import { createSQLiteCapability } from '@beepsdev/zup';

const sqlite = createSQLiteCapability({
  path: './my-database.db',
  enableWAL: true,
});

sqlite.createTable('my-app', 'users', `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE
`);

sqlite.run(
  'INSERT INTO my_app_users (name, email) VALUES ($name, $email)',
  { name: 'Alice', email: 'alice@example.com' }
);

const users = sqlite.query<{ id: number; name: string; email: string }>(
  'SELECT * FROM my_app_users'
);

sqlite.close();
```
