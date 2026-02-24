import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createSQLiteCapability, type SQLiteCapability } from './sqlite';

describe('SQLite Capability', () => {
  let sqlite: SQLiteCapability;

  beforeEach(() => {
    sqlite = createSQLiteCapability({ path: ':memory:' });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('createSQLiteCapability', () => {
    test('creates an in-memory database by default', () => {
      expect(sqlite.db).toBeDefined();
    });

    test('vecEnabled is false when extension not available', () => {
      expect(sqlite.vecEnabled).toBe(false);
    });
  });

  describe('getNamespacedTable', () => {
    test('creates namespaced table name', () => {
      const tableName = sqlite.getNamespacedTable('my-plugin', 'my-table');
      expect(tableName).toBe('my_plugin_my_table');
    });

    test('sanitizes special characters', () => {
      const tableName = sqlite.getNamespacedTable('plugin.name', 'table/name');
      expect(tableName).toBe('plugin_name_table_name');
    });
  });

  describe('createTable', () => {
    test('creates a table with the given schema', () => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY, name TEXT');

      const result = sqlite.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='test_users'`
      );
      expect(result?.name).toBe('test_users');
    });

    test('stores table metadata', () => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY');

      const metadata = sqlite.get<{ key: string; value: string }>(
        `SELECT * FROM _zup_metadata WHERE key = 'table:test_users'`
      );
      expect(metadata).toBeDefined();
      expect(metadata?.key).toBe('table:test_users');
    });
  });

  describe('dropTable', () => {
    test('drops an existing table', () => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY');
      sqlite.dropTable('test', 'users');

      const result = sqlite.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='test_users'`
      );
      expect(result).toBeUndefined();
    });

    test('removes table metadata', () => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY');
      sqlite.dropTable('test', 'users');

      const metadata = sqlite.get<{ key: string }>(
        `SELECT * FROM _zup_metadata WHERE key = 'table:test_users'`
      );
      expect(metadata).toBeUndefined();
    });
  });

  describe('query', () => {
    beforeEach(() => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY, name TEXT, age INTEGER');
      sqlite.run(
        `INSERT INTO test_users (name, age) VALUES ($name, $age)`,
        { name: 'Alice', age: 30 }
      );
      sqlite.run(
        `INSERT INTO test_users (name, age) VALUES ($name, $age)`,
        { name: 'Bob', age: 25 }
      );
    });

    test('returns all matching rows', () => {
      const results = sqlite.query<{ id: number; name: string; age: number }>(
        `SELECT * FROM test_users ORDER BY name`
      );
      expect(results).toHaveLength(2);
      expect(results[0]?.name).toBe('Alice');
      expect(results[1]?.name).toBe('Bob');
    });

    test('supports parameterized queries', () => {
      const results = sqlite.query<{ name: string }>(
        `SELECT name FROM test_users WHERE age > $minAge`,
        { minAge: 26 }
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('Alice');
    });
  });

  describe('get', () => {
    beforeEach(() => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY, name TEXT');
      sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Alice' });
    });

    test('returns the first matching row', () => {
      const result = sqlite.get<{ name: string }>(`SELECT name FROM test_users`);
      expect(result?.name).toBe('Alice');
    });

    test('returns undefined when no rows match', () => {
      const result = sqlite.get<{ name: string }>(
        `SELECT name FROM test_users WHERE name = $name`,
        { name: 'NonExistent' }
      );
      expect(result).toBeUndefined();
    });
  });

  describe('run', () => {
    beforeEach(() => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY, name TEXT');
    });

    test('returns lastInsertRowid for inserts', () => {
      const result = sqlite.run(
        `INSERT INTO test_users (name) VALUES ($name)`,
        { name: 'Alice' }
      );
      expect(result.lastInsertRowid).toBe(1);
    });

    test('returns changes count for updates', () => {
      sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Alice' });
      sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Bob' });

      const result = sqlite.run(
        `UPDATE test_users SET name = $newName WHERE name = $oldName`,
        { newName: 'Charlie', oldName: 'Alice' }
      );
      expect(result.changes).toBe(1);
    });
  });

  describe('transaction', () => {
    beforeEach(() => {
      sqlite.createTable('test', 'users', 'id INTEGER PRIMARY KEY, name TEXT');
    });

    test('commits successful transactions', () => {
      sqlite.transaction(() => {
        sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Alice' });
        sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Bob' });
      });

      const results = sqlite.query<{ name: string }>(`SELECT * FROM test_users`);
      expect(results).toHaveLength(2);
    });

    test('rolls back failed transactions', () => {
      try {
        sqlite.transaction(() => {
          sqlite.run(`INSERT INTO test_users (name) VALUES ($name)`, { name: 'Alice' });
          throw new Error('Simulated error');
        });
      } catch {
        // Expected error
      }

      const results = sqlite.query<{ name: string }>(`SELECT * FROM test_users`);
      expect(results).toHaveLength(0);
    });
  });
});
