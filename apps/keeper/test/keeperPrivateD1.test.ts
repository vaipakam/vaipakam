/**
 * The keeper's private D1 split (#2450), pinned.
 *
 * The keeper owns a second database, `vaipakam-keeper-db` (`KEEPER_DB`), for
 * operational state nothing outside this Worker reads. The split has three
 * ways to come apart quietly, and each cell below closes one:
 *
 *   1. The private schema drifts from the stated set — a table added to the
 *      keeper's migrations that something else reads, or one of the fifteen left
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
  'keeper_horizon_cursor',
  'keeper_horizon_entry',
  'keeper_ops_alert',
  'keeper_remit_ack',
  'keeper_remit_ack_frontier',
  'keeper_sanctions_screen',
  'keeper_sanctions_watch',
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
  it('its migrations create exactly the fifteen keeper-private tables', () => {
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

import { INDEXER_DEPLOYMENTS_SQL, INDEXER_DEPLOYMENT_SQL, indexerAdopted } from '../scripts/lib/indexer-adoption.mjs';

describe('the shared copies are retired (#2560)', () => {
  it('a later shared migration drops every table the grandfathered three created, so the real shared schema holds none of them', () => {
    const moved = [...GRANDFATHERED_SHARED.values()].flat();
    const dropped = new Set<string>();
    for (const file of migrationFiles(INDEXER_MIGRATIONS_DIR)) {
      if (GRANDFATHERED_SHARED.has(file)) continue;
      const sql = stripSqlComments(readFileSync(new URL(file, INDEXER_MIGRATIONS_DIR), 'utf8'));
      for (const t of moved) if (new RegExp(`\\bDROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${t}\\b`, 'i').test(sql)) dropped.add(t);
    }
    expect([...dropped].sort()).toEqual([...moved].sort());
    // Every shared migration applied in order, nothing removed by the harness.
    const shared = tablesIn(createSharedD1());
    for (const t of moved) expect(shared.has(t), `${t} is gone from the shared schema`).toBe(false);
  });
});

describe("the indexer's adoption — one rule for every reader (#2569 r1)", () => {
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
});
