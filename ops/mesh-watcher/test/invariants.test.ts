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
  advanceStreak,
  checkHardInvariants,
  expectedAvail,
  fmt,
  reportLagCondition,
  satSub,
  stuckSettlementCondition,
  type BaseChainBooks,
  type LocalLedger,
  type MeshObservation,
} from '../src/invariants';
import { formatAlert } from '../src/telegram';

const E = 1_000_000_000_000_000_000n; // 1 VPFI
const TOLERANCE = 1_000_000_000_000_000n; // 1e15 wei — the shipped default

const CANONICAL = 84532;
const MIRROR = 42161;

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

function mirrorLocal(): LocalLedger {
  return {
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
  };
}

function canonicalLocal(): LocalLedger {
  return {
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
  };
}

interface Overrides {
  mirror?: Partial<BaseChainBooks>;
  canonical?: Partial<BaseChainBooks>;
  mirrorLocal?: Partial<LocalLedger> | null;
  canonicalLocal?: Partial<LocalLedger> | null;
}

function observation(o: Overrides = {}): MeshObservation {
  const locals = new Map<number, LocalLedger>();
  if (o.mirrorLocal !== null) {
    locals.set(MIRROR, { ...mirrorLocal(), ...o.mirrorLocal });
  }
  if (o.canonicalLocal !== null) {
    locals.set(CANONICAL, { ...canonicalLocal(), ...o.canonicalLocal });
  }
  return {
    canonicalChainId: CANONICAL,
    books: [
      { ...canonicalBooks(), ...o.canonical },
      { ...mirrorBooks(), ...o.mirror },
    ],
    locals,
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

describe('advanceStreak', () => {
  it('clears rather than decrements when the condition stops holding', () => {
    expect(advanceStreak({ marker: 'x', streak: 5 }, false, 'x', 3)).toEqual({
      next: null,
      fire: false,
    });
  });

  it('starts at one on the first observation', () => {
    expect(advanceStreak(null, true, 'x', 3)).toEqual({
      next: { marker: 'x', streak: 1 },
      fire: false,
    });
  });

  it('accumulates while the marker is unchanged', () => {
    expect(advanceStreak({ marker: 'x', streak: 1 }, true, 'x', 3).next).toEqual(
      { marker: 'x', streak: 2 },
    );
  });

  it('restarts when the marker moves — progress ends the run', () => {
    expect(advanceStreak({ marker: 'x', streak: 9 }, true, 'y', 3)).toEqual({
      next: { marker: 'y', streak: 1 },
      fire: false,
    });
  });

  it('fires on reaching the window and keeps firing after it', () => {
    expect(advanceStreak({ marker: 'x', streak: 2 }, true, 'x', 3).fire).toBe(
      true,
    );
    expect(advanceStreak({ marker: 'x', streak: 40 }, true, 'x', 3).fire).toBe(
      true,
    );
  });
});

describe('stuckSettlementCondition', () => {
  it('does not hold when nothing is outstanding', () => {
    expect(
      stuckSettlementCondition({ ...mirrorBooks(), outstanding: 0n }, mirrorLocal())
        .holds,
    ).toBe(false);
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
    expect(result.marker).toBe((999n * E).toString());
  });

  it('falls back to Base’s copy when the chain is unreachable', () => {
    const result = stuckSettlementCondition(mirrorBooks(), undefined);
    expect(result.source).toBe('base');
    expect(result.marker).toBe((250n * E).toString());
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

describe('reportLagCondition', () => {
  it('does not hold for an unreachable chain', () => {
    expect(reportLagCondition(mirrorBooks(), undefined).holds).toBe(false);
  });

  it('does not hold when Base is level with the chain', () => {
    expect(reportLagCondition(mirrorBooks(), mirrorLocal()).holds).toBe(false);
  });

  it('holds when Base trails the chain', () => {
    expect(
      reportLagCondition(mirrorBooks(), {
        ...mirrorLocal(),
        reportedCumulative: 1500n * E,
      }).holds,
    ).toBe(true);
  });

  it('keys the run on Base’s figure alone', () => {
    // Keying on both sides would reset the run every time the chain
    // absorbed more — masking exactly the case this signal exists for,
    // where the chain keeps working and Base never hears about it.
    const first = reportLagCondition(mirrorBooks(), {
      ...mirrorLocal(),
      reportedCumulative: 1500n * E,
    });
    const later = reportLagCondition(mirrorBooks(), {
      ...mirrorLocal(),
      reportedCumulative: 2500n * E,
    });
    expect(first.marker).toBe(later.marker);
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

  it('truncates below the sixth decimal rather than rounding up', () => {
    expect(fmt(1n)).toBe('0.000000 VPFI');
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
