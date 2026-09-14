/**
 * Loan-status reconciliation (#2101 part B).
 *
 * The pass writes to a fund-state surface, so the cases below are mostly
 * about what it REFUSES to do.
 *
 * An earlier version of this header said the safety argument was that "a
 * stale read can only miss a repair and never manufacture one". That was
 * retracted in #2190 round 1: the write is irreversible from this pass's
 * point of view, since it only ever selects `active` rows, so a wrong
 * read is permanent rather than harmless. Pinning every read to the
 * scan's SAFE head is what makes it safe; the refusals below are what
 * bound what it may do with a read it trusts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_STATUS_TO_ROW_STATUS,
  decideRepair,
  reconcileChainLoans,
  type ReconcileDeps,
  type ReconcileRow,
} from '../src/loanReconcile';

const CHAIN = 84532;

/** A fake index: rows in memory, every dependency counted. */
function fakeDeps(
  rows: ReconcileRow[],
  chainStatus: Record<number, number | Error>,
  chainActive?: number,
) {
  const calls = { chainCount: 0, statusReads: 0, writes: 0, rowQueries: 0 };
  let pointer = 0;
  const deps: ReconcileDeps = {
    async activeRowsAfter(_c, after, limit) {
      calls.rowQueries += 1;
      return rows
        .filter((r) => r.status === 'active' && r.loan_id > after)
        .sort((a, b) => a.loan_id - b.loan_id)
        .slice(0, limit);
    },
    async countIndexedActive() {
      return rows.filter((r) => r.status === 'active').length;
    },
    async readChainActiveCount() {
      calls.chainCount += 1;
      return chainActive ?? rows.filter((r) => r.status === 'active').length;
    },
    async readChainStatus(_c, loanId) {
      calls.statusReads += 1;
      const v = chainStatus[loanId];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`no stub for loan ${loanId}`);
      return v;
    },
    async writeStatus(_c, loanId, status) {
      calls.writes += 1;
      const row = rows.find((r) => r.loan_id === loanId);
      // Mirrors a compare-and-set on `status = 'active'`: a row another
      // writer already terminalized does not change.
      if (!row || row.status !== 'active') return false;
      row.status = status;
      return true;
    },
    async readPointer() {
      return pointer;
    },
    async writePointer(_c, v) {
      pointer = v;
    },
  };
  return { deps, calls, rows, get pointer() { return pointer; } };
}

describe('decideRepair', () => {
  it('repairs an active row the chain reports terminal', () => {
    expect(decideRepair('active', 1)).toBe('repaid');
    expect(decideRepair('active', 2)).toBe('defaulted');
    expect(decideRepair('active', 3)).toBe('settled');
    expect(decideRepair('active', 5)).toBe('internal_matched');
  });

  it('NEVER terminalizes a loan the chain still calls running', () => {
    // This is the half that makes a stale read inert: a node that is
    // behind answers Active, which writes nothing.
    expect(decideRepair('active', 0)).toBeNull();
    // FallbackPending is a partial rescue, not an ending.
    expect(decideRepair('active', 4)).toBeNull();
  });

  it('never guesses at an unknown future status', () => {
    for (const unknown of [6, 7, 99, -1]) {
      expect(decideRepair('active', unknown)).toBeNull();
    }
  });

  it('refuses to touch a row that is already terminal', () => {
    // The event path owns terminal→terminal. A sweep that reopened it
    // could overwrite the specific `liquidated` with the chain's
    // `defaulted`, since the chain enum has no Liquidated member.
    for (const from of ['repaid', 'defaulted', 'liquidated', 'settled', 'internal_matched']) {
      expect(decideRepair(from, 2)).toBeNull();
    }
  });

  it('agrees with the scan module it deliberately duplicates', () => {
    // The map is copied rather than imported, so this reads the other
    // copy out of the source and requires the two to match. A drift here
    // means a repaired row disagrees with an event-written one.
    const src = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
    const block = src.slice(
      src.indexOf('const LOAN_STATUS_TO_INDEXER_TERMINAL'),
      src.indexOf('};', src.indexOf('const LOAN_STATUS_TO_INDEXER_TERMINAL')),
    );
    expect(block.length).toBeGreaterThan(0); // an empty slice would pass everything
    const theirs: Record<number, string> = {};
    for (const m of block.matchAll(/(\d+):\s*'([a-z_]+)'/g)) theirs[Number(m[1])] = m[2];
    expect(theirs).toEqual(CHAIN_STATUS_TO_ROW_STATUS);
  });
});

describe('reconcileChainLoans', () => {
  it('repairs the shape actually observed on Base Sepolia', async () => {
    // chain 6 active, index 9 — loans 8 (Defaulted), 13 and 14 (Repaid).
    const rows: ReconcileRow[] = [1, 4, 7, 8, 10, 11, 13, 14, 21].map((loan_id) => ({
      loan_id,
      status: 'active',
    }));
    const chain = { 1: 0, 4: 0, 7: 0, 8: 2, 10: 0, 11: 0, 13: 1, 14: 1, 21: 0 };
    const f = fakeDeps(rows, chain, 6);
    // Enough budget to reach every row in one pass, for the assertion's sake.
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 9 });
    expect(r.agreed).toBe(false);
    expect(r.repaired).toEqual([
      { loanId: 8, from: 'active', to: 'defaulted' },
      { loanId: 13, from: 'active', to: 'repaid' },
      { loanId: 14, from: 'active', to: 'repaid' },
    ]);
    expect(rows.filter((x) => x.status === 'active').map((x) => x.loan_id)).toEqual([
      1, 4, 7, 10, 11, 21,
    ]);
  });

  it('does NOT skip sale-vehicle rows', async () => {
    // 13 and 14 are sale vehicles, which `/loans/stats` filters out. A
    // sweep that inherited that filter would leave them stale forever
    // while every published count looked correct — worse than the bug.
    // The sweep selects on status alone, so this is really a statement
    // that no vehicle filter exists here; the case exists so adding one
    // fails loudly.
    const rows: ReconcileRow[] = [13, 14].map((loan_id) => ({ loan_id, status: 'active' }));
    const f = fakeDeps(rows, { 13: 1, 14: 1 }, 0);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired.map((x) => x.loanId)).toEqual([13, 14]);
  });

  it('keeps examining rows when the counts AGREE', async () => {
    // Two errors cancel — a missed terminal plus a missed LoanInitiated —
    // so a gate that only fires on a mismatch is silently satisfiable.
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 2 }, 1); // chain says 1 active, index says 1
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5, minRows: 1 });
    expect(r.agreed).toBe(true);
    expect(r.examined).toEqual([8]);
    expect(r.repaired).toEqual([{ loanId: 8, from: 'active', to: 'defaulted' }]);
  });

  it('spends less when the counts agree than when they do not', async () => {
    const mk = () =>
      [1, 2, 3, 4, 5].map((loan_id) => ({ loan_id, status: 'active' }) as ReconcileRow);
    const chain = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const agree = fakeDeps(mk(), chain, 5);
    await reconcileChainLoans(CHAIN, agree.deps, { maxRows: 5, minRows: 1 });
    const differ = fakeDeps(mk(), chain, 99);
    await reconcileChainLoans(CHAIN, differ.deps, { maxRows: 5, minRows: 1 });
    expect(agree.calls.statusReads).toBe(1);
    expect(differ.calls.statusReads).toBe(5);
  });

  it('rotates, and wraps rather than stranding the head of the table', async () => {
    const rows: ReconcileRow[] = [1, 2, 3].map((loan_id) => ({ loan_id, status: 'active' }));
    const chain = { 1: 0, 2: 0, 3: 0 };
    const f = fakeDeps(rows, chain, 3);
    const seen: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 1, minRows: 1 });
      seen.push(r.examined);
    }
    // 1, 2, 3, then back to 1 — not 1, 2, 3, nothing-ever-again.
    expect(seen).toEqual([[1], [2], [3], [1]]);
  });

  it('leaves a row alone when its chain read fails, and returns to it', async () => {
    // A read that did not happen is not evidence about the loan.
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const boom = fakeDeps(rows, { 8: new Error('rate limited') }, 0);
    const r = await reconcileChainLoans(CHAIN, boom.deps, { maxRows: 5 });
    expect(r.unread).toEqual([8]);
    expect(r.repaired).toEqual([]);
    expect(rows[0].status).toBe('active');
    expect(boom.calls.writes).toBe(0);
  });

  it('costs exactly one chain call when nothing is wrong and the budget is minimal', async () => {
    // The tick has single-digit subrequest headroom beside the backfill,
    // so the healthy-case cost is the number that matters.
    const rows: ReconcileRow[] = [{ loan_id: 1, status: 'active' }];
    const f = fakeDeps(rows, { 1: 0 }, 1);
    await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5, minRows: 1 });
    expect(f.calls.chainCount).toBe(1);
    expect(f.calls.statusReads).toBe(1);
    expect(f.calls.writes).toBe(0);
  });
});

describe('reporting what actually changed', () => {
  it('does NOT report a repair the compare-and-set declined', async () => {
    // The scan may terminalize the row from its own event between the
    // selection and this write. The CAS then matches nothing and the
    // stored status is the scan's — more specific than anything this
    // pass could derive. Announcing `active->defaulted` there would make
    // the operational record false in exactly the race the guard handles.
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 2 }, 0);
    // Another writer wins between selection and write.
    const inner = f.deps.writeStatus;
    f.deps.writeStatus = async (c, id, st) => {
      rows[0].status = 'liquidated';
      return inner(c, id, st);
    };
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired).toEqual([]);
    expect(r.superseded).toEqual([8]);
    expect(rows[0].status).toBe('liquidated');
  });

  it('reports a repair it did make', async () => {
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 2 }, 0);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired).toEqual([{ loanId: 8, from: 'active', to: 'defaulted' }]);
    expect(r.superseded).toEqual([]);
  });
});
