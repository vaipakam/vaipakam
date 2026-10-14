/**
 * The keeper's private D1 split (#2450), pinned.
 *
 * The keeper owns a second database, `vaipakam-keeper-db` (`KEEPER_DB`), for
 * operational state nothing outside this Worker reads. The split has three
 * ways to come apart quietly, and each cell below closes one:
 *
 *   1. The private schema drifts from the stated set — a table added to the
 *      keeper's migrations that something else reads, or one of the six left
 *      behind. The set is stated HERE, once, and compared to what the keeper's
 *      migrations actually create.
 *   2. A NEW shared (indexer) migration creates, alters or writes one of these
 *      tables again, splitting it across two databases with the keeper reading
 *      only one. Five of them were created by indexer migrations that are
 *      already applied and must never be edited (D1 keys applied migrations by
 *      filename), so those three files are grandfathered by NAME; any other
 *      indexer migration may only DROP one — the eventual cleanup of the old
 *      shared copies.
 *   3. The shared entry in wrangler.jsonc loses its explicit `migrations_dir`,
 *      after which a `wrangler d1 migrations apply vaipakam-warm` typed in
 *      apps/keeper/ would apply the keeper's private DDL to the shared
 *      database (wrangler defaults every entry to `./migrations`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INDEXER_MIGRATIONS_DIR,
  KEEPER_MIGRATIONS_DIR,
  KEEPER_PRIVATE_TABLES,
  createKeeperD1,
  createSharedD1,
  createdTables,
  migrationFiles,
  stripSqlComments,
  tablesIn,
} from './helpers/schemas';

/** The keeper-private tables — the one place the set is written down. */
const EXPECTED_PRIVATE = [
  'hf_band_state',
  'keeper_commitment_day',
  'keeper_commitment_scan',
  'keeper_ops_alert',
  'keeper_remit_ack',
  'keeper_remit_ack_frontier',
];

/**
 * Indexer migrations that created a keeper-private table BEFORE the split, and
 * are applied in production. Exact filenames, not prefixes: a prefix exemption
 * would also pass a new file that reused the number.
 */
const GRANDFATHERED_SHARED = new Map<string, string[]>([
  ['0041_hf_band_state.sql', ['hf_band_state']],
  ['0043_keeper_commitment_scan.sql', ['keeper_commitment_scan', 'keeper_commitment_day']],
  ['0044_keeper_remit_ack.sql', ['keeper_remit_ack_frontier', 'keeper_remit_ack']],
]);

describe("the keeper's private database", () => {
  it('its migrations create exactly the six keeper-private tables', () => {
    expect([...KEEPER_PRIVATE_TABLES].sort()).toEqual(EXPECTED_PRIVATE);
  });

  it('its migration filenames carry unique four-digit sequence numbers', () => {
    // The rule the indexer's check-migration-prefixes enforces for the shared
    // directory, for the same reason: D1 replays pending files in
    // lexicographic order on a fresh database.
    const files = migrationFiles(KEEPER_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f, f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('no shared migration outside the grandfathered three does anything to a keeper-private table but DROP it', () => {
    const offences: string[] = [];
    let grandfatheredSeen = 0;
    for (const file of migrationFiles(INDEXER_MIGRATIONS_DIR)) {
      const sql = readFileSync(new URL(file, INDEXER_MIGRATIONS_DIR), 'utf8');
      const grand = GRANDFATHERED_SHARED.get(file);
      if (grand) {
        // The exemption is for what these files are known to do — create
        // these tables — so confirm that is still what they hold.
        grandfatheredSeen += 1;
        expect(createdTables(sql).filter((t) => EXPECTED_PRIVATE.includes(t)), file).toEqual(grand);
        continue;
      }
      for (const stmt of stripSqlComments(sql).split(';')) {
        for (const t of EXPECTED_PRIVATE) {
          if (!new RegExp(`\\b${t}\\b`, 'i').test(stmt)) continue;
          // DROP of exactly this table is the one thing a later shared
          // migration may do with it: retiring the pre-split copy.
          if (new RegExp(`^\\s*DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?["\`[]?${t}["\`\\]]?\\s*$`, 'i').test(stmt)) {
            continue;
          }
          offences.push(`${file}: ${stmt.trim().split('\n')[0]}`);
        }
      }
    }
    expect(grandfatheredSeen, 'every grandfathered file is still present').toBe(GRANDFATHERED_SHARED.size);
    expect(offences).toEqual([]);
  });

  it('the test harnesses model the split: the keeper side has the private tables, the shared side has none', () => {
    const keeper = tablesIn(createKeeperD1());
    const shared = tablesIn(createSharedD1());
    for (const t of EXPECTED_PRIVATE) {
      expect(keeper.has(t), `keeper has ${t}`).toBe(true);
      expect(shared.has(t), `shared lacks ${t}`).toBe(false);
    }
    // Spot-check that the shared side is the real shared schema, not empty.
    for (const t of ['loans', 'notifications', 'indexer_cursor', 'keeper_commitment_reconciled']) {
      expect(shared.has(t), `shared has ${t}`).toBe(true);
    }
  });

  it("wrangler.jsonc binds both, and names the SHARED entry's migrations directory explicitly", () => {
    const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const entry = (binding: string) =>
      cfg.match(new RegExp(`\\{[^{}]*"binding"\\s*:\\s*"${binding}"[^{}]*\\}`))?.[0] ?? '';
    const shared = entry('DB');
    const keeper = entry('KEEPER_DB');
    expect(shared).toMatch(/"database_name"\s*:\s*"vaipakam-warm"/);
    expect(shared).toMatch(/"migrations_dir"\s*:\s*"\.\.\/indexer\/migrations"/);
    expect(keeper).toMatch(/"database_name"\s*:\s*"vaipakam-keeper-db"/);
    expect(keeper).toMatch(/"database_id"\s*:\s*"f809ca7a-bc4a-4b17-b5bd-f36c3a3e9095"/);
    expect(keeper).toMatch(/"migrations_dir"\s*:\s*"migrations"/);
  });
});

// ── the keeper's deploy: the private schema's ONE applier ─────────────────────
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM script, no type declarations.
import { admit as admitDeploy, PRIVATE_DB, requiredPrivateMigrations } from '../scripts/deploy-keeper.mjs';

describe('deploy-keeper — applies the private schema, verifies the shared one', () => {
  it('requires every migration file this build carries, by the name D1 records', () => {
    const files = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    expect(requiredPrivateMigrations()).toEqual(files);
    expect(PRIVATE_DB).toBe('vaipakam-keeper-db');
  });

  it('refuses ANY argument, whatever its spelling', () => {
    expect(admitDeploy([])).toEqual({ ok: true });
    for (const a of ['--dry-run', '--dry-run=true', '--version', '-v', '--env', 'staging']) {
      expect(admitDeploy([a]).ok).toBe(false);
    }
  });
});

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM script, no type declarations.
import { CUTOVER_SENTINELS, cutoverVerdict } from '../scripts/deploy-keeper.mjs';

describe('deploy-keeper — refuses to publish while the cutover copy is pending', () => {
  it('a sentinel with shared rows and no private rows refuses; the copy done, it passes (straddle)', () => {
    expect(cutoverVerdict('t', 3, 0).ok, 'copy not run').toBe(false);
    expect(cutoverVerdict('t', 3, 1).ok, 'copy run').toBe(true);
  });

  it('nothing to compare passes: no shared rows, or the shared copy retired', () => {
    expect(cutoverVerdict('t', 0, 0).ok).toBe(true);
    expect(cutoverVerdict('t', undefined, 0).ok).toBe(true);
  });

  it('an unreadable count refuses — it is never read as "no rows"', () => {
    expect(cutoverVerdict('t', null, 0).ok).toBe(false);
    expect(cutoverVerdict('t', 3, null).ok).toBe(false);
  });

  it('the sentinels are private tables the keeper never deletes from', () => {
    const src = readdirSync(new URL('../src/', import.meta.url))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    const schema = readFileSync(new URL('../migrations/0001_keeper_state.sql', import.meta.url), 'utf8');
    for (const t of CUTOVER_SENTINELS) {
      expect(schema, `${t} lives in the private schema`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
      expect(src, `${t} is never deleted from`).not.toMatch(new RegExp(`DELETE FROM ${t}\\b`));
    }
  });
});
