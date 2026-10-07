/**
 * #1349 M5 / #1566 slice 4 — the shared recycle-backing verdict
 * (`@vaipakam/contracts/recycle-backing`).
 *
 * The relation is `RewardCustodyFacet.getRecycleBackingSnapshotV2`'s own
 * natspec; these cases pin each leg of it, and each way of NOT answering.
 * They live here rather than beside the module because the contracts
 * package's runner is `node --test` over `.mjs`, which cannot import TS
 * source on CI's Node 22 without a loader — and the indexer is the
 * function's first consumer.
 *
 * Every relation case is built to STRADDLE its threshold (one wei either
 * side), so a mutation that drops a term or flips `>=` to `>` fails here
 * rather than passing on a comfortable margin.
 */
import { describe, expect, it } from 'vitest';

import {
  recycleBackingVerdict,
  type RecycleBackingInputs,
} from '@vaipakam/contracts/recycle-backing';
import { recycleBackingVerdict as fromRoot } from '@vaipakam/contracts';

const T = (n: bigint) => (n * 10n ** 18n).toString();

/** A non-activated reading: bucket 100, stranded 7, recovery 5. */
const diamond = (over: Partial<RecycleBackingInputs> = {}): RecycleBackingInputs => ({
  vpfiBalance: T(112n),
  bucket: T(100n),
  strandedRecoveryReserved: T(7n),
  recoveryPositionReserved: T(5n),
  custodyActivated: false,
  holderBalanceKnown: false,
  holderBalance: null,
  holderAttributed: '0',
  ...over,
});

/**
 * An activated reading. The bucket is deliberately FAR above the Diamond's
 * balance: on an activated chain it is the holder's custody, so the legacy
 * relation would call this healthy chain short.
 */
const holder = (over: Partial<RecycleBackingInputs> = {}): RecycleBackingInputs => ({
  vpfiBalance: T(7n),
  bucket: T(1_000n),
  strandedRecoveryReserved: T(7n),
  recoveryPositionReserved: T(300n),
  custodyActivated: true,
  holderBalanceKnown: true,
  holderBalance: T(1_300n),
  holderAttributed: T(1_300n),
  ...over,
});

describe('recycleBackingVerdict — before activation (relation "diamond")', () => {
  it('is backed exactly at the boundary balance = bucket + both reservations', () => {
    expect(recycleBackingVerdict(diamond())).toEqual({
      determinable: true,
      relation: 'diamond',
      ok: true,
      diamondShortfall: null,
      holderShortfall: null,
      reason: null,
    });
  });

  it('is short by one wei one wei below that boundary', () => {
    const v = recycleBackingVerdict(
      diamond({ vpfiBalance: (BigInt(T(112n)) - 1n).toString() }),
    );
    expect(v.ok).toBe(false);
    expect(v.diamondShortfall).toBe('1');
    expect(v.holderShortfall).toBeNull();
  });

  it('subtracts the ARRIVAL reservation — dropping it would read a spent reservation as backed', () => {
    // Balance covers bucket + recovery but not the stranded reservation.
    const v = recycleBackingVerdict(diamond({ vpfiBalance: T(105n) }));
    expect(v.ok).toBe(false);
    expect(v.diamondShortfall).toBe(T(7n));
  });

  it('subtracts the RECOVERY-POSITION earmark — dropping it would read a spent earmark as backed', () => {
    // Balance covers bucket + stranded but not the recovery position.
    const v = recycleBackingVerdict(diamond({ vpfiBalance: T(107n) }));
    expect(v.ok).toBe(false);
    expect(v.diamondShortfall).toBe(T(5n));
  });

  it('does NOT reproduce the retired "vpfiBalance >= bucket" verdict', () => {
    // The retired dashboard's comparison passes here; the real relation
    // does not, because both reservations sit in the same balance.
    const r = diamond({ vpfiBalance: T(100n) });
    expect(BigInt(r.vpfiBalance) >= BigInt(r.bucket)).toBe(true);
    expect(recycleBackingVerdict(r).ok).toBe(false);
    expect(recycleBackingVerdict(r).diamondShortfall).toBe(T(12n));
  });

  it('ignores the holder figures entirely', () => {
    // An unbound holder on a non-activated chain reads `known = false`; that
    // says nothing about this relation and must not block it.
    expect(
      recycleBackingVerdict(
        diamond({ holderBalanceKnown: false, holderBalance: null, holderAttributed: T(999n) }),
      ).ok,
    ).toBe(true);
  });

  it('refuses, with its reason, when EITHER reservation is missing', () => {
    for (const missing of ['strandedRecoveryReserved', 'recoveryPositionReserved'] as const) {
      expect(recycleBackingVerdict(diamond({ [missing]: null })), missing).toEqual({
        determinable: false,
        relation: 'diamond',
        ok: null,
        diamondShortfall: null,
        holderShortfall: null,
        reason: 'subtrahend-unknown',
      });
    }
  });
});

describe('recycleBackingVerdict — after activation (relation "holder")', () => {
  it('is backed when the holder covers its rows and the Diamond its reservation', () => {
    expect(recycleBackingVerdict(holder())).toEqual({
      determinable: true,
      relation: 'holder',
      ok: true,
      diamondShortfall: null,
      holderShortfall: null,
      reason: null,
    });
  });

  it('does NOT apply the pre-activation relation (bucket is the holder\'s)', () => {
    const r = holder();
    const legacySpokenFor =
      BigInt(r.bucket) +
      BigInt(r.strandedRecoveryReserved!) +
      BigInt(r.recoveryPositionReserved!);
    expect(BigInt(r.vpfiBalance) < legacySpokenFor).toBe(true);
    expect(recycleBackingVerdict(r).ok).toBe(true);
  });

  it('reports the HOLDER shortfall one wei below its attributed rows', () => {
    const v = recycleBackingVerdict(
      holder({ holderBalance: (BigInt(T(1_300n)) - 1n).toString() }),
    );
    expect(v.ok).toBe(false);
    expect(v.holderShortfall).toBe('1');
    expect(v.diamondShortfall).toBeNull();
  });

  it('reports the DIAMOND-side shortfall when the reservation is spent', () => {
    const v = recycleBackingVerdict(
      holder({ vpfiBalance: (BigInt(T(7n)) - 1n).toString() }),
    );
    expect(v.ok).toBe(false);
    expect(v.diamondShortfall).toBe('1');
    expect(v.holderShortfall).toBeNull();
  });

  it('reports BOTH shortfalls when both legs fail', () => {
    const v = recycleBackingVerdict(
      holder({ vpfiBalance: '0', holderBalance: T(1_000n) }),
    );
    expect(v).toMatchObject({
      ok: false,
      diamondShortfall: T(7n),
      holderShortfall: T(300n),
    });
  });

  it('refuses, with its reason, when the holder balance is unreadable', () => {
    // `known = false` arrives with a placeholder balance; judging that
    // placeholder would publish a shortfall equal to everything held.
    for (const over of [
      { holderBalanceKnown: false, holderBalance: '0' },
      { holderBalanceKnown: false, holderBalance: null },
      { holderBalanceKnown: null, holderBalance: null },
      { holderBalanceKnown: true, holderBalance: null },
    ] as const) {
      expect(recycleBackingVerdict(holder(over)), JSON.stringify(over)).toEqual({
        determinable: false,
        relation: 'holder',
        ok: null,
        diamondShortfall: null,
        holderShortfall: null,
        reason: 'holder-balance-unknown',
      });
    }
  });

  it('refuses, with its reason, when a subtrahend is missing', () => {
    for (const missing of ['holderAttributed', 'strandedRecoveryReserved'] as const) {
      expect(recycleBackingVerdict(holder({ [missing]: null })).reason, missing).toBe(
        'subtrahend-unknown',
      );
    }
    // The recovery position is NOT a term of this relation, so its absence
    // does not block it.
    expect(recycleBackingVerdict(holder({ recoveryPositionReserved: null })).ok).toBe(true);
  });
});

describe('recycleBackingVerdict — after activation, one leg unread', () => {
  // The holder relation is a conjunction, and BOTH legs must be readable
  // for it to be answered (API contract; TokenomicsTechSpec "Recycling
  // transparency series"; #1349 release note). A leg that is read and FAILS
  // does not decide it on its own: its shortfall is one leg's, and a
  // surface rendering it as THE shortfall would present part of the
  // relation as the whole. Each case straddles the readable leg's
  // threshold, so a regression to the per-leg rule fails here.

  it('holder unreadable + Diamond short: NOT determinable, holder reason, no shortfall', () => {
    const v = recycleBackingVerdict(
      holder({
        holderBalanceKnown: false,
        holderBalance: '0', // the view's placeholder — must not be judged
        vpfiBalance: (BigInt(T(7n)) - 1n).toString(),
      }),
    );
    expect(v).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'holder-balance-unknown',
    });
  });

  it('holder unreadable + Diamond exactly covered: equally not determinable', () => {
    // The other side of the Diamond leg's threshold gives the same answer:
    // the readable leg's result never reaches the verdict.
    expect(
      recycleBackingVerdict(holder({ holderBalanceKnown: false, holderBalance: null })),
    ).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'holder-balance-unknown',
    });
  });

  it('holder rows unknown + Diamond short: NOT determinable, subtrahend-unknown', () => {
    expect(
      recycleBackingVerdict(holder({ holderAttributed: null, vpfiBalance: '0' })),
    ).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'subtrahend-unknown',
    });
  });

  it('Diamond reservation unknown + holder short: NOT determinable, subtrahend-unknown', () => {
    expect(
      recycleBackingVerdict(
        holder({
          strandedRecoveryReserved: null,
          holderBalance: (BigInt(T(1_300n)) - 1n).toString(),
        }),
      ),
    ).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'subtrahend-unknown',
    });
  });

  it('both legs unread: not determinable, the holder reason first', () => {
    expect(
      recycleBackingVerdict(
        holder({ holderBalanceKnown: false, holderBalance: null, strandedRecoveryReserved: null }),
      ),
    ).toMatchObject({
      determinable: false,
      ok: null,
      reason: 'holder-balance-unknown',
    });
  });

  it('never carries a partial-answer field: the verdict has exactly the contract keys', () => {
    // A withdrawn per-leg rule added fields naming an unread leg. The API
    // contract has exactly these six keys, and the app checks a verdict
    // against the operands of the reading beside it, so a partial answer is
    // refused however it is labelled. Pin the key set on every branch.
    const keys = ['determinable', 'diamondShortfall', 'holderShortfall', 'ok', 'reason', 'relation'];
    for (const v of [
      recycleBackingVerdict(holder()),
      recycleBackingVerdict(holder({ vpfiBalance: '0', holderBalance: '0' })),
      recycleBackingVerdict(holder({ holderBalanceKnown: false, vpfiBalance: '0' })),
      recycleBackingVerdict(diamond({ vpfiBalance: '0' })),
      recycleBackingVerdict(diamond({ custodyActivated: null })),
    ]) {
      expect(Object.keys(v).sort()).toEqual(keys);
    }
  });
});

describe('recycleBackingVerdict — custody state unknown', () => {
  it('never assumes non-activation, even where the legacy relation would hold', () => {
    // A reading with no activation state (pre-0056, or V2 missing from the
    // cut) whose figures would satisfy the Diamond relation comfortably.
    expect(recycleBackingVerdict(diamond({ custodyActivated: null, vpfiBalance: T(10_000n) }))).toEqual({
      determinable: false,
      relation: null,
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'custody-state-unknown',
    });
  });

  it('treats a MISSING or non-boolean activation state as unknown, never as activated', () => {
    // Untyped JSON: the field absent (`undefined`) or carried as something
    // other than a boolean. A `=== null` check alone would route these to
    // the activated branch and name relation 'holder' — a custody state the
    // reading never established.
    for (const bad of [undefined, 'true', 1, 0, 'false']) {
      expect(
        recycleBackingVerdict({
          ...holder(),
          custodyActivated: bad as unknown as boolean | null,
        }),
        String(bad),
      ).toEqual({
        determinable: false,
        relation: null,
        ok: null,
        diamondShortfall: null,
        holderShortfall: null,
        reason: 'custody-state-unknown',
      });
    }
  });
});

describe('recycleBackingVerdict — holder readability from untyped JSON', () => {
  it('treats a MISSING or non-boolean holderBalanceKnown as unknown', () => {
    // The holder figures are otherwise healthy, so only the readability flag
    // can make this undeterminable — a truthy non-boolean must not pass.
    for (const bad of [undefined, 'true', 1]) {
      expect(
        recycleBackingVerdict({
          ...holder(),
          holderBalanceKnown: bad as unknown as boolean | null,
        }),
        String(bad),
      ).toEqual({
        determinable: false,
        relation: 'holder',
        ok: null,
        diamondShortfall: null,
        holderShortfall: null,
        reason: 'holder-balance-unknown',
      });
    }
  });
});

describe('recycleBackingVerdict — inputs', () => {
  it('throws on a malformed operand instead of coercing it', () => {
    // BigInt() alone would accept '0x10' and ' 12 '; a coerced figure is a
    // detected corruption turned into a confident verdict.
    for (const bad of ['0x10', ' 12 ', '-1', '1.5', '', '1e18']) {
      expect(() => recycleBackingVerdict(diamond({ bucket: bad })), bad).toThrow(RangeError);
      expect(() => recycleBackingVerdict(holder({ holderAttributed: bad })), bad).toThrow(RangeError);
    }
  });

  it('throws on a missing minuend fed in from untyped JSON', () => {
    expect(() =>
      recycleBackingVerdict({ ...diamond(), vpfiBalance: null as unknown as string }),
    ).toThrow(RangeError);
  });

  it('is exact at wei scale — no float path, no tolerance', () => {
    const big = 10n ** 30n;
    const v = recycleBackingVerdict(
      diamond({
        vpfiBalance: (big + 11n).toString(),
        bucket: big.toString(),
        strandedRecoveryReserved: '7',
        recoveryPositionReserved: '5',
      }),
    );
    expect(v.diamondShortfall).toBe('1');
  });

  it('is the same function from the package root and its subpath', () => {
    expect(fromRoot).toBe(recycleBackingVerdict);
  });
});
