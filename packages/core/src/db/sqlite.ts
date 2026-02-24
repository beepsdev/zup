/**
 * SQLite Database Infrastructure
 *
 * Provides a global SQLite database that plugins can use with namespacing.
 * Supports sqlite-vec extension for vector search when available.
 */

import { Database, type SQLQueryBindings, type Changes } from 'bun:sqlite';
import type { Logger } from '../types/common';

export type SQLiteConfig = {
  path?: string;
  enableWAL?: boolean;
  enableVec?: boolean;
  vecExtensionPath?: string;
};

export type SQLiteParams = Record<string, SQLQueryBindings>;

/**
 * Interface for Bun SQLite statements when using named parameters.
 * Bun's built-in types expect positional parameters, but in strict mode
 * we use named parameter objects. This interface models that usage pattern.
 */
interface NamedParamsStatement<T> {
  all(params?: SQLiteParams): T[];
  get(params?: SQLiteParams): T | null;
  run(params?: SQLiteParams): Changes;
}

/**
 * Helper to reinterpret Bun's Statement as a named-params statement.
 * This is the single point where we bridge Bun's positional-param types
 * to our named-param usage pattern (enabled by strict: true mode).
 */
const asNamedParamsStatement = <T>(stmt: unknown): NamedParamsStatement<T> => {
  if (
    typeof stmt !== 'object' ||
    stmt === null ||
    typeof (stmt as { all?: unknown }).all !== 'function'
  ) {
    throw new Error('Unexpected SQLite statement shape');
  }
  return stmt as NamedParamsStatement<T>;
};

export type SQLiteCapability = {
  db: Database;
  vecEnabled: boolean;

  getNamespacedTable: (pluginId: string, tableName: string) => string;

  createTable: (
    pluginId: string,
    tableName: string,
    schema: string
  ) => void;

  dropTable: (pluginId: string, tableName: string) => void;

  query: <T>(sql: string, params?: SQLiteParams) => T[];

  get: <T>(sql: string, params?: SQLiteParams) => T | undefined;

  run: (sql: string, params?: SQLiteParams) => { lastInsertRowid: number; changes: number };

  transaction: <T>(fn: () => T) => T;

  close: () => void;
};

const DEFAULT_CONFIG: SQLiteConfig = {
  path: ':memory:',
  enableWAL: true,
  enableVec: true,
};

export function createSQLiteCapability(
  config: SQLiteConfig = {},
  logger: Logger = console
): SQLiteCapability {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const db = new Database(mergedConfig.path, { create: true, strict: true });

  if (mergedConfig.enableWAL && mergedConfig.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  let vecEnabled = false;

  if (mergedConfig.enableVec) {
    try {
      if (mergedConfig.vecExtensionPath) {
        db.loadExtension(mergedConfig.vecExtensionPath);
        vecEnabled = true;
        logger.info('[sqlite] sqlite-vec extension loaded successfully');
      } else {
        try {
          db.loadExtension('vec0');
          vecEnabled = true;
          logger.info('[sqlite] sqlite-vec extension loaded from default path');
        } catch {
          try {
            db.loadExtension('sqlite-vec');
            vecEnabled = true;
            logger.info('[sqlite] sqlite-vec extension loaded');
          } catch {
            logger.warn('[sqlite] sqlite-vec extension not available, vector search disabled');
          }
        }
      }
    } catch (err) {
      logger.warn('[sqlite] Failed to load sqlite-vec extension:', err);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS _zup_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const getNamespacedTable = (pluginId: string, tableName: string): string => {
    const sanitizedPluginId = pluginId.replace(/[^a-zA-Z0-9_]/g, '_');
    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
    return `${sanitizedPluginId}_${sanitizedTableName}`;
  };

  const createTable = (
    pluginId: string,
    tableName: string,
    schema: string
  ): void => {
    const fullTableName = getNamespacedTable(pluginId, tableName);
    db.exec(`CREATE TABLE IF NOT EXISTS ${fullTableName} (${schema})`);

    db.run(
      `INSERT OR REPLACE INTO _zup_metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [`table:${fullTableName}`, JSON.stringify({ pluginId, tableName, createdAt: new Date().toISOString() })]
    );
  };

  const dropTable = (pluginId: string, tableName: string): void => {
    const fullTableName = getNamespacedTable(pluginId, tableName);
    db.exec(`DROP TABLE IF EXISTS ${fullTableName}`);
    db.run(`DELETE FROM _zup_metadata WHERE key = ?`, [`table:${fullTableName}`]);
  };

  const query = <T>(sql: string, params?: SQLiteParams): T[] => {
    const stmt = asNamedParamsStatement<T>(db.query(sql));
    return stmt.all(params);
  };

  const get = <T>(sql: string, params?: SQLiteParams): T | undefined => {
    const stmt = asNamedParamsStatement<T>(db.query(sql));
    const result = stmt.get(params);
    return result ?? undefined;
  };

  const run = (sql: string, params?: SQLiteParams): { lastInsertRowid: number; changes: number } => {
    const stmt = asNamedParamsStatement<unknown>(db.query(sql));
    const result = stmt.run(params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: result.changes,
    };
  };

  const transaction = <T>(fn: () => T): T => {
    const txn = db.transaction(fn);
    return txn();
  };

  const close = (): void => {
    db.close();
  };

  return {
    db,
    vecEnabled,
    getNamespacedTable,
    createTable,
    dropTable,
    query,
    get,
    run,
    transaction,
    close,
  };
}
