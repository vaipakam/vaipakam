/**
 * What a reconciliation pass tells the operator (#2203).
 *
 * The diagnostics ARE the feature. `unread`, `unresolvable` and
 * `unknownStatus` each exist because a review round established that silence
 * was the defect — a pass that quietly skips what it cannot establish reports
 * perfect health while records stay wrong.
 *
 * They were being lost on a late failure. `ReconcilePartialError` carries the
 * whole report, and the caller read only `repaired` off it, so a pass that
 * examined an orphaned row, correctly identified it as unresolvable, and then
 * failed its cursor write said nothing about that row. If the pointer write
 * had succeeded and only the lap-boundary write failed, the rotation had
 * already moved past it — examined, not named, and not examined again until
 * the lap wrapped.
 *
 * Neither path reports now. The pass resolves its report — returned, or
 * lifted off the error — and the two rejoin BEFORE the single reporting
 * call, so "the failure path forgot" is not a thing that can be written.
 * The cases below pin what that call says; the last block pins that it is
 * reached, which is a separate claim and was the one going unchecked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _reportQuarantineForChain,
  _reportReconcilePass,
  _runLoanReconcilePass,
} from '../src/chainIndexer';
import { ReconcilePartialError, type ReconcileReport } from '../src/loanReconcile';
import type { ChainConfig, Env } from '../src/env';

/**
 * The pass's collaborator, swapped so a late failure can be produced without
 * a chain or a database. `ReconcilePartialError` stays REAL — the join lifts
 * the report off it with `instanceof`, so a stubbed stand-in would prove
 * nothing about the path being tested.
 */
let scanBehaviour: () => Promise<ReconcileReport> = () => {
  throw new Error('scanBehaviour not set by the test');
};
vi.mock('../src/loanReconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/loanReconcile')>();
  return { ...actual, reconcileAfterScan: () => scanBehaviour() };
});

const CHAIN = 84532;

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

/**
 * Everything written to warn+error for THIS report, joined — the operator
 * sees one stream.
 *
 * The `mockClear` calls are load-bearing, not tidiness. `vi.spyOn` on an
 * already-spied method returns the EXISTING spy with its `mock.calls` intact
 * until `afterEach`, so a second call in the same test would read the first
 * one's output as its own. The three-case loop below is exactly that shape:
 * the `unread` case emits `UNDETERMINED`, and without this the `writeFailed`
 * and `unknownStatus` cases would pass on its residue even if they emitted
 * nothing at all — two of the three branches this file exists to protect,
 * unprotected, in a test that looked green.
 */
function captured(r: ReconcileReport): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn.mockClear();
  error.mockClear();
  _reportReconcilePass(CHAIN, r);
  const out = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('what the pass says out loud', () => {
  it('says nothing at all when there is nothing to say', () => {
    // A healthy agreeing pass must not add noise; an operator filtering on
    // this prefix should see output only when something happened.
    expect(captured(report())).toBe('');
  });

  it('names a repair with its transition', () => {
    const out = captured(report({ repaired: [{ loanId: 8, from: 'active', to: 'defaulted' }] }));
    expect(out).toContain('loan 8 active->defaulted');
  });

  it('names rows it could not READ, which retry', () => {
    expect(captured(report({ unread: [13, 14] }))).toContain('13, 14');
  });

  it('names rows it could not WRITE, separately from unread ones', () => {
    // Different cause, different remedy: a failing write points at D1 where a
    // failing read points at the RPC, so they must not be pooled.
    const out = captured(report({ unread: [13], writeFailed: [14] }));
    expect(out).toMatch(/could not read[\s\S]*13/);
    expect(out).toMatch(/could not WRITE[\s\S]*14/);
  });

  it('names a row the chain has never heard of', () => {
    const out = captured(report({ unresolvable: [99] }));
    expect(out).toContain('99');
    expect(out.toLowerCase()).toContain('orphan');
  });

  it('names a status this build cannot project, with the number', () => {
    // Refusing to guess is right; refusing SILENTLY is how a newly added
    // terminal leaves rows published as open while every check looks healthy.
    const out = captured(report({ unknownStatus: [{ loanId: 21, status: 7 }] }));
    expect(out).toContain('loan 21 = 7');
  });

  it('reports an unresolved count disagreement only once a lap has settled it', () => {
    const mismatch = { agreed: false, chainActive: 6, indexedActive: 7, repaired: [] };
    // Mid-lap: the repairs that would settle it have not been made yet.
    expect(captured(report({ ...mismatch, wrappedLap: false, examined: [1] }))).not.toContain(
      'UNDETERMINED',
    );
    // A full lap that repaired nothing AND established everything can rule a
    // missed terminal out.
    expect(captured(report({ ...mismatch, wrappedLap: true }))).toContain('NOT a missed terminal');
  });

  it('refuses to rule anything out when the lap failed to establish it', () => {
    // The three ways to learn nothing about a row, each of which must defeat the
    // confident verdict — a conclusion drawn from an absence of evidence is
    // the defect here, not the disagreement itself.
    for (const gap of [{ unread: [5] }, { writeFailed: [5] }, { unknownStatus: [{ loanId: 5, status: 9 }] }]) {
      const out = captured(
        report({ agreed: false, chainActive: 6, indexedActive: 7, wrappedLap: true, ...gap }),
      );
      expect(out).toContain('UNDETERMINED');
      expect(out).not.toContain('NOT a missed terminal');
    }
  });
});

/**
 * That the operator is told, not merely what they would be told (#2203 r3
 * `4010916222`).
 *
 * Every case above calls `_reportReconcilePass` directly, so none of them
 * touches the join that is the actual fix — deleting its single call left
 * forty tests green. A regression suite for "the diagnostics survive a late
 * failure" that passes with the reporting unreachable is testing the wrong
 * half of its own claim.
 *
 * The pass's collaborator is stubbed rather than driven through D1, but the
 * failure it raises is the real `ReconcilePartialError` that
 * `loanReconcile.test.ts` proves a failing pointer write produces, carrying
 * the real report. The two suites meet: that one pins what the cursor write
 * throws, this one pins what the caller does with it.
 */
describe('the join, not just the wording', () => {
  const passInput = () => ({
    env: { DB: {} } as unknown as Env,
    // Never dialled: the collaborator that would have read from it is
    // stubbed, and the client is only constructed.
    chain: { rpc: 'http://127.0.0.1:1/unused' } as unknown as ChainConfig,
    chainId: CHAIN,
    diamond: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    // A head the CHAIN called settled. The pass refuses a guessed one
    // outright (#2201), which the last case below pins.
    head: { block: 100n, timestamp: 1_700_000_000n, settled: true },
    // The tick's records reach exactly the head — the pass refuses any other
    // relationship, so this is what "a pass that runs" looks like.
    readThrough: 100n,
    budget: {},
  });

  /** Runs a whole pass and returns what the operator saw, plus what it returned. */
  async function drive(behaviour: () => Promise<ReconcileReport>) {
    scanBehaviour = behaviour;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warn.mockClear();
    error.mockClear();
    const outcome = await _runLoanReconcilePass(passInput());
    const out = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');
    return { out, outcome };
  }

  // A pass that noticed three different things it could not settle, and one
  // it could — the payload the old catch read one field of.
  const noticed = () =>
    report({
      repaired: [{ loanId: 8, from: 'active', to: 'defaulted' }],
      unresolvable: [99],
      unread: [13],
      unknownStatus: [{ loanId: 21, status: 7 }],
    });

  it('reports everything the pass noticed when it FINISHED', async () => {
    const { out, outcome } = await drive(async () => noticed());
    expect(out).toContain('99');
    expect(out).toContain('loan 21 = 7');
    // The orphan, the unread row and the unprojectable status are named as
    // UNESTABLISHED as well as logged — the reminder sweep withholds exactly
    // those ids (#2211 r3 `4011279296`).
    expect(outcome).toEqual({
      established: true,
      repairedLoanIds: [8],
      unestablishedLoanIds: [13, 99, 21],
    });
  });

  it('reports everything the pass noticed when it DIED on its cursor write', async () => {
    // THE REGRESSION. The old catch read `report.repaired` and nothing else,
    // so the orphan, the unread row and the unprojectable status all went
    // unsaid — and if only the lap-boundary write had failed, the rotation
    // had already moved past them.
    const { out, outcome } = await drive(async () => {
      throw new ReconcilePartialError(noticed(), new Error('pointer write failed'));
    });
    expect(out).toContain('99');
    expect(out.toLowerCase()).toContain('orphan');
    expect(out).toContain('13');
    expect(out).toContain('loan 21 = 7');
    // The repairs committed, so they are still announced (#2190 r6) — and
    // the tick counts as ESTABLISHED: those rows WERE checked against the
    // chain at a settled head, so the calendar sweep it gates must not be
    // deferred (#2211 r1) — but the rows it could not settle are still
    // withheld from it individually.
    expect(outcome).toEqual({
      established: true,
      repairedLoanIds: [8],
      unestablishedLoanIds: [13, 99, 21],
    });
  });

  it('says the SAME things either way, because one call says them', async () => {
    // The guarantee stated as an assertion: not "both endings remember to
    // report" but "no ending reports at all". Every line the reporter emits
    // for this report must appear whichever way the pass ended — a future
    // success-only guard fails here rather than quietly halving the output.
    const baseline = captured(noticed()).split('\n').filter(Boolean);
    expect(baseline.length).toBeGreaterThan(0);
    const finished = await drive(async () => noticed());
    const died = await drive(async () => {
      throw new ReconcilePartialError(noticed(), new Error('lap-boundary write failed'));
    });
    for (const line of baseline) {
      expect(finished.out).toContain(line);
      expect(died.out).toContain(line);
    }
  });

  it('names long-held rows without a chain, and outside the pass (#2213 r3)', async () => {
    // Rows in quarantine suppress reminders whatever a tick manages to do —
    // including during an RPC outage, when nothing is being re-examined and
    // the suppression is at its most invisible. So the naming lives at the
    // per-chain entry point, above the identity check, and reads D1 only.
    //
    // Round 2 put it at the top of the PASS and I called it unconditional; it
    // was unconditional within that function, and the identity check returns
    // before the function is reached. This case tests the claim one level up,
    // where it should have been tested first.
    const seen: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          seen.push(sql);
          return {
            bind: () => ({
              first: async () => ({ n: 0 }),
              all: async () => ({ results: [] }),
            }),
            first: async () => ({ name: 'loan_reconcile_quarantine' }),
          };
        },
      },
    } as unknown as Env;
    await _reportQuarantineForChain(env, CHAIN);
    // `FROM loan_reconcile_quarantine`, not merely the table's NAME: the
    // availability probe's own SQL mentions the name (in a `sqlite_master`
    // lookup), so the looser assertion passed with the report disabled —
    // found by mutation, and exactly the class of false pass this suite has
    // caught three times now.
    expect(seen.some((q) => /FROM\s+loan_reconcile_quarantine/.test(q))).toBe(true);
  });

  it('refuses outright on a head the chain did not call settled', async () => {
    // #2201. `latest - 32` is a finality GUESS, and this pass terminalizes
    // rows it then never selects again — so a reorg deeper than the margin
    // would publish an open position as closed, permanently, from the very
    // code that exists to end ghost rows. The gate lives inside the pass
    // rather than at its two call sites, so a third caller cannot be
    // written without it.
    scanBehaviour = async () => {
      throw new Error('the pass must not have got this far');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const outcome = await _runLoanReconcilePass({
      ...passInput(),
      head: {
        block: 100n,
        timestamp: 1_700_000_000n,
        settled: false,
        fallbackReason: 'TimeoutError',
      },
    });
    // NOT an empty repair list. A refusal must be distinguishable from a
    // clean pass, because what runs next mints unretractable reminders from
    // the very rows this did not check (#2211 r1 `4011103056`).
    expect(outcome.established).toBe(false);
    const out = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // SAID, not silently skipped — a check that quietly declines to run
    // reports perfect health while records stay wrong.
    expect(out).toContain('NOT RUNNING');
    // The PROVIDER'S reason, quoted. The fallback is taken on any failure of
    // the settled read, so an asserted cause would send an operator whose
    // RPC timed out to reconfigure an RPC that works.
    expect(out).toContain('TimeoutError');
  });

  it('refuses when the records run PAST the head, and says that is abnormal', async () => {
    // A provider swapped for one whose head trails our cursor would disable
    // reconciliation on this chain indefinitely. Worth a line every tick:
    // an operator seeing it repeatedly is seeing a stuck head, not weather.
    scanBehaviour = async () => {
      throw new Error('the pass must not have got this far');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const outcome = await _runLoanReconcilePass({ ...passInput(), readThrough: 140n });
    expect(outcome.established).toBe(false);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('SKIPPED');
    expect(said).toContain('140');
  });

  it('refuses QUIETLY when the records fall short, because that is a backfill', async () => {
    // Every catch-up tick is in this state and it resolves itself. Logging
    // it would bury the two conditions that do need an operator.
    scanBehaviour = async () => {
      throw new Error('the pass must not have got this far');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const outcome = await _runLoanReconcilePass({ ...passInput(), readThrough: 60n });
    expect(outcome.established).toBe(false);
    // Still refuses — the calendar sweep must wait either way.
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toBe('');
  });

  it('reports the SETTLED failure first when both conditions hold', async () => {
    // THE ORDER IS THE FIX (#2211 r2 `4011201404`). A guessed head lands
    // below the cursor, so the cursor test would fire first and blame a
    // regressed RPC head — sending an operator to investigate a head that is
    // behaving, when no settled block could be read at all.
    scanBehaviour = async () => {
      throw new Error('the pass must not have got this far');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const outcome = await _runLoanReconcilePass({
      ...passInput(),
      head: { block: 60n, timestamp: 1n, settled: false, fallbackReason: 'TimeoutError' },
      readThrough: 100n,
    });
    expect(outcome.established).toBe(false);
    if (!outcome.established) expect(outcome.reason).toContain('TimeoutError');
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('NOT RUNNING');
    expect(said).toContain('TimeoutError');
    expect(said).not.toContain('regressed RPC head');
  });

  it('counts a healthy pass that died on its cursor write as ESTABLISHED', async () => {
    // #2211 r4 `4011404507`. Nothing to repair is the ordinary state of a
    // healthy chain. The rows WERE checked against the chain at a settled
    // head; only the bookkeeping after them failed, and a report that
    // travels with the error says exactly which rows those were.
    const { out, outcome } = await drive(async () => {
      throw new ReconcilePartialError(report({ unread: [13] }), new Error('pointer write failed'));
    });
    expect(outcome.established).toBe(true);
    if (outcome.established) {
      expect(outcome.repairedLoanIds).toEqual([]);
      // The one row it could not settle is still withheld from reminders.
      expect(outcome.unestablishedLoanIds).toEqual([13]);
    }
    // AND IT IS NOT SWALLOWED (#2211 r5 `4011464228`). Establishing the rows
    // is the caller's answer; the failure is the operator's, and they are
    // independent. A pointer write that keeps failing stalls the rotation on
    // the same one or three rows forever, so silence here would report
    // health while later loans are never reached.
    expect(out).toContain('failed');
  });

  it('names a bookkeeping failure that repaired nothing and noticed nothing', async () => {
    // The quietest possible version, and the one that was swallowed: no
    // repairs, no row anomalies, so the reporter itself says nothing. If
    // this branch is silent too, a stalled rotation is invisible.
    const { out, outcome } = await drive(async () => {
      throw new ReconcilePartialError(report(), new Error('pointer write failed'));
    });
    expect(outcome.established).toBe(true);
    expect(out).toContain('rotation pointer did not advance');
    expect(out).toContain('pointer write failed');
  });

  it('still reports what it noticed when the failure is NOT a partial one', async () => {
    // No report to lift off an ordinary throw, so there is nothing to say —
    // but the pass must not wedge the tick, and must name the failure.
    const { out, outcome } = await drive(async () => {
      throw new Error('rpc exploded');
    });
    // Nothing was established: the pass threw before any repair landed, so
    // the live set is as unverified as if it had never run.
    expect(outcome.established).toBe(false);
    expect(out).toContain('rpc exploded');
  });
});
