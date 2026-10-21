/**
 * The two databases a keeper test can stand up (#2450), each from the
 * migrations that really define it:
 *
 *   - SHARED (`env.DB`, `vaipakam-warm`) — every `apps/indexer/migrations`
 *     file, replayed as it is.
 *   - KEEPER (`env.KEEPER_DB`, `vaipakam-keeper-db`) — `apps/keeper/migrations`.
 *
 * Five of the keeper-private tables were first created by indexer migrations
 * that are applied and must never be edited (0041, 0043, 0044). A later
 * indexer migration drops them again (0064, #2560), so a plain replay of the
 * indexer directory is the shared database as it stands, holding none of
 * them, and a statement sent to the WRONG handle fails `no such table`. This
 * harness used to drop them itself, which modelled a retirement that had not
 * happened yet; `keeperPrivateD1.test.ts` now checks the replay holds none.
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

/** The shared database, from the indexer's migrations (see the header). */
export function createSharedD1(): SqliteD1 {
  return createSqliteD1(SHARED_MIGRATIONS);
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
