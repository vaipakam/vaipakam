/**
 * The gate must fail CLOSED (#1961, and #822 in the retired app).
 *
 * These cases are exhaustive over the input space rather than a sample:
 * the decision has four booleans' worth of shape and one wrong cell is a
 * route-gate bypass with nothing behind it, so "every combination opens
 * the gate only where it should" is a property worth asserting outright
 * instead of picking the interesting ones and hoping.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_VERDICT_AGE_MS,
  isVerdictStale,
  opensGate,
  tosGateVerdict,
  type TosGateInput,
} from './tosGate';

const input = (over: Partial<TosGateInput> = {}): TosGateInput => ({
  connected: true,
  readOk: false,
  loading: false,
  accepted: false,
  ...over,
});

describe('tosGateVerdict', () => {
  it('passes an unconnected visitor through, whatever the read says', () => {
    for (const readOk of [false, true]) {
      for (const loading of [false, true]) {
        for (const accepted of [false, true]) {
          expect(
            tosGateVerdict(input({ connected: false, readOk, loading, accepted })),
          ).toBe('pass-unconnected');
        }
      }
    }
  });

  it('holds closed while a read is in flight', () => {
    // Including when a PREVIOUS read said accepted: a refetch in flight
    // is not a fresh verdict, and the version may have changed.
    expect(tosGateVerdict(input({ loading: true }))).toBe('checking');
    expect(tosGateVerdict(input({ loading: true, readOk: true, accepted: true }))).toBe(
      'checking',
    );
  });

  it('holds closed when the read failed', () => {
    // This is the bypass that matters: an RPC error is ordinary, and
    // failing open on one would unlock every gated route for anyone
    // whose read happens to fail.
    expect(tosGateVerdict(input({ readOk: false }))).toBe('unavailable');
    expect(tosGateVerdict(input({ readOk: false, accepted: true }))).toBe('unavailable');
  });

  it('prompts when a successful read says the wallet has not accepted', () => {
    expect(tosGateVerdict(input({ readOk: true, accepted: false }))).toBe('prompt');
  });

  it('passes only on a successful read that says accepted', () => {
    expect(tosGateVerdict(input({ readOk: true, accepted: true }))).toBe('pass');
  });

  it('opens the gate for exactly two verdicts, over the whole input space', () => {
    const opened: TosGateInput[] = [];
    for (const connected of [false, true]) {
      for (const readOk of [false, true]) {
        for (const loading of [false, true]) {
          for (const accepted of [false, true]) {
            const args = { connected, readOk, loading, accepted };
            if (opensGate(tosGateVerdict(args))) opened.push(args);
          }
        }
      }
    }
    // Every unconnected combination (8), plus the single connected case
    // of a settled, successful, accepted read.
    expect(opened.filter((a) => a.connected)).toEqual([
      { connected: true, readOk: true, loading: false, accepted: true },
    ]);
    expect(opened.filter((a) => !a.connected)).toHaveLength(8);
  });
});

describe('isVerdictStale', () => {
  const t0 = 1_700_000_000_000;

  it('treats a never-loaded verdict as stale', () => {
    // 0 means no successful read has landed. `readOk` covers that too,
    // but a helper that answered "fresh" here would be one wrong caller
    // away from opening on nothing.
    expect(isVerdictStale(0, t0)).toBe(true);
  });

  it('trusts a verdict inside the bound', () => {
    expect(isVerdictStale(t0, t0)).toBe(false);
    expect(isVerdictStale(t0, t0 + MAX_VERDICT_AGE_MS)).toBe(false);
  });

  it('stops trusting one past it', () => {
    expect(isVerdictStale(t0, t0 + MAX_VERDICT_AGE_MS + 1)).toBe(true);
  });

  it('is bounded well above the refresh interval', () => {
    // The hook polls every 60s. The bound has to exceed that with room
    // to spare, or an ordinary slow refresh would close the app on a
    // user who has done nothing wrong; and it has to be finite, or a
    // poll that has stopped landing would never be noticed.
    expect(MAX_VERDICT_AGE_MS).toBeGreaterThan(60_000 * 2);
    expect(Number.isFinite(MAX_VERDICT_AGE_MS)).toBe(true);
  });
});
