/**
 * The keeper's private D1 split (#2450), pinned.
 *
 * The keeper owns a second database, `vaipakam-keeper-db` (`KEEPER_DB`), for
 * operational state nothing outside this Worker reads. The split has three
 * ways to come apart quietly, and each cell below closes one:
 *
 *   1. The private schema drifts from the stated set — a table added to the
 *      keeper's migrations that something else reads, or one of the eight left
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
  'keeper_cutover',
  'keeper_ops_alert',
  'keeper_remit_ack',
  'keeper_remit_ack_frontier',
  'keeper_work_done',
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
  it('its migrations create exactly the eight keeper-private tables', () => {
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
import { CUTOVER_TABLES, copyVerdict, cutoverVerdict, fingerprintSql, parseFingerprint } from '../scripts/lib/keeper-cutover.mjs';

/** The five tables that began in the shared database (the grandfathered set). */
const MOVED = [...GRANDFATHERED_SHARED.values()].flat().sort();
type Fp = { n: number; at: number } | 'absent' | null;
const fps = (over: Record<string, Fp> = {}, base: Fp = { n: 3, at: 100 }): Record<string, Fp> =>
  Object.fromEntries(MOVED.map((t) => [t, t in over ? over[t] : base]));
const markerOf = (fp: Record<string, Fp>) => ({ completedAt: 1, fingerprint: fp });

describe('the cutover — one definition, every moved table (Codex #2489 r1)', () => {
  it('covers exactly the five tables that began in the shared database — all of them, not a sample', () => {
    expect(CUTOVER_TABLES.map((c: { table: string }) => c.table).sort()).toEqual(MOVED);
  });

  it("each fingerprint query runs on the keeper's real schema and moves on a write stamped now", () => {
    const h = createKeeperD1();
    for (const c of CUTOVER_TABLES as { table: string; at: string }[]) {
      const read = () => parseFingerprint(h.db.prepare(fingerprintSql(c)).all());
      expect(read(), `${c.table} empty`).toEqual({ n: 0, at: 0 });
    }
    h.db.prepare(`INSERT INTO keeper_remit_ack (base_chain_id, diamond, remit_id, mirror_chain_id, attempts, last_attempt_at, acked_at) VALUES (1, 'd', 1, 2, 1, 50, NULL)`).run();
    const ack = (CUTOVER_TABLES as { table: string; at: string }[]).find((c) => c.table === 'keeper_remit_ack')!;
    expect(parseFingerprint(h.db.prepare(fingerprintSql(ack)).all())).toEqual({ n: 1, at: 50 });
    h.db.prepare(`UPDATE keeper_remit_ack SET acked_at = 70`).run();
    expect(parseFingerprint(h.db.prepare(fingerprintSql(ack)).all()), 'an ack moves it').toEqual({ n: 1, at: 70 });
  });
});

describe('deploy-keeper — refuses to publish unless the cutover is recorded and still matches', () => {
  it('shared rows and no record refuses; a matching record passes (straddle)', () => {
    expect(cutoverVerdict(fps(), 'none').ok, 'copy not run').toBe(false);
    expect(cutoverVerdict(fps(), markerOf(fps())).ok, 'copy recorded').toBe(true);
  });

  it('ONE table out of step refuses — whichever it is, by count or by time', () => {
    for (const t of MOVED) {
      expect(cutoverVerdict(fps({ [t]: { n: 4, at: 100 } }), markerOf(fps())).ok, `${t} count`).toBe(false);
      expect(cutoverVerdict(fps({ [t]: { n: 3, at: 101 } }), markerOf(fps())).ok, `${t} written since`).toBe(false);
    }
  });

  it('nothing to move passes with no record: no shared rows, or the shared copies retired', () => {
    expect(cutoverVerdict(fps({}, { n: 0, at: 0 }), 'none').ok).toBe(true);
    expect(cutoverVerdict(fps({}, 'absent'), 'none').ok).toBe(true);
    // One copy retired, the others matching the record: still fine.
    expect(cutoverVerdict(fps({ [MOVED[0]]: 'absent' }), markerOf(fps())).ok).toBe(true);
  });

  it('anything unread refuses — never read as "no rows"', () => {
    expect(cutoverVerdict(fps({ [MOVED[2]]: null }), markerOf(fps())).ok).toBe(false);
    expect(cutoverVerdict(fps(), null).ok).toBe(false);
  });
});

describe('keeper-cutover — records nothing unless every table copied whole', () => {
  it('equal fingerprints on both sides pass; any one table short or newer fails', () => {
    expect(copyVerdict(fps(), fps()).ok).toBe(true);
    for (const t of MOVED) {
      expect(copyVerdict(fps(), fps({ [t]: { n: 2, at: 100 } })).ok, `${t} partial`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: { n: 3, at: 99 } })).ok, `${t} stale`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: null })).ok, `${t} unread`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: 'absent' })).ok, `${t} missing`).toBe(false);
    }
  });

  it('the script records only after the verify, and never exits from inside the copy', () => {
    const src = readFileSync(new URL('../scripts/keeper-cutover.mjs', import.meta.url), 'utf8');
    const insert = src.indexOf('INSERT INTO keeper_cutover');
    expect(insert, 'it records a marker').toBeGreaterThan(0);
    expect(src.indexOf('copyVerdict(after, priv)'), 'the verify precedes the record').toBeLessThan(insert);
    expect(src.indexOf('copyVerdict(before, after)'), 'so does the unchanged-source check').toBeLessThan(insert);
    // `process.exit` would skip the `finally` that removes the export files.
    expect(src.slice(src.indexOf('function run()')), 'no exit inside the copy').not.toMatch(/process\.exit\(/);
  });
});
