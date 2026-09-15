/**
 * The calendar sweep waits for a tick that actually checked (#2211 r1
 * `4011103056`).
 *
 * The reminders this sweep mints are derived from rows recorded `active`,
 * fire once, and are never retracted. A ghost loan — one whose terminal
 * event the indexer missed for good — is exactly a row recorded active that
 * is not. So a tick that could not check the live set against the chain, and
 * swept anyway, could tell a user to prepare for the default of a loan that
 * had already ended.
 *
 * Reconciliation is what does that checking, and it can decline for three
 * reasons: the head was guessed, the cursor is ahead of the head, or the
 * scan has not caught up. Before this, all three returned an empty array —
 * indistinguishable from "checked, nothing wrong" — and two of the three
 * swept regardless. The third only avoided it by re-testing the same
 * condition in a second place, which is the arrangement that let the other
 * two slip.
 *
 * Deferring is not a new invention here: the sweep already defers itself
 * when the grace schedule has not been snapshotted, on the same reasoning.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _sweepCalendarIfEstablished, _unestablishedRows } from '../src/chainIndexer';
import type { ReconcileReport } from '../src/loanReconcile';
import type { Env } from '../src/env';

const CHAIN = 84532;

/**
 * A D1 stand-in that records whether it was touched at all.
 *
 * The assertion that matters is not what the sweep returned but whether it
 * RAN: an empty result and a deferral look identical from the outside, and
 * the deferral is the entire fix.
 */
function db() {
  const prepare = vi.fn(() => {
    throw new Error('the sweep must not have queried on a deferred tick');
  });
  return { env: { DB: { prepare } } as unknown as Env, prepare };
}

afterEach(() => vi.restoreAllMocks());

describe('a tick that did not establish the live set', () => {
  for (const reason of [
    'no settled block could be read (TimeoutError)',
    'the cursor (900) is ahead of the resolved head (880)',
    'the scan reached 500, short of the head 900',
    'the reconciliation pass failed',
  ]) {
    it(`defers the sweep, and says so: ${reason}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warn.mockClear();
      const { env, prepare } = db();
      const out = await _sweepCalendarIfEstablished(env, CHAIN, 1_700_000_000, 900, {
        established: false,
        reason,
      });
      // Not merely "no rows" — the sweep never ran, so it cannot have read a
      // stale active row at all.
      expect(prepare).not.toHaveBeenCalled();
      expect(out.inserted).toBe(0);
      expect(out.loanIds).toEqual([]);
      // SAID. A deferral an operator cannot see is the silent-skip defect
      // this whole path exists to end, and each reason needs a different
      // remedy, so the reason is carried through rather than flattened.
      const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(said).toContain('DEFERRED');
      expect(said).toContain(reason);
    });
  }
});

describe('which rows a pass has actually established', () => {
  const report = (over: Partial<ReconcileReport> = {}): ReconcileReport => ({
    chainId: CHAIN,
    chainActive: 6,
    indexedActive: 6,
    agreed: true,
    examined: [],
    repaired: [],
    unread: [],
    writeFailed: [],
    unresolvable: [],
    unknownStatus: [],
    superseded: [],
    nextPointer: 0,
    wrappedLap: false,
    ...over,
  });

  it('counts every row it could not settle, the orphan included', () => {
    // #2211 r3 `4011279296`. A pass that RETURNS NORMALLY has still
    // established only the rows it established, and each of these is sitting
    // at `status = 'active'` — the shape a missed terminal leaves behind.
    expect(
      _unestablishedRows(
        report({
          unread: [13],
          writeFailed: [14],
          unresolvable: [99],
          unknownStatus: [{ loanId: 21, status: 7 }],
        }),
      ).sort((a, b) => a - b),
    ).toEqual([13, 14, 21, 99]);
  });

  it('counts the ORPHAN, which is the alarming member and not an edge', () => {
    // The chain answered — "no such loan" — and the row is still published
    // as open. Reminding its holder to repay would be the worst line this
    // surface could write.
    expect(_unestablishedRows(report({ unresolvable: [99] }))).toEqual([99]);
  });

  it('counts neither a repaired row nor one another writer terminalized', () => {
    // Both are terminal now, so neither can be reminded about. Withholding
    // them would cost reminders for no safety.
    expect(
      _unestablishedRows(
        report({ repaired: [{ loanId: 8, from: 'active', to: 'defaulted' }], superseded: [9] }),
      ),
    ).toEqual([]);
  });
});

describe('a tick that did establish it', () => {
  it('sweeps, even when the pass repaired nothing', async () => {
    // The common case, and the one a too-eager gate would break: a healthy
    // chain where reconciliation agrees with the chain every tick must still
    // get its reminders.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, prepare } = db();
    await _sweepCalendarIfEstablished(env, CHAIN, 1_700_000_000, 900, {
      established: true,
      repairedLoanIds: [],
      unestablishedLoanIds: [],
    }).catch(() => undefined);
    // The stub throws on first query; reaching it is the proof that the gate
    // let this tick through.
    expect(prepare).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('DEFERRED');
  });

  it('sweeps after a pass that repaired rows and THEN failed its cursor write', async () => {
    // Those rows were checked against the chain at a settled head; only the
    // bookkeeping afterwards failed. Treating that as unchecked would defer
    // the sweep on precisely the tick that did the work it depends on.
    const { env, prepare } = db();
    await _sweepCalendarIfEstablished(env, CHAIN, 1_700_000_000, 900, {
      established: true,
      repairedLoanIds: [8],
      unestablishedLoanIds: [],
    }).catch(() => undefined);
    expect(prepare).toHaveBeenCalled();
  });
});
