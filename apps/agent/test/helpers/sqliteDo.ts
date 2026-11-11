/**
 * A Durable Object's `ctx.storage.sql` and `transactionSync`, over Node's
 * built-in SQLite, so the #1722 Telegram store runs in the Node test runner
 * on a real SQL engine. Each statement runs on its own, as the object's
 * `exec` runs it; a transaction is a savepoint, so a throw rolls back every
 * write inside it.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlCursorLike, SqlLike, TxRunner } from '../../src/telegramState/store';

export interface SqliteDo {
  sql: SqlLike;
  tx: TxRunner;
  db: DatabaseSync;
}

export function sqliteDo(): SqliteDo {
  const db = new DatabaseSync(':memory:');
  const changes = db.prepare('SELECT changes() AS c');
  const sql: SqlLike = {
    exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
      const rows = db.prepare(query).all(...(bindings as never[])) as T[];
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query);
      const written = isWrite ? Number((changes.get() as { c: number }).c) : 0;
      return { toArray: () => rows, rowsWritten: written };
    },
  };
  let depth = 0;
  const tx: TxRunner = <T>(fn: () => T): T => {
    const name = `sp${depth++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      depth--;
    }
  };
  return { sql, tx, db };
}
