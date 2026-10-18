/**
 * The keeper's private D1 split (#2450), pinned.
 *
 * The keeper owns a second database, `vaipakam-keeper-db` (`KEEPER_DB`), for
 * operational state nothing outside this Worker reads. The split has three
 * ways to come apart quietly, and each cell below closes one:
 *
 *   1. The private schema drifts from the stated set — a table added to the
 *      keeper's migrations that something else reads, or one of the ten left
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
  'keeper_cutover_row',
  'keeper_deployment',
  'keeper_remit_ack',
  'keeper_remit_ack_frontier',
  'keeper_work_cursor',
  'keeper_work_open',
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
  it('its migrations create exactly the ten keeper-private tables', () => {
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
import {
  CUTOVER_TABLES,
  copyVerdict,
  cutoverVerdict,
  fingerprintFromReads,
  fingerprintSql,
  parseFingerprint,
  rowDigest,
  rowsSql,
  chainIds,
  seedVerdict,
  adoptionsDiffer,
} from '../scripts/lib/keeper-cutover.mjs';
import { INDEXER_DEPLOYMENTS_SQL, INDEXER_DEPLOYMENT_SQL, indexerAdopted } from '../scripts/lib/indexer-adoption.mjs';

/** The five tables that began in the shared database (the grandfathered set). */
const MOVED = [...GRANDFATHERED_SHARED.values()].flat().sort();
type Fp = { n: number; at: number; digest: string; rows: string[] } | 'absent' | null;
const D = 'd'.repeat(64);
const R3 = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const fps = (over: Record<string, Fp> = {}, base: Fp = { n: 3, at: 100, digest: D, rows: R3 }): Record<string, Fp> =>
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

  it('the digest moves on a change the count and time cannot see (same row count, same second) — #2497 r1', () => {
    const h = createKeeperD1();
    h.db.prepare(`INSERT INTO keeper_remit_ack (base_chain_id, diamond, remit_id, mirror_chain_id, attempts, last_attempt_at, acked_at) VALUES (1, 'd', 1, 2, 1, 50, NULL)`).run();
    const ack = (CUTOVER_TABLES as { table: string; at: string }[]).find((c) => c.table === 'keeper_remit_ack')!;
    const read = () => fingerprintFromReads(h.db.prepare(fingerprintSql(ack)).all(), h.db.prepare(rowsSql(ack)).all());
    const before = read();
    h.db.prepare(`UPDATE keeper_remit_ack SET attempts = 2`).run(); // a retry inside the same second
    const after = read();
    expect(after?.n).toBe(before?.n);
    expect(after?.at).toBe(before?.at);
    expect(after?.digest).not.toBe(before?.digest);
  });

  it('the digest ignores row and column order, and a short read is not a fingerprint', () => {
    expect(rowDigest([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe(rowDigest([{ b: 'y', a: 2 }, { b: 'x', a: 1 }]));
    expect(fingerprintFromReads([{ n: 2, at: 5 }], [{ a: 1 }]), 'two counted, one read').toBeNull();
    expect(fingerprintFromReads([{ n: 1, at: 5 }], null), 'rows unread').toBeNull();
  });
});

describe('deploy-keeper — refuses to publish unless the cutover is recorded and still matches', () => {
  it('shared rows and no record refuses; a matching record passes (straddle)', () => {
    expect(cutoverVerdict(fps(), 'none').ok, 'copy not run').toBe(false);
    expect(cutoverVerdict(fps(), markerOf(fps())).ok, 'copy recorded').toBe(true);
  });

  it('ONE table with a row the copy did not take refuses — whichever table, inserted or rewritten (#2497 r10)', () => {
    for (const t of MOVED) {
      expect(cutoverVerdict(fps({ [t]: { n: 4, at: 101, digest: D, rows: [...R3, 'e'.repeat(64)] } }), markerOf(fps())).ok, `${t} row inserted`).toBe(false);
      expect(cutoverVerdict(fps({ [t]: { n: 3, at: 100, digest: D, rows: [R3[0], R3[1], 'e'.repeat(64)] } }), markerOf(fps())).ok, `${t} row rewritten in the same second`).toBe(false);
    }
  });

  it("a DELETION is not a keeper write: the indexer's deployment-epoch reset passes (#2497 r10)", () => {
    for (const t of MOVED) {
      expect(cutoverVerdict(fps({ [t]: { n: 1, at: 100, digest: 'f'.repeat(64), rows: [R3[2]] } }), markerOf(fps())).ok, `${t} rows removed`).toBe(true);
      expect(cutoverVerdict(fps({ [t]: { n: 0, at: 0, digest: 'f'.repeat(64), rows: [] } }), markerOf(fps())).ok, `${t} emptied`).toBe(true);
    }
  });

  it('nothing to move passes with no record: no shared rows, or the shared copies retired', () => {
    expect(cutoverVerdict(fps({}, { n: 0, at: 0, digest: D, rows: [] }), 'none').ok).toBe(true);
    expect(cutoverVerdict(fps({}, 'absent'), 'none').ok).toBe(true);
    // One copy retired, the others matching the record: still fine.
    expect(cutoverVerdict(fps({ [MOVED[0]]: 'absent' }), markerOf(fps())).ok).toBe(true);
  });

  it('anything unread refuses — never read as "no rows"', () => {
    expect(cutoverVerdict(fps({ [MOVED[2]]: null }), markerOf(fps())).ok).toBe(false);
    expect(cutoverVerdict(fps(), null).ok).toBe(false);
  });
});

describe("the indexer's adoption — one rule for the copy's seed and the keeper's epoch (#2569 r1)", () => {
  it('a record is an adoption only once reset_pending is zero; anything else is null, never a Diamond', () => {
    expect(indexerAdopted({ diamond: '0xABC', reset_pending: 0 })).toBe('0xabc');
    expect(indexerAdopted({ diamond: '0xABC', reset_pending: '0' })).toBe('0xabc');
    expect(indexerAdopted({ diamond: '0xABC', reset_pending: 1 }), 'mid-reset').toBeNull();
    expect(indexerAdopted({ diamond: '0xABC' }), 'flag unread').toBeNull();
    expect(indexerAdopted({ diamond: '', reset_pending: 0 })).toBeNull();
    expect(indexerAdopted(null)).toBeNull();
    expect(indexerAdopted(undefined)).toBeNull();
  });

  it('both readers select the flag they decide on, from the real shared schema', () => {
    const h = createSharedD1();
    h.db.prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (84532, ?, 1, 1, 1)').run('0xAbC');
    expect(indexerAdopted(h.db.prepare(INDEXER_DEPLOYMENT_SQL).get(84532))).toBeNull();
    h.db.prepare('UPDATE indexer_deployment SET reset_pending = 0').run();
    expect(indexerAdopted(h.db.prepare(INDEXER_DEPLOYMENT_SQL).get(84532))).toBe('0xabc');
    expect(h.db.prepare(INDEXER_DEPLOYMENTS_SQL).all()).toEqual([{ chain_id: 84532, diamond: '0xAbC', reset_pending: 0 }]);
  });

  it('a fingerprint carries the chains its rows are keyed by; a Diamond-keyed table carries none', () => {
    expect(chainIds([{ chain_id: 97, loan_id: 1 }, { chain_id: 84532, loan_id: 2 }, { chain_id: 97, loan_id: 3 }])).toEqual([97, 84532]);
    expect(chainIds([{ base_chain_id: 84532, diamond: 'd', remit_id: 1 }])).toEqual([]);
    expect(fingerprintFromReads([{ n: 1, at: 5 }], [{ chain_id: 97, loan_id: 1 }])?.chains).toEqual([97]);
  });

  it('the seed refuses a copied chain without a settled adoption, and seeds every settled one otherwise', () => {
    const copied = fps({ hf_band_state: { n: 3, at: 100, digest: D, rows: R3, chains: [84532, 97] } as Fp });
    const settled = [
      { chain_id: 84532, diamond: '0xA', reset_pending: 0 },
      { chain_id: 421614, diamond: '0xB', reset_pending: 0 },
    ];
    expect(seedVerdict(copied, settled), 'chain 97 has no record').toMatchObject({ ok: false, why: expect.stringMatching(/chain 97,? .*no settled indexer/) });
    expect(seedVerdict(copied, [...settled, { chain_id: 97, diamond: '0xC', reset_pending: 1 }]), 'mid-reset is not settled').toMatchObject({ ok: false });
    expect(seedVerdict(copied, [...settled, { chain_id: 97, diamond: '0xC', reset_pending: 0 }])).toEqual({
      ok: true,
      deployments: [
        { chain_id: 84532, diamond: '0xa' },
        { chain_id: 421614, diamond: '0xb' },
        { chain_id: 97, diamond: '0xc' },
      ],
    });
    expect(seedVerdict(copied, null), 'unread').toMatchObject({ ok: false, why: expect.stringMatching(/could not read/) });
    // No copied chains at all: nothing to require, everything settled is seeded.
    expect(seedVerdict(fps(), settled)).toMatchObject({ ok: true, deployments: expect.arrayContaining([{ chain_id: 84532, diamond: '0xa' }]) });
  });

  it('adoptionsDiffer — any change between the two reads refuses the record (#2569 r2)', () => {
    const a = [{ chain_id: 84532, diamond: '0xA', reset_pending: 0 }, { chain_id: 421614, diamond: '0xB', reset_pending: 0 }];
    expect(adoptionsDiffer(a, [...a].reverse()), 'order is not a difference').toBe(false);
    expect(adoptionsDiffer(a, [{ ...a[0], diamond: '0xa' }, a[1]]), 'nor is case').toBe(false);
    expect(adoptionsDiffer(a, [{ ...a[0], diamond: '0xC' }, a[1]]), 'a Diamond changed').toBe(true);
    expect(adoptionsDiffer(a, [{ ...a[0], reset_pending: 1 }, a[1]]), 'a reset began').toBe(true);
    expect(adoptionsDiffer(a, [a[0]]), 'a chain dropped').toBe(true);
    expect(adoptionsDiffer(a, null), 'unreadable after').toBe(true);
  });
});

describe('keeper-cutover — records nothing unless every table copied whole', () => {
  it('equal fingerprints on both sides pass; any one table short or newer fails', () => {
    expect(copyVerdict(fps(), fps()).ok).toBe(true);
    for (const t of MOVED) {
      expect(copyVerdict(fps(), fps({ [t]: { n: 2, at: 100, digest: D } })).ok, `${t} partial`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: { n: 3, at: 99, digest: D } })).ok, `${t} stale`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: { n: 3, at: 100, digest: 'e'.repeat(64) } })).ok, `${t} same second, different rows`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: null })).ok, `${t} unread`).toBe(false);
      expect(copyVerdict(fps(), fps({ [t]: 'absent' })).ok, `${t} missing`).toBe(false);
    }
  });

  it('the script records only after the verify, and never exits from inside the copy', () => {
    const src = readFileSync(new URL('../scripts/keeper-cutover.mjs', import.meta.url), 'utf8');
    // The record is written as one SQL file (recordSql), executed here.
    const insert = src.indexOf('recordSql(after');
    expect(insert, 'it records a marker').toBeGreaterThan(0);
    expect(src.indexOf('copyVerdict(after, priv)'), 'the verify precedes the record').toBeLessThan(insert);
    expect(src.indexOf('copyVerdict(before, after)'), 'so does the unchanged-source check').toBeLessThan(insert);
    // The indexer's adoptions are read BEFORE the export — the seed verdict is
    // decided from that read, so a copied chain without a settled adoption
    // refuses with nothing changed — and re-read AFTER the verify, before the
    // record, refusing if they moved (#2569 r1, r2).
    const firstRead = src.indexOf('query(SHARED_DB, INDEXER_DEPLOYMENTS_SQL)');
    const exportAt = src.indexOf("'export',");
    // ONE export of every table (#2569 r4): one database lock window, one snapshot.
    expect(src.slice(exportAt), 'every table in the one export').toContain("...CUTOVER_TABLES.map(({ table }) => `--table=${table}`)");
    expect(src.match(/'export'/g)?.length, 'exactly one export call').toBe(1);
    const secondRead = src.indexOf('query(SHARED_DB, INDEXER_DEPLOYMENTS_SQL)', firstRead + 1);
    expect(firstRead, 'adoptions read before the export').toBeGreaterThan(0);
    expect(firstRead).toBeLessThan(exportAt);
    expect(src.indexOf('seedVerdict(before, adoptionsBefore)'), 'seed verdict from that read, before the export').toBeLessThan(exportAt);
    expect(secondRead, 'and re-read after the verify').toBeGreaterThan(src.indexOf('copyVerdict(after, priv)'));
    expect(src.indexOf('adoptionsDiffer(adoptionsBefore, adoptionsAfter)'), 'compared before any record').toBeGreaterThan(secondRead);
    expect(src.indexOf('adoptionsDiffer(adoptionsBefore, adoptionsAfter)')).toBeLessThan(insert);
    // `process.exit` would skip the `finally` that removes the export files.
    expect(src.slice(src.indexOf('function run()')), 'no exit inside the copy').not.toMatch(/process\.exit\(/);
  });
});
