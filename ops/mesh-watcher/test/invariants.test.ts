/**
 * Unit tests for the mesh watcher's checks.
 *
 * Testing discipline, because a watcher's tests are unusually prone to
 * passing for the wrong reason: a check that can never fire and a check
 * that always fires both look "green" if the assertions only count
 * findings. So —
 *
 * 1. The shared fixture is a HEALTHY mesh, and the first test asserts it
 *    produces ZERO findings. Every violation test mutates exactly one
 *    field off that baseline. If the baseline were quietly unhealthy,
 *    that first test fails and every other test's premise collapses
 *    visibly rather than silently.
 * 2. Violation tests assert the EXACT SET of codes produced, never
 *    `length > 0`. A check firing for an unintended reason therefore
 *    fails the test instead of satisfying it.
 * 3. Where two invariants genuinely cannot be violated independently
 *    (raising `retired` above `consumed` necessarily breaks the commit
 *    identity too), the test asserts both codes and says why.
 * 4. The ABI guard is tested against a deliberately drifted ABI, so it is
 *    proven to catch drift rather than merely to not throw.
 */

import { describe, expect, it } from 'vitest';
import type { Abi } from 'viem';
import {
  REWARD_AGGREGATOR_ABI,
  WATCHED_VIEWS,
  assertAbiShape,
} from '../src/abi';
import {
  checkHardInvariants,
  expectedAvail,
  asFreshSnapshot,
  fmt,
  lagPairs,
  reportLagConditions,
  satSub,
  stuckSettlementCondition,
  type BaseChainBooks,
  type LocalLedger,
  type FRESH,
  type MeshObservation,
} from '../src/invariants';
import {
  formatAlert,
  redactDeliveryError,
  sendOpsMessage,
} from '../src/telegram';
import { bearerToken, isAuthorized, secretsMatch } from '../src/auth';
import {
  readAlertRepeatSeconds,
  readConfig,
  readTelegramTarget,
} from '../src/env';
import {
  configuredRpcChainIds,
  credentialComponents,
  makeBaseRedactor,
  makeRedactor,
  stripUrlPaths,
} from '../src/redact';
import { stepSignal, type Observation } from '../src/signal';
import { hashIdentity, makeFinding } from '../src/finding';
import { assessHealth, statusFor } from '../src/health';
import { classify, describeFailure } from '../src/errors';
import { AlertStore, type StoreOp } from '../src/store';

const E = 1_000_000_000_000_000_000n; // 1 VPFI
const TOLERANCE = 1_000_000_000_000_000n; // 1e15 wei — the shipped default

const CANONICAL = 84532;
const MIRROR = 42161;
const NOW = 1_800_000_100;
const MAX_AGE = 300;

/** Brand a fixture through the real validating constructor. */
function fresh(raw: Omit<LocalLedger, FRESH>): LocalLedger {
  const v = asFreshSnapshot(raw, NOW, MAX_AGE);
  if ('stale' in v) throw new Error('fixture is stale — adjust NOW/observedAt');
  return v.fresh;
}

/** Books for the mirror — internally consistent by construction. */
function mirrorBooks(): BaseChainBooks {
  return {
    chainId: MIRROR,
    reported: 1000n * E,
    consumed: 400n * E,
    // reported - max(0, consumed - released) = 1000 - (400 - 100) = 700
    avail: 700n * E,
    attributed: 900n * E,
    retired: 250n * E,
    released: 100n * E,
    // consumed - retired = 400 - 250
    outstanding: 150n * E,
  };
}

/** Books Base keeps under its OWN chain id — inert by construction. */
function canonicalBooks(): BaseChainBooks {
  return {
    chainId: CANONICAL,
    reported: 500n * E,
    consumed: 0n,
    avail: 500n * E,
    attributed: 500n * E,
    retired: 0n,
    released: 0n,
    outstanding: 0n,
  };
}

/** Raw fixture; branded through the validating constructor below. */
function mirrorLocal(): LocalLedger {
  return fresh({
    chainId: MIRROR,
    custodyRelocated: 0n,
    bucket: 200n * E,
    reportedCumulative: 1000n * E,
    localRetired: 250n * E,
    localReleased: 100n * E,
    outstandingRecycled: 150n * E,
    outstandingFresh: 0n,
    armedFromDay: 3n,
    paidOutRecycled: 800n * E,
    observedAt: 1_800_000_000n,
  });
}

function canonicalLocal(): LocalLedger {
  return fresh({
    chainId: CANONICAL,
    custodyRelocated: 0n,
    bucket: 800n * E,
    reportedCumulative: 500n * E,
    localRetired: 0n,
    localReleased: 0n,
    outstandingRecycled: 300n * E,
    outstandingFresh: 50n * E,
    armedFromDay: 3n,
    paidOutRecycled: 0n,
    observedAt: 1_800_000_000n,
  });
}

interface Overrides {
  mirror?: Partial<BaseChainBooks>;
  canonical?: Partial<BaseChainBooks>;
  mirrorLocal?: Partial<LocalLedger> | null;
  canonicalLocal?: Partial<LocalLedger> | null;
}

function observation(o: Overrides = {}): MeshObservation {
  const freshLocals = new Map<number, LocalLedger>();
  const allLocals = new Map<number, Omit<LocalLedger, FRESH>>();
  if (o.mirrorLocal !== null) {
    const l = fresh({ ...mirrorLocal(), ...o.mirrorLocal });
    freshLocals.set(MIRROR, l);
    allLocals.set(MIRROR, l);
  }
  if (o.canonicalLocal !== null) {
    const l = fresh({ ...canonicalLocal(), ...o.canonicalLocal });
    freshLocals.set(CANONICAL, l);
    allLocals.set(CANONICAL, l);
  }
  return {
    canonicalChainId: CANONICAL,
    expectedChainIds: [CANONICAL, MIRROR],
    books: [
      { ...canonicalBooks(), ...o.canonical },
      { ...mirrorBooks(), ...o.mirror },
    ],
    freshLocals,
    allLocals,
    gaps: [],
  };
}

/** Sorted, de-duplicated finding codes — the assertion surface. */
function codes(o: Overrides = {}): string[] {
  return [
    ...new Set(checkHardInvariants(observation(o), TOLERANCE).map((f) => f.code)),
  ].sort();
}

describe('checkHardInvariants — baseline', () => {
  it('reports nothing on a healthy mesh', () => {
    // Load-bearing: every violation test below mutates one field off this
    // fixture, so a fixture that was already violating something would
    // make those tests pass without proving anything.
    expect(checkHardInvariants(observation(), TOLERANCE)).toEqual([]);
  });
});

describe('checkHardInvariants — commit identity', () => {
  it('fires when outstanding + retired no longer equals consumed', () => {
    expect(codes({ mirror: { outstanding: 150n * E + 1n } })).toEqual([
      'commit-identity',
    ]);
  });

  it('reports the signed difference so the operator can see the direction', () => {
    const [finding] = checkHardInvariants(
      observation({ mirror: { outstanding: 149n * E } }),
      TOLERANCE,
    );
    expect(finding?.code).toBe('commit-identity');
    expect(finding?.severity).toBe('critical');
    expect(finding?.detail).toContain('-1.000000 VPFI');
  });

  it('holds for the canonical chain, whose figures are all zero', () => {
    expect(codes()).toEqual([]);
  });
});

describe('checkHardInvariants — clamp chain', () => {
  it('fires when retirement exceeds what Base instructed', () => {
    // `retired > consumed` cannot be produced in isolation: the commit
    // identity (`outstanding + retired == consumed`) would need a negative
    // outstanding to absorb it. Both codes firing is the correct answer.
    // `localRetired` is raised alongside so `base-ahead-of-chain` — a
    // genuinely different fault — does not join in and mask which check
    // caught what.
    expect(
      codes({
        mirror: { retired: 401n * E },
        mirrorLocal: { localRetired: 401n * E },
      }),
    ).toEqual(['clamp-chain', 'commit-identity']);
  });

  it('fires when the release subset exceeds the retirement it subsets', () => {
    // Raising `released` changes availability too, so `avail` is moved to
    // its new correct value: this test is about the clamp, and leaving a
    // stale `avail` would make `availability-formula` fire and hide that.
    // reported - max(0, consumed - released) = 1000 - 0 = 1000
    expect(
      codes({
        mirror: { released: 500n * E, avail: 1000n * E },
        mirrorLocal: { localReleased: 500n * E },
      }),
    ).toEqual(['clamp-chain']);
  });

  it('accepts released exactly equal to retired', () => {
    expect(
      codes({
        mirror: { released: 250n * E, avail: 850n * E },
        mirrorLocal: { localReleased: 250n * E },
      }),
    ).toEqual([]);
  });
});

describe('checkHardInvariants — attribution ceiling', () => {
  it('fires when day credits exceed the reported cumulative', () => {
    expect(codes({ mirror: { attributed: 1000n * E + 1n } })).toEqual([
      'attribution-ceiling',
    ]);
  });

  it('accepts attribution exactly at the reported cumulative', () => {
    expect(codes({ mirror: { attributed: 1000n * E } })).toEqual([]);
  });
});

describe('checkHardInvariants — availability formula', () => {
  it('fires when the on-chain figure diverges from its definition', () => {
    expect(codes({ mirror: { avail: 700n * E + 1n } })).toEqual([
      'availability-formula',
    ]);
  });

  it('models the floor: released above consumed cannot inflate availability', () => {
    // Both subtractions saturate in `LibVpfiRecycle.mirrorAvailRecycled`.
    // A model that let `consumed - released` go negative would compute
    // 1000 - (-100) = 1100 here and fire on healthy state.
    expect(
      expectedAvail({
        ...mirrorBooks(),
        consumed: 100n * E,
        released: 200n * E,
      }),
    ).toBe(1000n * E);
  });

  it('floors at zero when consumption exceeds everything reported', () => {
    expect(
      expectedAvail({
        ...mirrorBooks(),
        reported: 10n * E,
        consumed: 400n * E,
        released: 0n,
      }),
    ).toBe(0n);
  });
});

describe('checkHardInvariants — base self-inertness', () => {
  it('fires when Base has booked a per-chain commitment against itself', () => {
    // `consumed` is moved with `outstanding` (and `avail` recomputed) so
    // the commit identity and the availability formula both still hold:
    // this test is about the canonical chain having ANY per-chain books,
    // not about those books being internally inconsistent.
    expect(
      codes({
        canonical: { consumed: 1n * E, outstanding: 1n * E, avail: 499n * E },
      }),
    ).toEqual(['base-self-inert']);
  });

  it('does not apply the rule to mirrors', () => {
    expect(codes()).toEqual([]);
  });
});

describe('checkHardInvariants — base ahead of the chain', () => {
  it('fires when Base holds a higher reported cumulative than the chain', () => {
    expect(codes({ mirrorLocal: { reportedCumulative: 1000n * E - 1n } })).toEqual(
      ['base-ahead-of-chain'],
    );
  });

  it('fires when Base holds a higher retirement cumulative than the chain', () => {
    expect(codes({ mirrorLocal: { localRetired: 249n * E } })).toEqual([
      'base-ahead-of-chain',
    ]);
  });

  it('fires when Base holds a higher release cumulative than the chain', () => {
    expect(codes({ mirrorLocal: { localReleased: 99n * E } })).toEqual([
      'base-ahead-of-chain',
    ]);
  });

  it('accepts Base trailing the chain — that is the normal report lag', () => {
    expect(
      codes({
        mirrorLocal: {
          reportedCumulative: 5000n * E,
          localRetired: 4000n * E,
          localReleased: 3000n * E,
        },
      }),
    ).toEqual([]);
  });

  it('skips the cross-chain checks when the chain is unreachable', () => {
    // An unreachable mirror must not silently pass as healthy on the
    // cross-chain checks, but it also must not crash the Base-side ones.
    expect(codes({ mirrorLocal: null })).toEqual([]);
  });
});

describe('checkHardInvariants — bucket coverage', () => {
  it('fires when the bucket cannot back the chain reservations', () => {
    expect(
      codes({ mirrorLocal: { bucket: 150n * E - TOLERANCE - 1n } }),
    ).toEqual(['bucket-coverage']);
  });

  it('does not fire at exactly the tolerance boundary', () => {
    // The tolerance exists because `LibVpfiRecycle.consume` floors the
    // bucket at zero for cap-trim dust. Firing at the boundary would make
    // that documented dust pageable.
    expect(codes({ mirrorLocal: { bucket: 150n * E - TOLERANCE } })).toEqual([]);
  });

  it('checks the canonical chain by the same rule', () => {
    expect(codes({ canonicalLocal: { bucket: 0n } })).toEqual([
      'bucket-coverage',
    ]);
  });

  it('reports the shortfall and the relocated-custody context', () => {
    const [finding] = checkHardInvariants(
      observation({
        mirrorLocal: { bucket: 100n * E, custodyRelocated: 30n * E },
      }),
      TOLERANCE,
    );
    expect(finding?.code).toBe('bucket-coverage');
    expect(finding?.chainId).toBe(MIRROR);
    expect(finding?.detail).toContain('50.000000 VPFI'); // 150 - 100
    expect(finding?.detail).toContain('30.000000 VPFI'); // relocated
  });

  it('is not evaluated for a chain that could not be read', () => {
    expect(codes({ mirrorLocal: null, canonicalLocal: null })).toEqual([]);
  });
});

describe('checkHardInvariants — consumed cap (governor §7 #6)', () => {
  it('fires when instructions exceed what the chain reported', () => {
    // Independent of the availability formula on purpose: that formula
    // SATURATES, so an over-instruction floors `avail` to zero, the
    // on-chain figure agrees, and every other check stays green (Codex
    // #1443 r4). consumed - released = 1200 - 100 = 1100 > reported 1000.
    expect(
      codes({
        mirror: {
          consumed: 1200n * E,
          outstanding: 950n * E, // keeps the commit identity intact
          avail: 0n, // the saturated value — genuinely what chain returns
        },
      }),
    ).toEqual(['consumed-cap']);
  });

  it('accepts the bound exactly at equality', () => {
    // consumed - released = 1100 - 100 = 1000 == reported
    expect(
      codes({
        mirror: {
          consumed: 1100n * E,
          outstanding: 850n * E,
          avail: 0n,
        },
      }),
    ).toEqual([]);
  });

  it('accepts a near-max reported cumulative, as the on-chain bound does', () => {
    // The contracts express this bound by SUBTRACTION because
    // `reported + released` overflows uint256 on a near-max report. JS
    // bigint does not overflow, so this does not reproduce that — it
    // pins the watcher to the same DOMAIN the on-chain invariant accepts,
    // so the two cannot quietly diverge and have the divergence read as
    // a ledger fault.
    const huge = 2n ** 255n;
    expect(
      codes({
        mirror: {
          reported: huge,
          consumed: 400n * E,
          released: 100n * E,
          retired: 250n * E,
          outstanding: 150n * E,
          attributed: 0n,
          avail: huge - 300n * E,
        },
        // Base's copy can never exceed the chain's own — raise it too, or
        // `base-ahead-of-chain` fires and masks what this test is about.
        mirrorLocal: { reportedCumulative: huge },
      }),
    ).toEqual([]);
  });
});

describe('stepSignal — the windowed-signal rules, stated once', () => {
  const holds = (marker: string): Observation => ({ state: 'holds', marker });

  it('clears rather than decrements when the condition stops holding', () => {
    expect(stepSignal({ marker: 'x', streak: 5 }, { state: 'clear' }, 3, true)).toEqual({
      transition: { action: 'clear' },
      fire: false,
    });
  });

  it('KEEPS the run on an UNKNOWN observation — never clears it', () => {
    // The distinction that six findings kept rediscovering: a missing or
    // untrustworthy read is not evidence that the condition ended. Both
    // sides are monotonic, so the next real observation decides.
    expect(stepSignal({ marker: 'x', streak: 5 }, { state: 'unknown' }, 3, true)).toEqual({
      transition: { action: 'keep' },
      fire: false,
    });
  });

  it('starts at one on the first observation', () => {
    expect(stepSignal(null, holds('x'), 3, true).transition).toEqual({
      action: 'save',
      state: { marker: 'x', streak: 1 },
    });
  });

  it('accumulates while the marker is unchanged', () => {
    expect(stepSignal({ marker: 'x', streak: 1 }, holds('x'), 3, true).transition).toEqual({
      action: 'save',
      state: { marker: 'x', streak: 2 },
    });
  });

  it('restarts when the marker moves — progress ends the run', () => {
    expect(stepSignal({ marker: 'x', streak: 9 }, holds('y'), 3, true)).toEqual({
      transition: { action: 'save', state: { marker: 'y', streak: 1 } },
      fire: false,
    });
  });

  it('fires on reaching the window and keeps firing after it', () => {
    expect(stepSignal({ marker: 'x', streak: 2 }, holds('x'), 3, true).fire).toBe(true);
    expect(stepSignal({ marker: 'x', streak: 40 }, holds('x'), 3, true).fire).toBe(true);
  });

  describe('non-counting observations (manual runs)', () => {
    it('does not contribute to the run', () => {
      expect(stepSignal({ marker: 'x', streak: 5 }, holds('x'), 6, false)).toEqual({
        transition: { action: 'keep' },
        fire: false,
      });
    });

    it('still fires when the STORED run already met the window', () => {
      expect(stepSignal({ marker: 'x', streak: 6 }, holds('x'), 6, false).fire).toBe(true);
    });

    it('does not fire against a run for a different marker', () => {
      expect(stepSignal({ marker: 'old', streak: 99 }, holds('new'), 6, false).fire).toBe(
        false,
      );
    });

    it('does not delete the run when the condition stops holding', () => {
      expect(
        stepSignal({ marker: 'x', streak: 3 }, { state: 'clear' }, 6, false).transition,
      ).toEqual({ action: 'keep' });
    });
  });
});

describe('stuckSettlementCondition', () => {
  it('does not hold when the CHAIN has nothing outstanding', () => {
    expect(
      stuckSettlementCondition(mirrorBooks(), {
        ...mirrorLocal(),
        outstandingRecycled: 0n,
      }).holds,
    ).toBe(false);
  });

  it('reads BOTH halves from the same ledger', () => {
    // Mixing them — Base's outstanding against the chain's own retirement
    // — is a guaranteed false positive: a mirror that retires everything
    // between day-closes zeroes its local reservation immediately while
    // Base's copy stays positive until the next report lands (Codex
    // #1443 r4). Base still showing 150 outstanding must not make a chain
    // with zero outstanding look stuck.
    const settled = stuckSettlementCondition(
      { ...mirrorBooks(), outstanding: 150n * E },
      { ...mirrorLocal(), outstandingRecycled: 0n },
    );
    expect(settled.holds).toBe(false);
    expect(settled.source).toBe('chain');
  });

  it('judges the Base-only fallback on the report-cycle window', () => {
    // Both figures then move solely through day-close reports, so the
    // short window would fire once per cycle on a healthy chain.
    expect(stuckSettlementCondition(mirrorBooks(), undefined).windowKind).toBe(
      'report-cycle',
    );
    expect(stuckSettlementCondition(mirrorBooks(), mirrorLocal()).windowKind).toBe(
      'local',
    );
  });

  it('holds while a reservation is open', () => {
    expect(stuckSettlementCondition(mirrorBooks(), mirrorLocal()).holds).toBe(
      true,
    );
  });

  it('keys the run on the CHAIN’S OWN retirement when reachable', () => {
    // Deliberately different from Base's copy: reading Base's figure here
    // would conflate stuck settlement with a stalled report pipeline,
    // which is what the separate report-lag signal is for.
    const result = stuckSettlementCondition(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 999n * E,
    });
    expect(result.source).toBe('chain');
    expect(result.marker).toBe(`chain:${999n * E}`);
  });

  it('falls back to Base’s copy when the chain is unreachable', () => {
    const result = stuckSettlementCondition(mirrorBooks(), undefined);
    expect(result.source).toBe('base');
    expect(result.marker).toBe(`base:${250n * E}`);
  });

  it('restarts the run when the SOURCE changes, even at an equal figure', () => {
    // A chain unreachable for a while builds a Base-fallback run judged
    // on the long window; if its local retirement happened to equal
    // Base's last reported figure, the run would carry over and fire
    // immediately on the SHORT window at the first healthy read
    // (Codex #1443 r5). The source prefix makes that impossible.
    const viaBase = stuckSettlementCondition(mirrorBooks(), undefined);
    const viaChain = stuckSettlementCondition(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 250n * E, // deliberately EQUAL to Base's copy
    });
    expect(viaChain.marker).not.toBe(viaBase.marker);
  });

  it('does NOT key on released — a chain that only pays claims never releases', () => {
    // The settled condition (plan §M7, Codex #1439 r6-r8): keying on
    // `consumed - released` fires forever on healthy paid settlement.
    // A chain whose retirement advances entirely through claims must
    // therefore change the marker even with `released` frozen at zero.
    const a = stuckSettlementCondition(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 250n * E,
      localReleased: 0n,
    });
    const b = stuckSettlementCondition(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 260n * E,
      localReleased: 0n,
    });
    expect(a.marker).not.toBe(b.marker);
  });
});

describe('reportLagConditions', () => {
  const byLabel = (
    books = mirrorBooks(),
    local: LocalLedger | undefined = mirrorLocal(),
  ) => Object.fromEntries(reportLagConditions(books, local).map((c) => [c.label, c]));

  it('holds for no cumulative when the chain is unreachable', () => {
    const all = reportLagConditions(mirrorBooks(), undefined);
    expect(all.every((c) => !c.holds)).toBe(true);
  });

  it('holds for none when Base is level with the chain', () => {
    expect(reportLagConditions(mirrorBooks(), mirrorLocal()).every((c) => !c.holds)).toBe(
      true,
    );
  });

  it('holds ONLY for the cumulative that trails', () => {
    const c = byLabel(mirrorBooks(), { ...mirrorLocal(), localRetired: 260n * E });
    expect(c.retired?.holds).toBe(true);
    expect(c.absorption?.holds).toBe(false);
    expect(c.released?.holds).toBe(false);
  });

  it('tracks each run on its OWN field, so an unrelated advance cannot reset it', () => {
    // The load-bearing property (Codex #1443 r5). With one combined
    // marker, retirement ingestion being permanently broken went
    // undetected: ordinary daily reports advanced absorption, the shared
    // marker changed every report, and the run reset before its window
    // could elapse.
    const before = byLabel(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 260n * E,
    });
    const afterAbsorptionAdvanced = byLabel(
      { ...mirrorBooks(), reported: 5000n * E },
      { ...mirrorLocal(), reportedCumulative: 5000n * E, localRetired: 260n * E },
    );
    // Base's retirement did not move, so the retirement run continues.
    expect(afterAbsorptionAdvanced.retired?.marker).toBe(before.retired?.marker);
  });

  it('restarts a run when BASE advances that field', () => {
    const a = byLabel(mirrorBooks(), { ...mirrorLocal(), localRetired: 260n * E });
    const b = byLabel(
      { ...mirrorBooks(), retired: 255n * E },
      { ...mirrorLocal(), localRetired: 260n * E },
    );
    expect(a.retired?.marker).not.toBe(b.retired?.marker);
  });

  it('keys each run on Base’s side of that field alone', () => {
    const a = byLabel(mirrorBooks(), { ...mirrorLocal(), reportedCumulative: 1500n * E });
    const b = byLabel(mirrorBooks(), { ...mirrorLocal(), reportedCumulative: 2500n * E });
    expect(a.absorption?.marker).toBe(b.absorption?.marker);
  });
});

describe('formatting helpers', () => {
  it('renders whole and fractional VPFI', () => {
    expect(fmt(0n)).toBe('0.000000 VPFI');
    expect(fmt(1n * E)).toBe('1.000000 VPFI');
    expect(fmt(1_500_000_000_000_000_000n)).toBe('1.500000 VPFI');
  });

  it('renders negatives, which the identity check needs for direction', () => {
    expect(fmt(-1n * E)).toBe('-1.000000 VPFI');
  });

  it('never DISCARDS sub-micro digits — it appends the exact wei', () => {
    // These are exact invariants; a one-wei break formatted as
    // `0.000000 VPFI` next to identical operands deletes the only
    // evidence the operator has (Codex #1443 r1).
    expect(fmt(1n)).toBe('0.000000 VPFI (exactly 1 wei)');
    expect(fmt(-1n)).toBe('-0.000000 VPFI (exactly -1 wei)');
  });

  it('omits the exact suffix when nothing is lost', () => {
    expect(fmt(1n * E)).not.toContain('exactly');
    expect(fmt(1_500_000_000_000_000_000n)).not.toContain('exactly');
  });

  it('saturates subtraction like the contracts do', () => {
    expect(satSub(1n, 5n)).toBe(0n);
    expect(satSub(5n, 1n)).toBe(4n);
  });
});

describe('formatAlert', () => {
  // These lock the PLAIN-TEXT decision in. Alert bodies carry chain slugs
  // and raw RPC error strings — text this Worker does not author. Under a
  // markup mode each needs escaping, and an escape that misses one
  // metacharacter lets the input break back out, mangling the alert
  // exactly when something is already going wrong. Reintroducing markup
  // without escaping should turn these red.
  const withMetachars = {
    severity: 'critical' as const,
    title: 'Bucket *short* by _a lot_',
    chainLabel: 'arb-sepolia [42161]',
    detail: 'error: `eth_call` failed\\nbackslash \\ and ``` fence',
    footer: 'see #1442 for the [qualifier]',
  };

  it('passes markup metacharacters through verbatim', () => {
    const out = formatAlert(withMetachars);
    expect(out).toContain('Bucket *short* by _a lot_');
    expect(out).toContain('arb-sepolia [42161]');
    expect(out).toContain('backslash \\ and ``` fence');
    expect(out).toContain('see #1442 for the [qualifier]');
  });

  it('adds no escape sequences of its own', () => {
    // One backslash in, one backslash out. An escaper would double it.
    const out = formatAlert(withMetachars);
    expect(out.match(/\\/g)?.length).toBe(
      withMetachars.detail.match(/\\/g)?.length,
    );
  });

  it('wraps the detail in no code fence', () => {
    const out = formatAlert({ ...withMetachars, detail: 'plain detail' });
    expect(out).not.toContain('```\nplain detail');
  });

  it('marks severity distinguishably and includes the chain', () => {
    expect(formatAlert({ ...withMetachars, severity: 'critical' })).toContain(
      'CRITICAL',
    );
    expect(formatAlert({ ...withMetachars, severity: 'advisory' })).toContain(
      'ADVISORY',
    );
  });

  it('omits the footer block when there is no footer', () => {
    const out = formatAlert({
      severity: 'advisory',
      title: 't',
      chainLabel: 'c',
      detail: 'd',
    });
    expect(out.endsWith('d')).toBe(true);
  });
});

describe('checkHardInvariants — dedup keys', () => {
  it('gives every violation on a chain its own key', () => {
    // Several checks can fire more than once per chain in one tick. When
    // they shared `code:chainId`, the delivery map kept only the last and
    // the earlier violation's figures were never sent (Codex #1443 r1).
    const findings = checkHardInvariants(
      observation({
        mirrorLocal: {
          reportedCumulative: 1n,
          localRetired: 1n,
          localReleased: 1n,
        },
      }),
      TOLERANCE,
    );
    const baseAhead = findings.filter((f) => f.code === 'base-ahead-of-chain');
    expect(baseAhead).toHaveLength(3);
    expect(new Set(baseAhead.map((f) => f.key)).size).toBe(3);
  });

  it('never emits two findings sharing one key', () => {
    const findings = checkHardInvariants(
      observation({
        mirror: { retired: 401n * E, released: 401n * E },
        mirrorLocal: { localRetired: 401n * E, localReleased: 401n * E },
      }),
      TOLERANCE,
    );
    expect(new Set(findings.map((f) => f.key)).size).toBe(findings.length);
  });
});

describe('checkHardInvariants — bucket coverage severity by chain role', () => {
  it('is CRITICAL on a mirror', () => {
    const [finding] = checkHardInvariants(
      observation({ mirrorLocal: { bucket: 0n } }),
      TOLERANCE,
    );
    expect(finding?.code).toBe('bucket-coverage');
    expect(finding?.severity).toBe('critical');
  });

  it('is ADVISORY on the canonical chain — released remits do this legitimately', () => {
    // `releaseRemitReservation` restores `outstandingCommitRecycled` in
    // full but deliberately does NOT re-credit `recycleBucket`: those
    // tokens are locked in the CCIP pool, outside Diamond custody. Paging
    // on the contract's intended recovery state would be a false alarm on
    // correct behaviour (Codex #1443 r1).
    const [finding] = checkHardInvariants(
      observation({ canonicalLocal: { bucket: 0n } }),
      TOLERANCE,
    );
    expect(finding?.code).toBe('bucket-coverage');
    expect(finding?.chainId).toBe(CANONICAL);
    expect(finding?.severity).toBe('advisory');
    expect(finding?.detail).toContain('released');
  });
});

describe('reportLagConditions — per-cumulative coverage', () => {
  const holds = (local: Partial<LocalLedger>) =>
    Object.fromEntries(
      reportLagConditions(mirrorBooks(), { ...mirrorLocal(), ...local }).map((c) => [
        c.label,
        c.holds,
      ]),
    );

  it('detects a retirement-only lag, with absorption level', () => {
    // A quiet-but-settling chain: claims and forfeits advance while
    // absorption stays flat. Watching `reported` alone never started the
    // run even though Base was missing newer reports (Codex #1443 r1).
    expect(holds({ localRetired: 260n * E }).retired).toBe(true);
  });

  it('detects a release-only lag', () => {
    expect(holds({ localReleased: 110n * E }).released).toBe(true);
  });

  it('detects an absorption-only lag', () => {
    expect(holds({ reportedCumulative: 1500n * E }).absorption).toBe(true);
  });

  it('detects several at once, independently', () => {
    const h = holds({ reportedCumulative: 1500n * E, localReleased: 110n * E });
    expect(h.absorption).toBe(true);
    expect(h.released).toBe(true);
    expect(h.retired).toBe(false);
  });
});

describe('run-endpoint authorization', () => {
  const req = (auth?: string): Request =>
    new Request('https://example.com/run', {
      method: 'POST',
      headers: auth === undefined ? {} : { authorization: auth },
    });

  it('is CLOSED when no token is configured', () => {
    // Fail-closed. Treating "unset" as "open" is how a public trigger
    // ships by accident (Codex #1443 r1).
    expect(isAuthorized(req('Bearer anything'), {} as never)).toBe(false);
    expect(isAuthorized(req('Bearer '), { WATCHER_RUN_TOKEN: '' } as never)).toBe(
      false,
    );
  });

  it('rejects a missing or malformed header', () => {
    const env = { WATCHER_RUN_TOKEN: 's3cret' } as never;
    expect(isAuthorized(req(), env)).toBe(false);
    expect(isAuthorized(req('s3cret'), env)).toBe(false);
    expect(isAuthorized(req('Basic s3cret'), env)).toBe(false);
  });

  it('rejects a wrong token, including a correct PREFIX', () => {
    const env = { WATCHER_RUN_TOKEN: 's3cret' } as never;
    expect(isAuthorized(req('Bearer s3cre'), env)).toBe(false);
    expect(isAuthorized(req('Bearer s3cretX'), env)).toBe(false);
    expect(isAuthorized(req('Bearer S3CRET'), env)).toBe(false);
  });

  it('accepts the exact token, scheme case-insensitively', () => {
    const env = { WATCHER_RUN_TOKEN: 's3cret' } as never;
    expect(isAuthorized(req('Bearer s3cret'), env)).toBe(true);
    expect(isAuthorized(req('bearer s3cret'), env)).toBe(true);
  });

  it('compares secrets without short-circuiting on the first difference', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });

  it('parses the bearer value', () => {
    expect(bearerToken(null)).toBe('');
    expect(bearerToken('Bearer  tok  ')).toBe('tok');
    expect(bearerToken('Bearer')).toBe('');
  });
});

describe('assertAbiShape', () => {
  it('passes against the compiled facet ABI', () => {
    expect(() => assertAbiShape()).not.toThrow();
  });

  it('watches every view the readers call', () => {
    expect(WATCHED_VIEWS).toContain('getChainRecycledLedger');
    expect(WATCHED_VIEWS).toContain('getRecycleCustodyPosition');
    expect(WATCHED_VIEWS).toContain('getGovernorCommitState');
  });

  it('catches a dropped output — the field-shift failure mode', () => {
    // Proves the guard is not vacuous. Without this the assertion could
    // be checking nothing at all and still "pass" above.
    const drifted = REWARD_AGGREGATOR_ABI.map((item) =>
      item.type === 'function' && item.name === 'getChainRecycledLedger'
        ? { ...item, outputs: item.outputs.slice(0, 3) }
        : item,
    ) as Abi;
    expect(() => assertAbiShape(drifted)).toThrow(/getChainRecycledLedger/);
  });

  it('catches a renamed output', () => {
    const drifted = REWARD_AGGREGATOR_ABI.map((item) =>
      item.type === 'function' && item.name === 'getRecycleCustodyPosition'
        ? {
            ...item,
            outputs: item.outputs.map((o, i) =>
              i === 1 ? { ...o, name: 'balance' } : o,
            ),
          }
        : item,
    ) as Abi;
    expect(() => assertAbiShape(drifted)).toThrow(/getRecycleCustodyPosition/);
  });

  it('catches a removed view', () => {
    const drifted = REWARD_AGGREGATOR_ABI.filter(
      (item) =>
        !(item.type === 'function' && item.name === 'getGovernorCommitState'),
    ) as Abi;
    expect(() => assertAbiShape(drifted)).toThrow(/missing from the compiled ABI/);
  });
});

// ─── D1 statement builders + dedup candidates ─────────────────────────
//
// A tiny fake D1 that records the SQL and bindings each builder produces.
// These functions encode "which rows get deleted", which is exactly the
// kind of logic that is easy to write backwards and impossible to notice
// until a stale row suppresses a real alert.

describe('AlertStore — storage that cannot throw', () => {
  // ROOT-CAUSE FIX #2. Five findings came from a D1 rejection escaping
  // to the tick's outer catch and destroying already-computed evidence.
  // These assert the boundary holds for every method, including the one
  // that BUILDS statements — construction outside the guard was the
  // fifth escape.
  const exploding = {
    prepare() {
      throw new Error('D1_ERROR: database is unavailable');
    },
    batch() {
      throw new Error('D1_ERROR: database is unavailable');
    },
  } as unknown as D1Database;

  it('returns a failure from loadStreaks instead of throwing', async () => {
    const r = await new AlertStore(exploding).loadStreaks('sig');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('storage');
  });

  it('returns a failure from selectDue instead of throwing', async () => {
    const r = await new AlertStore(exploding).selectDue(
      [{ key: 'k', fingerprint: 'f' }],
      100,
      0,
    );
    expect(r.ok).toBe(false);
  });

  it('returns a failure from commit — including STATEMENT CONSTRUCTION', async () => {
    // `prepare` throws here, which is construction, not execution. The
    // ops are data precisely so this happens inside the guard.
    const ops: StoreOp[] = [
      { kind: 'pruneStreaks', keepChainIds: [1, 2] },
      { kind: 'retainAlerts', keepKeys: ['a'] },
    ];
    const r = await new AlertStore(exploding).commit(ops);
    expect(r.ok).toBe(false);
  });

  it('is a no-op for an empty op list', async () => {
    expect((await new AlertStore(exploding).commit([])).ok).toBe(true);
  });
});

describe('assessHealth — preconditions, not a boolean expression', () => {
  const healthy = {
    criticalFindings: 0,
    deliveryConfigured: true,
    deliveryFailures: 0,
    deliveryVerified: true,
    coverageGaps: 0,
    stateDegraded: false,
  };

  it('is ok when every precondition holds', () => {
    expect(assessHealth(healthy)).toEqual({ ok: true, failing: [] });
  });

  it('names WHICH precondition failed', () => {
    const h = assessHealth({ ...healthy, coverageGaps: 2 });
    expect(h.ok).toBe(false);
    expect(h.failing.join(' ')).toContain('mesh-covered');
  });

  it('fails on each input independently', () => {
    expect(assessHealth({ ...healthy, criticalFindings: 1 }).ok).toBe(false);
    expect(assessHealth({ ...healthy, deliveryConfigured: false }).ok).toBe(false);
    expect(assessHealth({ ...healthy, deliveryFailures: 1 }).ok).toBe(false);
    expect(assessHealth({ ...healthy, deliveryVerified: false }).ok).toBe(false);
    expect(assessHealth({ ...healthy, stateDegraded: true }).ok).toBe(false);
  });

  it('treats an unexercised probe as acceptable', () => {
    expect(assessHealth({ ...healthy, deliveryVerified: null }).ok).toBe(true);
  });

  it('derives the HTTP status from health, never restated', () => {
    expect(statusFor({ ok: true, failing: [] }, false)).toBe(200);
    expect(statusFor({ ok: false, failing: ['x'] }, false)).toBe(503);
    expect(statusFor({ ok: true, failing: [] }, true)).toBe(500);
  });
});

describe('classify — third-party text is never forwarded', () => {
  // ROOT-CAUSE FIX #1. Four rounds found four leak paths, each a
  // provider message forwarded outward. Classification means there is no
  // provider text to leak in the first place.
  const SECRET = 'https://base.example/v2/SUPERSECRETKEY';

  it('never echoes the original message', () => {
    const err = new Error(`HTTP request failed. URL: ${SECRET}`);
    const summary = describeFailure(classify(err, 'reading chain 8453'));
    expect(summary).not.toContain('SUPERSECRETKEY');
    expect(summary).not.toContain(SECRET);
    expect(summary).toContain('reading chain 8453');
  });

  it('recognises a timeout', () => {
    const err = new Error('boom');
    err.name = 'AbortError';
    expect(classify(err).kind).toBe('timeout');
  });

  it('recognises an HTTP status from the cause chain', () => {
    const f = classify({ cause: { status: 429, message: SECRET } });
    expect(f.kind).toBe('http');
    expect(f.status).toBe(429);
    expect(describeFailure(f)).toContain('rate limited');
    expect(describeFailure(f)).not.toContain('SUPERSECRETKEY');
  });

  it('recognises a decode failure and points at the ABI', () => {
    expect(describeFailure(classify(new Error('abi decode failed')))).toContain(
      'facet re-export',
    );
  });

  it('falls back to a safe unknown, still without the message', () => {
    const f = classify(new Error(`totally novel ${SECRET}`));
    expect(f.kind).toBe('unknown');
    expect(describeFailure(f)).not.toContain('SUPERSECRETKEY');
  });
});

describe('makeFinding — identity is derived, never hand-built', () => {
  const base = {
    code: 'c',
    variant: 'v',
    severity: 'advisory' as const,
    chainId: 1,
    title: 't',
  };

  it('derives the dedup key from code, variant and chain', () => {
    expect(makeFinding({ ...base, detail: 'd', identity: ['x'] }).key).toBe('c/v:1');
  });

  it('gives two variants on one chain DIFFERENT keys', () => {
    // Three rounds of collisions came from this being hand-written.
    const a = makeFinding({ ...base, variant: 'one', detail: 'd', identity: ['x'] });
    const b = makeFinding({ ...base, variant: 'two', detail: 'd', identity: ['x'] });
    expect(a.key).not.toBe(b.key);
  });

  it('IGNORES the rendered detail when fingerprinting', () => {
    // The fingerprint bugs all came from `detail` being the default:
    // observation counts and ages rise every tick and defeated the quiet
    // window entirely.
    const a = makeFinding({ ...base, detail: 'flat for 6 observations', identity: ['x'] });
    const b = makeFinding({ ...base, detail: 'flat for 7 observations', identity: ['x'] });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('re-alerts when the IDENTITY figures move', () => {
    const a = makeFinding({ ...base, detail: 'd', identity: ['x'] });
    const b = makeFinding({ ...base, detail: 'd', identity: ['y'] });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('separates findings that differ only by variant or chain', () => {
    const a = makeFinding({ ...base, detail: 'd', identity: ['x'] });
    const b = makeFinding({ ...base, chainId: 2, detail: 'd', identity: ['x'] });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('hashes bigints and numbers stably', () => {
    expect(hashIdentity([1n, 2, 'a'])).toBe(hashIdentity([1n, 2, 'a']));
    expect(hashIdentity([1n])).not.toBe(hashIdentity([2n]));
  });
});

describe('readTelegramTarget — independent of the rest of the config', () => {
  // The failure path needs to page the operator precisely when the rest
  // of the configuration is unparseable. An earlier version derived the
  // destination through `readConfig`, so a malformed knob made the
  // recovery path throw a second time, yield null, and leave the watcher
  // silently blind with only a Cloudflare log (Codex #1443 r1).
  it('resolves even when readConfig would throw', () => {
    const broken = {
      TG_OPS_BOT_TOKEN: 'tok',
      TG_OPS_CHAT_ID: '-100',
      // Both of these make readConfig throw.
      CANONICAL_CHAIN_ID: 'not-a-number',
      STUCK_WINDOW_TICKS: '0',
    } as never;
    expect(() => readConfig(broken)).toThrow();
    expect(readTelegramTarget(broken)).toEqual({
      token: 'tok',
      chatId: '-100',
    });
  });

  it('is null when either half is missing', () => {
    expect(readTelegramTarget({ TG_OPS_BOT_TOKEN: 'tok' } as never)).toBeNull();
    expect(readTelegramTarget({ TG_OPS_CHAT_ID: '-100' } as never)).toBeNull();
    expect(readTelegramTarget({} as never)).toBeNull();
  });

  it('rejects a zero or negative window rather than silently defaulting', () => {
    expect(() =>
      readConfig({
        CANONICAL_CHAIN_ID: '8453',
        STUCK_WINDOW_TICKS: '0',
      } as never),
    ).toThrow(/STUCK_WINDOW_TICKS/);
  });
});

describe('lagPairs — the alert must show what ACTUALLY lags', () => {
  // Rendering the absorption pair alone printed `behind by = 0` whenever
  // retirement or release was the trigger, leaving the operator with no
  // evidence of the lag that fired the advisory (Codex #1443 r2).
  it('flags only the cumulative that is behind', () => {
    const pairs = lagPairs(mirrorBooks(), {
      ...mirrorLocal(),
      localRetired: 260n * E,
    });
    expect(pairs.map((p) => [p.label, p.behind])).toEqual([
      ['absorption', false],
      ['retired', true],
      ['released', false],
    ]);
  });

  it('carries both sides of every pair, not just the lagging one', () => {
    const pairs = lagPairs(mirrorBooks(), mirrorLocal());
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => !p.behind)).toBe(true);
    const released = pairs.find((p) => p.label === 'released');
    expect(released?.base).toBe(100n * E);
    expect(released?.chain).toBe(100n * E);
  });

  it('flags several at once', () => {
    const pairs = lagPairs(mirrorBooks(), {
      ...mirrorLocal(),
      reportedCumulative: 2000n * E,
      localReleased: 150n * E,
    });
    expect(pairs.filter((p) => p.behind).map((p) => p.label)).toEqual([
      'absorption',
      'released',
    ]);
  });
});

describe('base-self-inert scope', () => {
  it('ignores absorption, attribution and capacity under the canonical id', () => {
    // Base records its OWN chain in the ledger at day-close, so these are
    // legitimately non-zero under its own id — only the per-chain
    // COMMITMENT fields must stay zero (Codex #1443 r2).
    expect(
      codes({
        canonical: {
          reported: 9_999n * E,
          attributed: 9_999n * E,
          avail: 9_999n * E,
        },
        // Base's own copy can never exceed its own local ledger — that is
        // `base-ahead-of-chain`, a different (and real) fault. Raise the
        // local figure alongside so this test isolates self-inertness.
        canonicalLocal: { reportedCumulative: 9_999n * E },
      }),
    ).toEqual([]);
  });

  it('still fires on a per-chain commitment booked against itself', () => {
    expect(
      codes({
        canonical: { consumed: 1n * E, outstanding: 1n * E, avail: 499n * E },
      }),
    ).toEqual(['base-self-inert']);
  });
});

describe('report-lag window sizing', () => {
  it('defaults to more than one full day-close cycle', () => {
    // These cumulatives travel only in the day-close report, so between
    // reports Base is legitimately behind and frozen for a whole day. A
    // window shorter than one cycle alarms daily on a healthy chain
    // (Codex #1443 r3). Floor = (86400 day + 14400 grace) / 900 tick.
    const { reportLagWindowTicks } = readConfig({
      CANONICAL_CHAIN_ID: '84532',
    } as never);
    const CRON_SECONDS = 900;
    expect(reportLagWindowTicks * CRON_SECONDS).toBeGreaterThan(86_400 + 14_400);
  });

  it('is much larger than the stuck-settlement window', () => {
    // Stuck settlement reads the chain's OWN retirement, which moves the
    // instant it settles — no report cycle sits between event and
    // observation, so it can stay short.
    const c = readConfig({ CANONICAL_CHAIN_ID: '84532' } as never);
    expect(c.reportLagWindowTicks).toBeGreaterThan(c.stuckWindowTicks * 10);
  });

  it('still honours an explicit override', () => {
    expect(
      readConfig({
        CANONICAL_CHAIN_ID: '84532',
        REPORT_LAG_WINDOW_TICKS: '200',
      } as never).reportLagWindowTicks,
    ).toBe(200);
  });
});

describe('redaction — secrets must not reach Telegram or logs', () => {
  // viem embeds the request URL in its error messages and providers put
  // the API key in the path or query, so a provider having a bad minute
  // would have published RPC_<chainId> to the ops chat (Codex #1443 r4,
  // confirmed by constructing a viem HttpRequestError).
  const env = {
    RPC_8453: 'https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY',
    RPC_42161: 'https://arb-mainnet.g.alchemy.com/v2/OTHERSECRET',
    TG_OPS_BOT_TOKEN: '12345:BOTSECRET',
    WATCHER_RUN_TOKEN: 'RUNSECRET',
  } as never;

  it('replaces a configured RPC URL with a named placeholder', () => {
    const r = makeRedactor(env, [8453, 42161]);
    const out = r(
      'HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY\nStatus: 429',
    );
    expect(out).not.toContain('SUPERSECRETKEY');
    expect(out).toContain('<RPC_8453>');
  });

  it('redacts the bot and run tokens wherever they appear', () => {
    const r = makeRedactor(env, []);
    expect(r('boom 12345:BOTSECRET here')).not.toContain('BOTSECRET');
    expect(r('boom RUNSECRET here')).not.toContain('RUNSECRET');
  });

  it('strips the path of an UNCONFIGURED url, keeping the host', () => {
    // Structural layer: catches credentials in a URL this Worker never
    // configured — a redirect, or an upstream's own upstream.
    const r = makeRedactor(env, []);
    const out = r('failed: https://rpc.example.com/v3/UNKNOWNKEY?apikey=SECRET oops');
    expect(out).not.toContain('UNKNOWNKEY');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('rpc.example.com');
    expect(out).toContain('oops');
  });

  it('leaves ordinary prose alone', () => {
    const r = makeRedactor(env, [8453]);
    expect(r('own-ledger read failed on chain 42161: timeout')).toBe(
      'own-ledger read failed on chain 42161: timeout',
    );
  });

  it('handles several urls and trailing punctuation', () => {
    const out = stripUrlPaths(
      'tried https://a.example/x/KEY1, then https://b.example/y/KEY2. done',
    );
    expect(out).not.toContain('KEY1');
    expect(out).not.toContain('KEY2');
    expect(out).toContain('a.example');
    expect(out).toContain('b.example');
    expect(out).toContain('done');
  });

  it('keeps a bare host untouched', () => {
    expect(stripUrlPaths('https://rpc.example.com')).toBe('https://rpc.example.com');
  });
});

describe('readAlertRepeatSeconds — survives an unrelated bad knob', () => {
  it('honours the configured value when another setting is broken', () => {
    // The tick-failure handler needs the operator's cadence even when
    // some OTHER knob is what threw; hard-coding the default there gave
    // the watcher-down alert an undocumented cadence (Codex #1443 r4).
    const broken = {
      ALERT_REPEAT_SECONDS: '900',
      CANONICAL_CHAIN_ID: 'not-a-number',
    } as never;
    expect(() => readConfig(broken)).toThrow();
    expect(readAlertRepeatSeconds(broken)).toBe(900);
  });

  it('falls back only when THIS setting is the bad one', () => {
    expect(readAlertRepeatSeconds({ ALERT_REPEAT_SECONDS: '0' } as never)).toBe(21_600);
    expect(readAlertRepeatSeconds({} as never)).toBe(21_600);
  });
});

describe('redactDeliveryError — the pager credential must not reach the logs', () => {
  // The Telegram endpoint embeds the bot token IN THE PATH
  // (`/bot<token>/sendMessage`), so a fetch rejection or an error body
  // echoing the request would write TG_OPS_BOT_TOKEN into Worker logs —
  // precisely during a delivery failure, when the operator is most likely
  // to be reading them. The general redactor never reached this module
  // because it has no Env (Codex #1443 r5).
  const TOKEN = '123456:AAH-BOTSECRET';

  it('removes the token from a thrown fetch error', () => {
    const out = redactDeliveryError(
      `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`,
      TOKEN,
    );
    expect(out).not.toContain('BOTSECRET');
    expect(out).not.toContain(TOKEN);
  });

  it('removes the token from a non-2xx response body', () => {
    const out = redactDeliveryError(
      `{"ok":false,"description":"Unauthorized for bot${TOKEN}"}`,
      TOKEN,
    );
    expect(out).not.toContain('BOTSECRET');
  });

  it('also strips url paths, catching a token this call does not know', () => {
    const out = redactDeliveryError(
      'proxied via https://relay.example.com/bot999:OTHERSECRET/sendMessage',
      TOKEN,
    );
    expect(out).not.toContain('OTHERSECRET');
    expect(out).toContain('relay.example.com');
  });

  it('leaves an ordinary failure message readable', () => {
    expect(redactDeliveryError('429 Too Many Requests', TOKEN)).toBe(
      '429 Too Many Requests',
    );
  });
});

describe('redaction — credentials in the URL authority', () => {
  // `stripUrlPaths` kept the whole authority, so a credential that lives
  // entirely inside it survived: `https://user:secret@rpc.example/…`
  // (Codex #1443 r6).
  it('scrubs userinfo while keeping the host', () => {
    const out = stripUrlPaths('failed: https://user:SECRET@rpc.example.com/v2/KEY oops');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('KEY');
    expect(out).toContain('rpc.example.com');
    expect(out).toContain('oops');
  });

  it('handles a userinfo-only credential with no path', () => {
    const out = stripUrlPaths('https://tok:SECRET@rpc.example.com');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('rpc.example.com');
  });
});

describe('makeBaseRedactor — the failure paths know every RPC secret', () => {
  // It passed an EMPTY chain list, so every RPC_<id> value went
  // unredacted on exactly the path a canonical-read failure takes — the
  // one place the redactor was added for (Codex #1443 r6).
  const env = {
    RPC_8453: 'https://base.example/v2/BASESECRET',
    RPC_42161: 'https://arb.example/v2/ARBSECRET',
    NOT_AN_RPC: 'https://other.example/v2/IGNORED',
  } as never;

  it('discovers configured chains from the environment', () => {
    expect(configuredRpcChainIds(env).sort()).toEqual([8453, 42161].sort());
  });

  it('redacts every configured RPC secret without being told the chain set', () => {
    const r = makeBaseRedactor(env);
    const out = r(
      'canonical chain 8453 unreadable: HTTP failed URL: https://base.example/v2/BASESECRET',
    );
    expect(out).not.toContain('BASESECRET');
    expect(out).toContain('<RPC_8453>');
  });

  it('ignores env keys that are not RPC_<chainId>', () => {
    expect(configuredRpcChainIds({ RPC_NOTANUMBER: 'x' } as never)).toEqual([]);
    expect(configuredRpcChainIds({ RPC_8453: '' } as never)).toEqual([]);
  });
});

describe('stale-head freshness gate', () => {
  // A mirror RPC serving a stale head makes Base legitimately AHEAD of
  // what was just read, which `base-ahead-of-chain` would report as
  // ledger corruption — a false CRITICAL, the worst output this Worker
  // has (Codex #1443 r6). Too-stale snapshots are treated as unreadable.
  it('defaults to a limit above ordinary head lag and far below the tick', () => {
    const c = readConfig({ CANONICAL_CHAIN_ID: '84532' } as never);
    expect(c.staleLocalSeconds).toBeGreaterThanOrEqual(60);
    expect(c.staleLocalSeconds).toBeLessThan(900); // the cron interval
  });

  it('is overridable for a chain that idles between blocks', () => {
    expect(
      readConfig({
        CANONICAL_CHAIN_ID: '84532',
        STALE_LOCAL_SECONDS: '1800',
      } as never).staleLocalSeconds,
    ).toBe(1800);
  });

  it('an EXCLUDED chain skips the cross-chain checks entirely', () => {
    // The exclusion path is the same one an unreachable chain takes, so
    // this pins the property that matters: with no local snapshot, a
    // Base copy that leads produces NO finding rather than a critical.
    expect(
      codes({
        mirrorLocal: null,
        mirror: { reported: 99_999n * E, attributed: 0n, avail: 99_699n * E },
      }),
    ).toEqual([]);
  });

  it('and the same state WITH a fresh snapshot does fire', () => {
    // Proves the previous test is about the exclusion, not about the
    // state being benign.
    expect(
      codes({
        mirror: { reported: 99_999n * E, attributed: 0n, avail: 99_699n * E },
      }),
    ).toEqual(['base-ahead-of-chain']);
  });
});

describe('credentialComponents — a key echoed without its URL', () => {
  // Registering only the whole URL missed the case where a provider
  // echoes just the key back: the exact match fails because the string
  // is not the full URL, and the structural pass does nothing because it
  // is not a URL at all (Codex #1443 r7).
  it('extracts a path-segment key', () => {
    expect(credentialComponents('https://base.example/v2/SUPERSECRETKEY123')).toContain(
      'SUPERSECRETKEY123',
    );
  });

  it('extracts a query-parameter key', () => {
    expect(
      credentialComponents('https://rpc.example/rpc?apikey=QUERYSECRET123'),
    ).toContain('QUERYSECRET123');
  });

  it('extracts userinfo', () => {
    expect(credentialComponents('https://user:USERINFOSECRET@rpc.example/')).toContain(
      'USERINFOSECRET',
    );
  });

  it('ignores common path words and short segments', () => {
    const parts = credentialComponents('https://base-mainnet.example/v2/rpc');
    expect(parts).not.toContain('v2');
    expect(parts).not.toContain('rpc');
  });

  it('redacts a bare echoed key through the full redactor', () => {
    const r = makeRedactor(
      { RPC_8453: 'https://base.example/v2/SUPERSECRETKEY123' } as never,
      [8453],
    );
    // The provider echoes ONLY the key, with no URL around it.
    const out = r('upstream rejected credential SUPERSECRETKEY123');
    expect(out).not.toContain('SUPERSECRETKEY123');
  });
});

describe('sendOpsMessage — bounded delivery', () => {
  // Telegram can accept the connection and never complete the response.
  // Without a deadline the sequential delivery loop stalls there, so one
  // hung ADVISORY blocks every later CRITICAL and the state batch is
  // never written (Codex #1443 r7).
  const target = { token: 'tok', chatId: '-100' };

  it('gives up on a response that never arrives, rather than hanging', async () => {
    const original = globalThis.fetch;
    // A server that accepts and never answers — resolves only if aborted.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;
    try {
      await expect(sendOpsMessage(target, 'hello')).resolves.toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  }, 20_000);

  it('passes an abort signal on every send', async () => {
    const original = globalThis.fetch;
    let sawSignal = false;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    try {
      await sendOpsMessage(target, 'hello');
      expect(sawSignal).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports a rejected send as a failure rather than throwing', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response('nope', { status: 429 }))) as typeof fetch;
    try {
      await expect(sendOpsMessage(target, 'hello')).resolves.toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('asFreshSnapshot — the brand VALIDATES, it does not just cast', () => {
  // An earlier version was an unchecked cast whose contract lived in a
  // comment, which is the enforcement-by-convention the brand exists to
  // replace: any module could brand a stale snapshot and compile
  // (#1443 r9). The check now lives inside the constructor.
  const raw = (observedAt: bigint): Omit<LocalLedger, FRESH> => ({
    ...mirrorLocal(),
    observedAt,
  });

  it('accepts a snapshot inside the age limit', () => {
    const v = asFreshSnapshot(raw(BigInt(NOW - 10)), NOW, MAX_AGE);
    expect('fresh' in v).toBe(true);
  });

  it('REJECTS one beyond it, and reports the age', () => {
    const v = asFreshSnapshot(raw(BigInt(NOW - MAX_AGE - 1)), NOW, MAX_AGE);
    expect('stale' in v).toBe(true);
    if ('stale' in v) expect(v.ageSeconds).toBe(MAX_AGE + 1);
  });

  it('accepts exactly at the boundary', () => {
    expect('fresh' in asFreshSnapshot(raw(BigInt(NOW - MAX_AGE)), NOW, MAX_AGE)).toBe(true);
  });

  it('accepts a head slightly ahead of our clock (skew)', () => {
    expect('fresh' in asFreshSnapshot(raw(BigInt(NOW + 5)), NOW, MAX_AGE)).toBe(true);
  });
});

describe('bucket coverage on a STALE snapshot — a same-chain check', () => {
  // Freshness is a precondition for comparing ACROSS chains. Bucket
  // coverage compares two figures from ONE pinned block, so it stays
  // valid however old that block is — discarding the snapshot downgraded
  // a genuine CRITICAL to a silent coverage advisory (#1443 r9).
  function staleObservation(): MeshObservation {
    const stale = { ...mirrorLocal(), bucket: 0n } as Omit<LocalLedger, FRESH>;
    return {
      canonicalChainId: CANONICAL,
      expectedChainIds: [CANONICAL, MIRROR],
      books: [canonicalBooks(), mirrorBooks()],
      // Absent from freshLocals — too old to compare against Base...
      freshLocals: new Map(),
      // ...but present here, because its own two figures are comparable.
      allLocals: new Map([[MIRROR, stale]]),
      gaps: [],
    };
  }

  it('still fires CRITICAL from a stale snapshot', () => {
    const findings = checkHardInvariants(staleObservation(), TOLERANCE);
    const bucket = findings.filter((f) => f.code === 'bucket-coverage');
    expect(bucket).toHaveLength(1);
    expect(bucket[0]?.severity).toBe('critical');
  });

  it('and the cross-chain checks stay skipped for it', () => {
    const codes = new Set(
      checkHardInvariants(staleObservation(), TOLERANCE).map((f) => f.code),
    );
    expect(codes.has('base-ahead-of-chain')).toBe(false);
  });
});
