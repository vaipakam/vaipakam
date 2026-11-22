import { describe, expect, it } from 'vitest';

import type { AssetCheck, IssuerReadClient } from '@vaipakam/lib/issuerPowerChecks';
import { createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';
import {
  addCandidate,
  ASSETS_PER_CHAIN,
  dueOrder,
  noteScan,
  RECHECK_AFTER_SEC,
  revertReason,
  runChain,
  scanDue,
  SCAN_INTERVAL_SEC,
  StoreMissing,
  type Candidate,
  type ChainDeps,
  type ChainReport,
} from '../src/issuerPowers';

const CHAIN = 84532;
const T0 = 1_800_000_000;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

let hashSeq = 0;

/** Insert a row, filling every NOT NULL column without a default. */
function seed(h: SqliteD1, table: string, row: Record<string, unknown>): void {
  const cols = h.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
  const full: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in row) full[c.name] = row[c.name];
    else if (c.notnull && c.dflt_value === null) full[c.name] = /INT/i.test(c.type) ? 0 : '';
  }
  if (table === 'signed_offers' && !('order_hash' in row)) full['order_hash'] = `0x${(++hashSeq).toString(16).padStart(64, '0')}`;
  const names = Object.keys(full);
  h.db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...(Object.values(full) as never[]));
}

/** The shared schema, with or without migration 0117's two tables. */
function store(withTables = true): SqliteD1 {
  const h = createSharedD1();
  if (!withTables) h.db.exec('DROP TABLE asset_issuer_finding; DROP TABLE asset_issuer_check;');
  return h;
}

const fakeResult = (complete = true): AssetCheck => ({
  kind: 'erc20',
  complete,
  detail: complete ? null : 'unknown: vault_transfer',
  findings: [
    { check: 'pause', result: 'found', evidence: 'the code has pause()' },
    { check: 'vault_transfer', result: complete ? 'not_found' : 'unknown', evidence: null },
  ],
});

function deps(h: SqliteD1, over: Partial<ChainDeps> = {}): ChainDeps & { checked: { asset: string; kind: string; holding: unknown }[] } {
  const checked: { asset: string; kind: string; holding: unknown }[] = [];
  return {
    chainId: CHAIN,
    db: h.d1 as unknown as D1Database,
    reader: {} as IssuerReadClient,
    blockNumber: 1234n,
    slots: async () => ({ rows: [], note: null }),
    vaultOf: async (u) => `0x${'f'.repeat(30)}${u.slice(-10)}`,
    nowSec: T0,
    deadlineMs: Date.now() + 60_000,
    check: async (_c, asset, kind, holding) => {
      checked.push({ asset, kind, holding });
      return fakeResult();
    },
    checked,
    ...over,
  };
}

describe('discovery and order', () => {
  it('finds every leg of active offers, active loans, unexpired signed offers and slots, once each', async () => {
    const h = store();
    seed(h, 'offers', { chain_id: CHAIN, offer_id: 1, status: 'active', offer_type: 0, creator: a(1), lending_asset: a(100), collateral_asset: a(101), asset_type: 0, collateral_asset_type: 1, collateral_token_id: '9' });
    seed(h, 'offers', { chain_id: CHAIN, offer_id: 2, status: 'cancelled', offer_type: 0, creator: a(1), lending_asset: a(102), collateral_asset: a(100) });
    seed(h, 'loans', { chain_id: CHAIN, loan_id: 1, offer_id: 1, status: 'active', lender: a(2), borrower: a(3), lending_asset: a(100), collateral_asset: a(103), asset_type: 0, collateral_asset_type: 0 });
    seed(h, 'signed_offers', { chain_id: CHAIN, status: 'active', lending_asset: a(104), collateral_asset: a(100), asset_type: 0, collateral_asset_type: 0, expires_at: 0, deadline: 0 });
    seed(h, 'signed_offers', { chain_id: CHAIN, status: 'active', lending_asset: a(105), collateral_asset: a(100), asset_type: 0, collateral_asset_type: 0, expires_at: T0 - 1, deadline: 0 });
    const d = deps(h, { slots: async () => ({ rows: [{ owner: a(4), lendingAsset: a(106), collateralAsset: a(100) }], note: null }) });
    const r = await runChain(d);
    expect(d.checked.map((c) => c.asset).sort()).toEqual([a(100), a(101), a(103), a(104), a(106)].sort());
    expect(r).toMatchObject({ assets: 5, due: 5, written: 5, complete: 5, failed: 0 });
    // The loan collateral is moved borrower vault -> lender vault.
    const coll = d.checked.find((c) => c.asset === a(103))!.holding as { holder: string; to: string };
    expect(coll.holder.endsWith(a(3).slice(-10))).toBe(true);
    expect(coll.to.endsWith(a(2).slice(-10))).toBe(true);
    // The collection collateral of a lender offer is held by no vault.
    expect(d.checked.find((c) => c.asset === a(101))!.holding).toBeNull();
    expect(d.checked.find((c) => c.asset === a(101))!.kind).toBe('erc721');
  });

  it('orders never checked, then older checker versions, then oldest due; skips fresh checks', () => {
    const cands: Candidate[] = [1, 2, 3, 4, 5].map((n) => ({ address: a(n), kind: 'erc20', held: null }));
    const stored = new Map([
      [a(1), { address: a(1), checkedAt: T0 - RECHECK_AFTER_SEC - 10, checkerVersion: '2' }],
      [a(2), { address: a(2), checkedAt: T0 - 5, checkerVersion: '1' }],
      [a(3), { address: a(3), checkedAt: T0 - 100, checkerVersion: '2' }],
      [a(5), { address: a(5), checkedAt: T0 - RECHECK_AFTER_SEC - 99, checkerVersion: '2' }],
    ]);
    expect(dueOrder(cands, stored, T0, 10).map((c) => c.address)).toEqual([a(4), a(2), a(5), a(1)]);
    expect(dueOrder(cands, stored, T0, 2)).toHaveLength(2);
  });

  it('a held unit with a named receiver beats one without', () => {
    const m = new Map<string, Candidate>();
    addCandidate(m, a(7), 0, { holder: a(1), to: null, tokenId: 0n });
    addCandidate(m, a(7), 0, { holder: a(2), to: a(3), tokenId: 0n });
    addCandidate(m, '0x0000000000000000000000000000000000000000', 0, null);
    addCandidate(m, 'junk', 0, null);
    expect(m.size).toBe(1);
    expect(m.get(a(7))!.held!.to).toBe(a(3));
  });
});

describe('writes', () => {
  it('upserts the check row and replaces the findings in one batch', async () => {
    const h = store();
    seed(h, 'offers', { chain_id: CHAIN, offer_id: 1, status: 'active', offer_type: 1, creator: a(1), lending_asset: a(100), collateral_asset: a(100), asset_type: 0, collateral_asset_type: 0 });
    seed(h, 'asset_issuer_check', { chain_id: CHAIN, address: a(100), kind: 'erc20', checked_at: 1, block_number: 1, checker_version: '1', complete: 1 });
    seed(h, 'asset_issuer_finding', { chain_id: CHAIN, address: a(100), check_id: 'old_check', result: 'found', checked_at: 1 });
    await runChain(deps(h, { check: async () => fakeResult(false) }));
    const row = h.db.prepare('SELECT * FROM asset_issuer_check WHERE address = ?').get(a(100)) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: 'erc20', checked_at: T0, block_number: 1234, checker_version: '2', complete: 0, detail: 'unknown: vault_transfer' });
    const f = h.db.prepare('SELECT check_id, result FROM asset_issuer_finding WHERE address = ? ORDER BY check_id').all(a(100));
    expect(f).toEqual([
      { check_id: 'pause', result: 'found' },
      { check_id: 'vault_transfer', result: 'unknown' },
    ]);
  });

  it('declines by name before the store migration', async () => {
    await expect(runChain(deps(store(false)))).rejects.toBeInstanceOf(StoreMissing);
  });

  it('a check that throws is counted and the rest still run', async () => {
    const h = store();
    for (const n of [100, 101]) seed(h, 'signed_offers', { chain_id: CHAIN, status: 'active', lending_asset: a(n), collateral_asset: a(n), asset_type: 0, collateral_asset_type: 0, nonce: String(n), signature: String(n) });
    const r = await runChain(deps(h, { check: async (_c, asset) => { if (asset === a(100)) throw new Error('boom'); return fakeResult(); } }));
    expect(r).toMatchObject({ written: 1, failed: 1 });
    expect(r.notes.join()).toContain(a(100));
  });

  it('stops at the run deadline and says how many are left', async () => {
    const h = store();
    seed(h, 'signed_offers', { chain_id: CHAIN, status: 'active', lending_asset: a(100), collateral_asset: a(101), asset_type: 0, collateral_asset_type: 0 });
    const r = await runChain(deps(h, { deadlineMs: Date.now() - 1 }));
    expect(r.written).toBe(0);
    expect(r.notes.join()).toContain('2 assets left');
  });
});

describe('the scan clock', () => {
  const rep = (over: Partial<ChainReport>): ChainReport => ({ chainId: CHAIN, assets: 0, due: 0, written: 0, complete: 0, failed: 0, notes: [], ...over });
  it('scans hourly, and continues a scan that left due assets', () => {
    const st = new Map();
    expect(scanDue(CHAIN, 0, st)).toBe(true);
    noteScan(CHAIN, 0, rep({ due: 3, written: 3 }), st);
    expect(scanDue(CHAIN, 60_000, st)).toBe(false);
    expect(scanDue(CHAIN, SCAN_INTERVAL_SEC * 1000, st)).toBe(true);
    noteScan(CHAIN, 0, rep({ due: ASSETS_PER_CHAIN, written: ASSETS_PER_CHAIN }), st);
    expect(scanDue(CHAIN, 60_000, st)).toBe(true);
    noteScan(CHAIN, 0, rep({ due: 10, written: 4 }), st);
    expect(scanDue(CHAIN, 60_000, st)).toBe(true);
    // A scan that wrote nothing waits the interval.
    noteScan(CHAIN, 0, rep({ due: ASSETS_PER_CHAIN, failed: ASSETS_PER_CHAIN }), st);
    expect(scanDue(CHAIN, 60_000, st)).toBe(false);
  });
});

describe('revertReason', () => {
  it('reads Error(string), names a custom error by selector, and null for no data', () => {
    const errStr = '0x08c379a0' + '0000000000000000000000000000000000000000000000000000000000000020' + '0000000000000000000000000000000000000000000000000000000000000007' + '426c6f636b656400000000000000000000000000000000000000000000000000';
    expect(revertReason(errStr as `0x${string}`)).toBe('Blocked');
    expect(revertReason('0xdeadbeef')).toBe('0xdeadbeef');
    expect(revertReason('0x')).toBeNull();
    expect(revertReason(undefined)).toBeNull();
  });
});

