---
title: State & Persistence
description: The StateStore interface, persistence backends, plugin key namespacing, and flush behavior.
---

The agent maintains a key-value `StateStore` that plugins, the approval queue, and the run manager use to persist data across loop iterations. By default state lives in memory and is lost when the process exits. You can configure file or database persistence to survive restarts.

## StateStore interface

```ts
type StateStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  has(key: string): boolean;
};
```

Every agent has exactly one `StateStore`, accessible as `ctx.state` inside plugins or via `agent.getState()` externally. Values can be any JSON-serializable type.

## Configuration

State persistence is configured through the `statePersistence` field on `AgentOptions`:

```ts
const agent = await createAgent({
  name: 'my-agent',
  statePersistence: {
    enabled: true,
    type: 'file',
    config: {
      path: './zup.state.json',
      flushIntervalMs: 1000,
    },
  },
});
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable state persistence. When `false`, state is always in-memory. |
| `type` | `'memory' \| 'file' \| 'database'` | `'memory'` | Storage backend. |
| `config.path` | `string` | `'zup.state.json'` | File path, relative to `process.cwd()`. Used when `type` is `'file'`. |
| `config.flushIntervalMs` | `number` | `1000` | Debounce interval in milliseconds before writing to disk or database. Set to `0` for immediate writes. |
| `config.tableName` | `string` | `'state'` | SQLite table name. Used when `type` is `'database'`. |

## Persistence backends

### Memory (default)

```ts
statePersistence: { enabled: false }
// or simply omit statePersistence entirely
```

State is stored in a plain `Map<string, unknown>`. Fast and sufficient for development or stateless deployments where the agent can reconstruct its state from external sources on startup. Data is lost when the process exits.

### File

```ts
statePersistence: {
  enabled: true,
  type: 'file',
  config: {
    path: './data/agent-state.json',
    flushIntervalMs: 2000,
  },
}
```

State is persisted to a JSON file. The file format is versioned:

```json
{
  "version": 1,
  "entries": [
    ["key1", "value1"],
    ["key2", { "nested": true }]
  ]
}
```

**Loading:** On startup, the file is read synchronously. If the file does not exist or is corrupt, the store starts empty and logs a warning.

**Flushing:** Writes are debounced by `flushIntervalMs` (default 1000ms). When multiple `set()` or `delete()` calls happen within the debounce window, only a single write occurs. The write process:

1. Takes a snapshot of the current `Map`.
2. Creates the parent directory if it does not exist.
3. Writes to a temporary file (`<path>.tmp`).
4. Atomically renames the temporary file to the final path.

The atomic rename prevents partial writes from corrupting the state file. If a write is already in flight when another flush is triggered, the new flush is queued and runs after the current write completes.

### Database

```ts
import { createAgent } from 'zupdev';

const agent = await createAgent({
  name: 'my-agent',
  sqlite: { path: './zup.db' },
  statePersistence: {
    enabled: true,
    type: 'database',
    config: {
      tableName: 'agent_state',
      flushIntervalMs: 500,
    },
  },
});
```

State is persisted to a SQLite table. This requires `sqlite` to be configured on the agent -- if SQLite is not available, the store logs a warning and falls back to in-memory storage.

The database table has this schema:

```sql
CREATE TABLE IF NOT EXISTS core_agent_state (
  state_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

The table name is namespaced as `core_<tableName>` using the same namespacing rules as plugin tables.

**Batching:** Like file persistence, database writes are debounced. Pending `set` and `delete` operations are collected and executed in a single SQLite transaction when the flush fires. This reduces write amplification when many keys change in quick succession.

**Error recovery:** If a transactional batch fails, the pending operations are preserved and retried on the next flush cycle. The in-memory `Map` always reflects the latest state, so reads are never stale even if a database write has not yet completed.

## How plugins use state

Plugins access state through `ctx.state`. By convention, plugins namespace their keys with their plugin ID to avoid collisions:

```ts
export const myPlugin = () => definePlugin({
  id: 'my-plugin',

  observers: {
    check: createObserver({
      name: 'my-check',
      description: 'Check with state tracking',
      observe: async (ctx) => {
        // Read previous value
        const lastCount = (ctx.state.get('my-plugin:checkCount') as number) ?? 0;

        // Update state
        ctx.state.set('my-plugin:checkCount', lastCount + 1);
        ctx.state.set('my-plugin:lastCheckTime', new Date().toISOString());

        return [{
          source: 'my-plugin/check',
          timestamp: new Date(),
          type: 'state',
          data: { checkCount: lastCount + 1 },
        }];
      },
    }),
  },
});
```

There is no enforced namespacing -- the convention is `pluginId:keyName`. Plugins can read each other's state if they know the key name, which is useful for cross-plugin coordination.

### Observer last-run timestamps

The OODA loop stores observer interval tracking data under the key `observer:lastRun` as a `Record<string, number>`. This is used by continuous mode to enforce per-observer intervals. The data persists across restarts when state persistence is enabled, so observers resume their timing from where they left off.

## How the run manager uses state

The run manager stores all run data in the state store under `run:*` keys:

| Key pattern | Value type | Description |
|---|---|---|
| `run:index` | `string[]` | Array of all run IDs, used for listing and iteration. |
| `run:<uuid>` | `Run` | The full run object, including status, result, and timestamps. |

This means runs survive process restarts when state persistence is enabled. When the agent starts back up, pending and investigating runs are available for the next loop iteration.

```ts
// The run manager reads/writes state internally:
ctx.state.set('run:abc-123', runObject);
ctx.state.set('run:index', ['abc-123', 'def-456']);
```

## Approval queue state

The approval queue also uses the state store:

| Key pattern | Value type | Description |
|---|---|---|
| `approvals:pending` | `ApprovalItem[]` | Array of pending approval items. |
| `approvals:history` | `ApprovalItem[]` | Array of resolved (approved, denied, expired) approvals. |

## Choosing a backend

| Backend | Durability | Performance | Use case |
|---|---|---|---|
| `memory` | None | Fastest | Development, stateless deploys, short-lived agents |
| `file` | Good | Fast reads, debounced writes | Single-instance production, simple deployments |
| `database` | Best | Fast reads, batched writes | Production with SQLite already configured, shared state with historian |

If you are already using SQLite for the historian plugin, `database` persistence makes sense -- it shares the same database file and avoids a separate state file.
