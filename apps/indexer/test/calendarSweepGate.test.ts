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
import { _sweepCalendarIfEstablished } from '../src/chainIndexer';
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
    }).catch(() => undefined);
    expect(prepare).toHaveBeenCalled();
  });
});
