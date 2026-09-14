/**
 * Loan-status reconciliation (#2101 part B).
 *
 * The pass writes to a fund-state surface, so the cases below are mostly
 * about what it REFUSES to do.
 *
 * An earlier version of this header said the safety argument was that "a
 * stale read can only miss a repair and never manufacture one". That was
 * retracted in #2190 round 1: the write is irreversible from this pass's
 * point of view, since it only ever selects LIVE rows, so a wrong read is
 * permanent rather than harmless. Pinning every read to the
 * scan's SAFE head is what makes it safe; the refusals below are what
 * bound what it may do with a read it trusts.
 */
import { describe, expect, it } from 'vitest';
import { LOAN_STATUS_TO_INDEXER_TERMINAL } from '../src/loanStatusProjection';
import {
  CHAIN_STATUS_TO_ROW_STATUS,
  decideRepair,
  ReconcilePartialError,
  reconcileChainLoans,
  type ReconcileDeps,
  type ReconcileRow,
} from '../src/loanReconcile';

const CHAIN = 84532;

/** The live set the real deps select on. The fake below uses THIS rather
 *  than a hard-coded `'active'`, or it stops modelling the thing under
 *  test the moment the set changes — which is exactly what happened when
 *  `fallback_pending` was added. */
const LIVE = new Set(['active', 'fallback_pending']);

/** What the chain says about one loan. A bare number is shorthand for
 *  "this status, and amounts nobody in the case cares about". */
type ChainStub =
  | number
  | Error
  | { status: number; principal: string; collateralAmount: string };

const TOKENS = { lenderTokenId: '1', borrowerTokenId: '2' };

/** The shared mutable projection, in the shape the scan's builder emits.
 *  The fake carries a REAL one rather than a placeholder so a case can see
 *  what the write put in the row. */
const mutableOf = (principal: string, collateralAmount: string) => ({
  assignments: ['principal = ?', 'collateral_amount = ?'],
  values: [principal, collateralAmount],
});

function asRead(v: Exclude<ChainStub, Error>) {
  return typeof v === 'number'
    ? { status: v, mutable: mutableOf('0', '0'), ...TOKENS }
    : { status: v.status, mutable: mutableOf(v.principal, v.collateralAmount), ...TOKENS };
}

/** The selector reads only `loan_id` and `status` — the two extra columns
 *  exist here so a case can observe what the WRITE put in them. */
type FakeRow = ReconcileRow & { principal?: string; collateral_amount?: string };

/** A fake index: rows in memory, every dependency counted. */
function fakeDeps(
  rows: FakeRow[],
  chainStatus: Record<number, ChainStub>,
  chainActive?: number,
) {
  const calls = { chainCount: 0, statusReads: 0, writes: 0, rowQueries: 0 };
  /** Loans whose side tables the pass cleared, in order. The real write is
   *  ONE batch, so the fake clears inside `writeRepair` for the same
   *  reason: a fake that cleared separately could not represent the
   *  all-or-nothing property the batch gives. */
  const sideTablesCleared: number[] = [];
  /** Loan ids whose repair write should throw. */
  const writeFails = new Set<number>();
  /** Make the post-loop cursor write throw. */
  let pointerWriteFails = false;
  let pointer = 0;
  let lapEnd = 0;
  const deps: ReconcileDeps = {
    async activeRowsInLap(_c, after, lapEnd, limit) {
      calls.rowQueries += 1;
      // The `<= lapEnd` bound is the whole point of the lap — a fake that
      // ignored it could not show a busy chain's pointer being outrun.
      return rows
        .filter((r) => LIVE.has(r.status) && r.loan_id > after && r.loan_id <= lapEnd)
        .sort((a, b) => a.loan_id - b.loan_id)
        .slice(0, limit);
    },
    async maxLiveLoanId() {
      return rows
        .filter((r) => LIVE.has(r.status))
        .reduce((m, r) => Math.max(m, r.loan_id), 0);
    },
    async readLapEnd() {
      return lapEnd;
    },
    async writeLapEnd(_c, v) {
      lapEnd = v;
    },
    async countIndexedActive() {
      return rows.filter((r) => LIVE.has(r.status)).length;
    },
    async readChainActiveCount() {
      calls.chainCount += 1;
      return chainActive ?? rows.filter((r) => LIVE.has(r.status)).length;
    },
    async readChainLoan(_c, loanId) {
      calls.statusReads += 1;
      const v = chainStatus[loanId];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`no stub for loan ${loanId}`);
      return asRead(v);
    },
    async writeRepair(_c, loanId, repair) {
      calls.writes += 1;
      if (writeFails.has(loanId)) throw new Error(`D1 unavailable for ${loanId}`);
      // The deletes are NOT conditional on the compare-and-set winning —
      // the chain reported this loan ended, and that is what licenses
      // clearing them. Recorded first so the order matches the batch.
      sideTablesCleared.push(loanId);
      const row = rows.find((r) => r.loan_id === loanId);
      // Mirrors the real compare-and-set, which guards on the LIVE set:
      // a row another writer already terminalized does not change.
      if (!row || !LIVE.has(row.status)) return false;
      row.status = repair.status;
      // The real write is ONE statement over the status plus every mutable
      // column, so a fake that moved only the status could not observe half
      // a repair. Applied by column name, the way the SQL does.
      repair.mutable.assignments.forEach((a, i) => {
        const col = a.split(' = ')[0];
        if (col === 'principal') row.principal = String(repair.mutable.values[i]);
        if (col === 'collateral_amount') {
          row.collateral_amount = String(repair.mutable.values[i]);
        }
      });
      return true;
    },
    async terminalHolderStatements() {
      return [];
    },
    async readPointer() {
      return pointer;
    },
    async writePointer(_c, v) {
      if (pointerWriteFails) throw new Error('D1 unavailable for the cursor');
      pointer = v;
    },
  };
  return {
    deps,
    calls,
    rows,
    sideTablesCleared,
    writeFails,
    failPointerWrite() { pointerWriteFails = true; },
    get pointer() { return pointer; },
    get lapEnd() { return lapEnd; },
  };
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

  it('repairs a fallback_pending row the chain reports terminal', () => {
    // The indexer treats `fallback_pending` as LIVE and transitions it
    // straight to terminal — the InternalMatchExecuted handler and the
    // terminal helper both guard on ('active','fallback_pending'). Leaving
    // it out meant such a row was never repaired, AND that the count gate
    // compared two different sets: the chain counter is documented as
    // "Active or FallbackPending", so one such row pinned the gate open
    // forever (#2190 round 1).
    expect(decideRepair('fallback_pending', 1)).toBe('repaid');
    expect(decideRepair('fallback_pending', 2)).toBe('defaulted');
    expect(decideRepair('fallback_pending', 5)).toBe('internal_matched');
  });

  it('leaves a fallback_pending row alone while the chain agrees it is pending', () => {
    // FallbackPending(4) maps to no terminal, so there is nothing to
    // write — and the row must not be "repaired" to the state it is in.
    expect(decideRepair('fallback_pending', 4)).toBeNull();
    expect(decideRepair('fallback_pending', 0)).toBeNull();
  });

  it('refuses to touch a row that is already terminal', () => {
    // The event path owns terminal→terminal. A sweep that reopened it
    // could overwrite the specific `liquidated` with the chain's
    // `defaulted`, since the chain enum has no Liquidated member.
    for (const from of ['repaid', 'defaulted', 'liquidated', 'settled', 'internal_matched']) {
      expect(decideRepair(from, 2)).toBeNull();
    }
  });

  it('is the SAME object the scanner projects with, not a copy of it', () => {
    // There was a case here that read `chainIndexer.ts` as TEXT and
    // compared two production copies. #2190 round 3 was right that both
    // the copy and the test were the defect: one made every enum change
    // depend on someone remembering the second definition, the other
    // coupled this suite to another module's formatting. There is one
    // definition now, so identity is the whole assertion.
    expect(CHAIN_STATUS_TO_ROW_STATUS).toBe(LOAN_STATUS_TO_INDEXER_TERMINAL);
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

  it('reaches a fallback_pending row end to end, not just in decideRepair', async () => {
    // The unit case above proves the DECISION admits it; this proves the
    // selector and the compare-and-set do too. Three places had to change
    // together and a decision-only case would have passed with the SQL
    // still excluding the row.
    const rows: ReconcileRow[] = [
      { loan_id: 30, status: 'fallback_pending' },
      { loan_id: 31, status: 'active' },
    ];
    const f = fakeDeps(rows, { 30: 1, 31: 0 }, 1);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.examined).toEqual([30, 31]);
    expect(r.repaired).toEqual([{ loanId: 30, from: 'fallback_pending', to: 'repaid' }]);
    expect(rows[0].status).toBe('repaid');
  });

  it('counts BOTH live statuses, so a pending row cannot pin the gate open', async () => {
    // The chain counter is Active OR FallbackPending. Counting only
    // `active` here made the two differ permanently — larger budget every
    // pass, forever, over a row the selector would not examine.
    const rows: ReconcileRow[] = [
      { loan_id: 30, status: 'fallback_pending' },
      { loan_id: 31, status: 'active' },
    ];
    const f = fakeDeps(rows, { 30: 4, 31: 0 }, 2); // chain: 2 live
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5, minRows: 1 });
    expect(r.indexedActive).toBe(2);
    expect(r.agreed).toBe(true);
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
    // The healthy case is the cost that matters, because it is the one
    // paid on every tick forever. Deliberately not phrased as fitting a
    // headroom: on the legacy inline path there is none to fit into
    // (#2194), and on the DO path this scan has the invocation to itself.
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
    const inner = f.deps.writeRepair;
    f.deps.writeRepair = async (c, id, rep) => {
      rows[0].status = 'liquidated';
      return inner(c, id, rep);
    };
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired).toEqual([]);
    expect(r.superseded).toEqual([8]);
    expect(rows[0].status).toBe('liquidated');
    // The side tables ARE still cleared, and that is deliberate. An earlier
    // revision guarded this on the compare-and-set winning, reasoning that
    // the other writer clears its own. That is an inference about another
    // code path; what this pass actually holds is the chain's own report
    // that the loan has ended, and a live listing or intent on an ended
    // loan is stale whoever recorded the ending. Making it unconditional is
    // also what let the whole write become one transaction (#2190 r3).
    expect(f.sideTablesCleared).toEqual([8]);
  });

  it('reports a repair it did make', async () => {
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 2 }, 0);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired).toEqual([{ loanId: 8, from: 'active', to: 'defaulted' }]);
    expect(r.superseded).toEqual([]);
  });
});

describe('a repaired row is a whole row', () => {
  it('writes the money from the SAME read as the status', async () => {
    // The event path's match handler refreshes principal/collateral from a
    // block-pinned read; a repair that moved only the status would leave a
    // closed loan advertising principal outstanding. The amounts come from
    // the same read, so they cannot describe a different block.
    const rows: FakeRow[] = [{ loan_id: 8, status: 'active', principal: '5000', collateral_amount: '700' }];
    const f = fakeDeps(
      rows,
      { 8: { status: 5, principal: '0', collateralAmount: '250' } },
      0,
    );
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired).toEqual([{ loanId: 8, from: 'active', to: 'internal_matched' }]);
    expect(rows[0].principal).toBe('0');
    expect(rows[0].collateral_amount).toBe('250');
  });

  it('carries amounts as strings, so a uint256 survives the pass', async () => {
    // These columns are TEXT because the values do not fit a JS number.
    // A pass that ever put them through one would round silently.
    const big = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const rows: FakeRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: { status: 1, principal: big, collateralAmount: big } }, 0);
    await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(rows[0].principal).toBe(big);
    expect(rows[0].collateral_amount).toBe(big);
  });

  it('clears the side tables of a loan it closed', async () => {
    // Every terminal handler on the event path runs the same cleanup.
    // Without it the app keeps offering a Seaport listing, and keeps
    // publishing a committed swap-to-repay intent with a cancel action,
    // for a loan that has ended.
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 2 }, 0);
    await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(f.sideTablesCleared).toEqual([8]);
  });

  it('does NOT clear the side tables of a loan it left alone', async () => {
    const rows: ReconcileRow[] = [{ loan_id: 8, status: 'active' }];
    const f = fakeDeps(rows, { 8: 0 }, 1); // chain still calls it running
    await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(f.sideTablesCleared).toEqual([]);
  });

  it('has no way to land a status without its cleanup', async () => {
    // There is no partial-failure path left to report. The status and the
    // deletes are ONE call, which the live implementation runs as one D1
    // batch, so a killed isolate loses both or neither. This case states
    // that shape — exactly one write call per repaired loan — because what
    // round 3 found was precisely a second call that could be lost, and a
    // caught error was never the hard case: an isolate termination leaves
    // nothing to catch.
    const rows: ReconcileRow[] = [
      { loan_id: 8, status: 'active' },
      { loan_id: 9, status: 'active' },
    ];
    const f = fakeDeps(rows, { 8: 2, 9: 1 }, 0);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired.map((x) => x.loanId)).toEqual([8, 9]);
    expect(f.calls.writes).toBe(2);
    expect(f.sideTablesCleared).toEqual([8, 9]);
    expect(f.pointer).toBe(9);
  });
});

describe('the lap terminates on a chain that keeps appending loans', () => {
  it('re-examines earlier ids instead of chasing the tail forever', async () => {
    // #2190 r2 `4005830728`. Wrapping only when the tail is empty is a
    // rotation that never wraps on a busy chain: new live loans keep
    // appearing above the pointer, so ids below it are never looked at
    // again.
    //
    // Loan 1 reads Active while the first lap passes over it and only
    // LATER reports its terminal — which is the real shape of a missed
    // event, and the only shape that can tell a wrapping rotation from one
    // marching off the end. One loan is appended per pass, the rate that
    // defeats an empty-tail wrap.
    const rows: FakeRow[] = [1, 2, 3].map((loan_id) => ({ loan_id, status: 'active' }));
    const chain: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    const f = fakeDeps(rows, chain, 0);
    let nextId = 4;
    for (let pass = 0; pass < 8; pass++) {
      if (pass === 3) chain[1] = 2; // the terminal the index never saw
      await reconcileChainLoans(CHAIN, f.deps, { maxRows: 1, minRows: 1 });
      rows.push({ loan_id: nextId, status: 'active' });
      chain[nextId] = 0;
      nextId += 1;
    }
    expect(rows.find((r) => r.loan_id === 1)?.status).toBe('defaulted');
  });

  it('holds the boundary for the whole lap, so a lap cannot be outrun', async () => {
    // A loan appended mid-lap belongs to the NEXT lap. Without the fixed
    // boundary the pass would extend the current one indefinitely.
    const rows: FakeRow[] = [1, 2].map((loan_id) => ({ loan_id, status: 'active' }));
    const f = fakeDeps(rows, { 1: 0, 2: 0, 9: 0 }, 0);
    await reconcileChainLoans(CHAIN, f.deps, { maxRows: 1, minRows: 1 });
    expect(f.lapEnd).toBe(2); // captured before loan 9 existed
    rows.push({ loan_id: 9, status: 'active' });
    const second = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5, minRows: 1 });
    // Loan 9 is above the boundary, so this lap finishes at 2 rather than
    // absorbing it.
    expect(second.examined).toEqual([2]);
  });

  it('says when a lap wrapped, because a stalled rotation looks healthy', async () => {
    const rows: FakeRow[] = [{ loan_id: 1, status: 'active' }];
    const f = fakeDeps(rows, { 1: 0 }, 1);
    const first = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 1, minRows: 1 });
    expect(first.wrappedLap).toBe(false);
    const second = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 1, minRows: 1 });
    expect(second.wrappedLap).toBe(true);
  });
});

describe('a failing write does not discard the repairs that landed', () => {
  it('keeps the earlier repairs, and names the one that failed', async () => {
    // #2190 r4 `4007262520`. Letting the write throw meant the caller's
    // catch returned zero for the WHOLE pass: the earlier rows were
    // corrected in D1 but their count never reached the result, so the
    // `loan.updated` broadcast never fired — and those rows are no longer
    // live, so no later pass can rediscover them to report.
    const rows: ReconcileRow[] = [8, 9, 10].map((loan_id) => ({
      loan_id,
      status: 'active',
    }));
    const f = fakeDeps(rows, { 8: 2, 9: 1, 10: 1 }, 0);
    f.writeFails.add(9);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.repaired.map((x) => x.loanId)).toEqual([8, 10]);
    expect(r.writeFailed).toEqual([9]);
    // The failed row is untouched — the repair is one transaction — so the
    // rotation returns to it.
    expect(rows.find((x) => x.loan_id === 9)?.status).toBe('active');
  });

  it('distinguishes a failed WRITE from a failed READ', async () => {
    // A failing write with a succeeding read points at D1; a failing read
    // points at the RPC. Folding them together would send an operator to
    // the wrong place.
    const rows: ReconcileRow[] = [
      { loan_id: 8, status: 'active' },
      { loan_id: 9, status: 'active' },
    ];
    const f = fakeDeps(rows, { 8: new Error('rate limited'), 9: 1 }, 0);
    f.writeFails.add(9);
    const r = await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    expect(r.unread).toEqual([8]);
    expect(r.writeFailed).toEqual([9]);
  });
});

describe('a failure after the repairs landed still reports them', () => {
  it('carries the repaired ids out on the error', async () => {
    // #2190 r6 `4007752788`. Each repair is its own committed transaction
    // and a repaired row has LEFT the live set, so a throw in the cursor
    // write would otherwise lose those corrections from every count and
    // broadcast permanently — no later pass can rediscover them to report.
    const rows: ReconcileRow[] = [
      { loan_id: 8, status: 'active' },
      { loan_id: 9, status: 'active' },
    ];
    const f = fakeDeps(rows, { 8: 2, 9: 1 }, 0);
    f.failPointerWrite();
    // ONE call, inspected — running it twice would find the rows already
    // repaired and report nothing, which is the test lying rather than the
    // code failing.
    let caught: unknown;
    try {
      await reconcileChainLoans(CHAIN, f.deps, { maxRows: 5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReconcilePartialError);
    const report = (caught as ReconcilePartialError).report;
    // The rows really were corrected; only the pointer failed to move.
    expect(report.repaired.map((r) => r.loanId).sort()).toEqual([8, 9]);
    expect(rows.every((r) => r.status !== 'active')).toBe(true);
  });
});
