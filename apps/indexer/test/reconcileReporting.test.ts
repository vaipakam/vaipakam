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
import { _reportReconcilePass, _runLoanReconcilePass } from '../src/chainIndexer';
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
    head: 100n,
    budget: {},
  });

  /** Runs a whole pass and returns what the operator saw, plus what it returned. */
  async function drive(behaviour: () => Promise<ReconcileReport>) {
    scanBehaviour = behaviour;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warn.mockClear();
    error.mockClear();
    const ids = await _runLoanReconcilePass(passInput());
    const out = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');
    return { out, ids };
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
    const { out, ids } = await drive(async () => noticed());
    expect(out).toContain('99');
    expect(out).toContain('loan 21 = 7');
    expect(ids).toEqual([8]);
  });

  it('reports everything the pass noticed when it DIED on its cursor write', async () => {
    // THE REGRESSION. The old catch read `report.repaired` and nothing else,
    // so the orphan, the unread row and the unprojectable status all went
    // unsaid — and if only the lap-boundary write had failed, the rotation
    // had already moved past them.
    const { out, ids } = await drive(async () => {
      throw new ReconcilePartialError(noticed(), new Error('pointer write failed'));
    });
    expect(out).toContain('99');
    expect(out.toLowerCase()).toContain('orphan');
    expect(out).toContain('13');
    expect(out).toContain('loan 21 = 7');
    // The repairs committed, so they are still announced (#2190 r6).
    expect(ids).toEqual([8]);
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

  it('still reports what it noticed when the failure is NOT a partial one', async () => {
    // No report to lift off an ordinary throw, so there is nothing to say —
    // but the pass must not wedge the tick, and must name the failure.
    const { out, ids } = await drive(async () => {
      throw new Error('rpc exploded');
    });
    expect(ids).toEqual([]);
    expect(out).toContain('rpc exploded');
  });
});
