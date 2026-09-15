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
 * Both paths now call one function, so they cannot report different things.
 * These cases pin what that function says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _reportReconcilePass } from '../src/chainIndexer';
import type { ReconcileReport } from '../src/loanReconcile';

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

/** Everything written to warn+error, joined — the operator sees one stream. */
function captured(r: ReconcileReport): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
