/**
 * State store with optional file persistence
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { StateStore } from '../types/index';
import type { Logger } from '../types/common';
import type { SQLiteCapability } from '../db';

type StatePersistenceConfig = {
  enabled: boolean;
  type: 'memory' | 'file' | 'database';
  config?: {
    path?: string;
    flushIntervalMs?: number;
    tableName?: string;
    [key: string]: unknown;
  };
};

type StateStoreOptions = {
  persistence?: StatePersistenceConfig;
  logger?: Logger;
  sqlite?: SQLiteCapability;
};

type PersistedState = {
  version: 1;
  entries: Array<[string, unknown]>;
};

const DEFAULT_STATE_PATH = 'zup.state.json';
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_TABLE_NAME = 'state';

function loadStateFromFile(filePath: string, logger: Logger): Map<string, unknown> {
  if (!existsSync(filePath)) {
    return new Map();
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && Array.isArray(parsed.entries)) {
      return new Map(parsed.entries);
    }
  } catch (err) {
    logger.warn(`[state] Failed to load persisted state from ${filePath}:`, err);
  }

  return new Map();
}

function serializeState(store: Map<string, unknown>): string {
  const payload: PersistedState = {
    version: 1,
    entries: Array.from(store.entries()),
  };
  return JSON.stringify(payload);
}

function ensureDatabaseTable(sqlite: SQLiteCapability, tableName: string): string {
  const fullTableName = sqlite.getNamespacedTable('core', tableName);
  sqlite.createTable('core', tableName, `
    state_key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  `);
  return fullTableName;
}

function loadStateFromDatabase(
  sqlite: SQLiteCapability,
  tableName: string,
  logger: Logger
): Map<string, unknown> {
  const store = new Map<string, unknown>();
  try {
    const rows = sqlite.query<{ state_key: string; value: string }>(
      `SELECT state_key, value FROM ${tableName}`
    );
    for (const row of rows) {
      try {
        store.set(row.state_key, JSON.parse(row.value));
      } catch (err) {
        logger.warn(`[state] Failed to parse persisted value for key "${row.state_key}":`, err);
      }
    }
  } catch (err) {
    logger.warn(`[state] Failed to load persisted state from ${tableName}:`, err);
  }

  return store;
}

export function createStateStore(options: StateStoreOptions = {}): StateStore {
  const logger = options.logger || console;
  const persistence = options.persistence;
  const sqlite = options.sqlite;

  let persistenceEnabled = false;
  let persistenceType: StatePersistenceConfig['type'] = 'memory';
  let filePath: string | undefined;
  let dbTableName: string | undefined;
  let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;

  if (persistence?.enabled) {
    if (persistence.type === 'file') {
      const configuredPath = persistence.config?.path;
      filePath = resolve(process.cwd(), configuredPath || DEFAULT_STATE_PATH);
      persistenceEnabled = true;
      persistenceType = 'file';
      if (typeof persistence.config?.flushIntervalMs === 'number') {
        flushIntervalMs = Math.max(0, persistence.config.flushIntervalMs);
      }
    } else if (persistence.type === 'database') {
      if (!sqlite) {
        logger.warn('[state] Database persistence requested but SQLite is not configured; falling back to in-memory state');
      } else {
        const configuredTable = persistence.config?.tableName;
        dbTableName = ensureDatabaseTable(sqlite, configuredTable || DEFAULT_TABLE_NAME);
        persistenceEnabled = true;
        persistenceType = 'database';
        if (typeof persistence.config?.flushIntervalMs === 'number') {
          flushIntervalMs = Math.max(0, persistence.config.flushIntervalMs);
        }
      }
    }
  }

  const store = persistenceEnabled && persistenceType === 'file' && filePath
    ? loadStateFromFile(filePath, logger)
    : persistenceEnabled && persistenceType === 'database' && sqlite && dbTableName
      ? loadStateFromDatabase(sqlite, dbTableName, logger)
      : new Map<string, unknown>();

  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let writeInFlight = false;
  let needsFlush = false;
  const pendingDbOps = new Map<string, { op: 'set' | 'delete'; value?: unknown }>();

  const flush = async () => {
    if (!persistenceEnabled) return;
    if (!dirty && pendingDbOps.size === 0) return;
    if (writeInFlight) {
      needsFlush = true;
      return;
    }

    writeInFlight = true;
    if (persistenceType === 'file' && filePath) {
      const snapshot = new Map(store);
      dirty = false;

      try {
        await mkdir(dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp`;
        await writeFile(tmpPath, serializeState(snapshot));
        await rename(tmpPath, filePath);
      } catch (err) {
        logger.error(`[state] Failed to persist state to ${filePath}:`, err);
      } finally {
        writeInFlight = false;
        if (needsFlush || dirty) {
          needsFlush = false;
          void flush();
        }
      }
      return;
    }

    if (persistenceType === 'database' && sqlite && dbTableName) {
      const ops = new Map(pendingDbOps);
      pendingDbOps.clear();
      dirty = false;

      try {
        sqlite.transaction(() => {
          for (const [key, op] of ops) {
            if (op.op === 'delete') {
              sqlite.run(
                `DELETE FROM ${dbTableName} WHERE state_key = :key`,
                { key }
              );
            } else {
              sqlite.run(
                `INSERT OR REPLACE INTO ${dbTableName} (state_key, value, updated_at)
                 VALUES (:key, :value, CURRENT_TIMESTAMP)`,
                { key, value: JSON.stringify(op.value) }
              );
            }
          }
        });
      } catch (err) {
        logger.error(`[state] Failed to persist state to ${dbTableName}:`, err);
        for (const [key, op] of ops) {
          pendingDbOps.set(key, op);
        }
        dirty = pendingDbOps.size > 0;
      } finally {
        writeInFlight = false;
        if (needsFlush || dirty || pendingDbOps.size > 0) {
          needsFlush = false;
          void flush();
        }
      }
      return;
    }

    writeInFlight = false;
  };

  const scheduleFlush = () => {
    if (!persistenceEnabled) return;
    dirty = true;
    if (flushIntervalMs === 0) {
      void flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
  };

  if (persistenceEnabled && persistenceType === 'file' && filePath) {
    logger.info(`[state] Persistence enabled (file: ${filePath})`);
  }
  if (persistenceEnabled && persistenceType === 'database' && dbTableName) {
    logger.info(`[state] Persistence enabled (database table: ${dbTableName})`);
  }

  return {
    get(key: string) {
      return store.get(key);
    },

    set(key: string, value: unknown) {
      store.set(key, value);
      if (persistenceEnabled && persistenceType === 'database') {
        pendingDbOps.set(key, { op: 'set', value });
      }
      scheduleFlush();
    },

    delete(key: string) {
      store.delete(key);
      if (persistenceEnabled && persistenceType === 'database') {
        pendingDbOps.set(key, { op: 'delete' });
      }
      scheduleFlush();
    },

    has(key: string) {
      return store.has(key);
    },
  };
}
