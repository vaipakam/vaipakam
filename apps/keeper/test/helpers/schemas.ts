/**
 * The two databases a keeper test can stand up (#2450), each from the
 * migrations that really define it:
 *
 *   - SHARED (`env.DB`, `vaipakam-warm`) — every `apps/indexer/migrations`
 *     file, THEN the keeper-private tables dropped.
 *   - KEEPER (`env.KEEPER_DB`, `vaipakam-keeper-db`) — `apps/keeper/migrations`.
 *
 * Why the drop. Five of the keeper-private tables were first created by
 * indexer migrations that are already applied and must never be edited, so a
 * plain replay of the indexer directory still contains them. A test built on
 * that replay would let a query sent to the WRONG handle succeed against a
 * stale copy — the exact mis-routing this split has to rule out. With the
 * tables dropped, the shared harness is the shared database as it stands once
 * the old copies are retired, and a mis-routed statement fails `no such table`.
 *
 * The keeper-private table set is DERIVED from the keeper's migrations rather
 * than listed here, so this file cannot disagree with the schema it models;
 * `keeperPrivateD1.test.ts` is where the expected set is stated and pinned.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createSqliteD1, type SqliteD1 } from './sqliteD1';
import type { Env } from '../../src/env';

export const INDEXER_MIGRATIONS_DIR = new URL('../../../indexer/migrations/', import.meta.url);
export const KEEPER_MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** `.sql` files in a migrations directory, in the order wrangler applies them. */
export function migrationFiles(dir: URL): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function readAll(dir: URL): string[] {
  return migrationFiles(dir).map((f) => readFileSync(new URL(f, dir), 'utf8'));
}

/** SQL with `--` line comments and block comments removed. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Every table a chunk of DDL creates, lowercased, in order of appearance. */
export function createdTables(sql: string): string[] {
  const out: string[] = [];
  for (const m of stripSqlComments(sql).matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi,
  )) {
    out.push(m[1].toLowerCase());
  }
  return out;
}

export const SHARED_MIGRATIONS = readAll(INDEXER_MIGRATIONS_DIR);
export const KEEPER_MIGRATIONS = readAll(KEEPER_MIGRATIONS_DIR);

/** The tables the keeper's own migrations create — its private database. */
export const KEEPER_PRIVATE_TABLES: readonly string[] = KEEPER_MIGRATIONS.flatMap(createdTables);

/** The shared database without the keeper-private tables (see the header). */
export function createSharedD1(): SqliteD1 {
  const h = createSqliteD1(SHARED_MIGRATIONS);
  for (const t of KEEPER_PRIVATE_TABLES) h.db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  return h;
}

/** The keeper's private database, from its own migrations only. */
export function createKeeperD1(): SqliteD1 {
  return createSqliteD1(KEEPER_MIGRATIONS);
}

/** Both handles as the code under test reads them, by binding name. */
export function bindings(shared: SqliteD1, keeper: SqliteD1): Pick<Env, 'DB' | 'KEEPER_DB'> {
  return { DB: shared.d1, KEEPER_DB: keeper.d1 } as unknown as Pick<Env, 'DB' | 'KEEPER_DB'>;
}

/** The table names present in a harness database. */
export function tablesIn(h: SqliteD1): Set<string> {
  return new Set(
    (h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
}
