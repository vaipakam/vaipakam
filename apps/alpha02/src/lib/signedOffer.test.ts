/**
 * #1131 slice D — signed-offer pure math: the wire mapping the maker
 * signs, ceiling/remaining semantics, the signed→ladder row merge, and
 * the slice-B top-of-book pair picker's signed-row rules.
 */
import { describe, expect, it } from 'vitest';
import type { CreateOfferPayload } from './offerSchema';
import type { IndexedOffer, IndexedSignedOffer } from '../data/indexer';
import {
  buildLadder,
  signedFillCandidate,
  takerCandidate,
  topOfBookMatchPair,
} from '../data/desk';
import {
  SIGNED_OFFER_FIELD_NAMES,
  SIGNED_ORDER_SUBMIT_MARGIN_SECONDS,
  collapseForSignedPost,
  signedOfferCeiling,
  signedOfferRemaining,
  signedOrderHash,
  signedOrderTimeWindowsOpen,
  signedRowToDeskRow,
  wireFromCreatePayload,
  type SignedOrderWire,
} from './signedOffer';

const CHAIN = 84532;
const NOW = 1_800_000_000;
const LEND = '0xAaAa000000000000000000000000000000000001';
const COLL = '0xBbBb000000000000000000000000000000000002';
const MAKER = '0xCcCc000000000000000000000000000000000003';
const TAKER = '0xdddd000000000000000000000000000000000004';

function payload(p: Partial<CreateOfferPayload> = {}): CreateOfferPayload {
  return {
    offerType: 0,
    lendingAsset: LEND,
    amount: 100n,
    interestRateBps: 937,
    collateralAsset: COLL,
    collateralAmount: 2_000n,
    durationDays: 30,
    assetType: 0,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: true,
    amountMax: 1_000n,
    interestRateBpsMax: 10_000,
    collateralAmountMax: 2_000n,
    periodicInterestCadence: 0,
    allowsParallelSale: false,
    fillMode: 0,
    expiresAt: 0n,
    allowsPrepayListing: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: false,
    ...p,
  };
}

function wire(p: Partial<SignedOrderWire> = {}): SignedOrderWire {
  return {
    ...wireFromCreatePayload(payload(), MAKER, 42n, 0n),
    ...p,
  };
}

function signedRow(
  order: SignedOrderWire,
  p: Partial<IndexedSignedOffer> = {},
): IndexedSignedOffer {
  return {
    orderHash: signedOrderHash(order),
    signer: order.signer,
    order,
    signature: '0x' + 'ab'.repeat(65),
    status: 'active',
    filledAmount: '0',
    expiresAt: Number(order.expiresAt),
    deadline: Number(order.deadline),
    ...p,
  };
}

function chainOffer(p: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    chainId: CHAIN,
    offerId: 7,
    status: 'active',
    creator: TAKER,
    offerType: 0,
    lendingAsset: LEND,
    collateralAsset: COLL,
    assetType: 0,
    collateralAssetType: 0,
    principalLiquidity: 0,
    collateralLiquidity: 0,
    tokenId: '0',
    collateralTokenId: '0',
    quantity: '1',
    collateralQuantity: '0',
    amount: '100',
    amountMax: '1000',
    amountFilled: '0',
    interestRateBps: 937,
    interestRateBpsMax: 10000,
    collateralAmount: '2000',
    durationDays: 30,
    positionTokenId: '1',
    prepayAsset: '0x0000000000000000000000000000000000000000',
    useFullTermInterest: false,
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: true,
    firstSeenBlock: 1,
    firstSeenAt: NOW - 100,
    updatedAt: NOW - 100,
    expiresAt: 0,
    fillMode: 0,
    ...p,
  };
}

describe('wireFromCreatePayload', () => {
  it('emits exactly the 28 struct fields in canonical order', () => {
    const w = wireFromCreatePayload(payload(), MAKER, 42n, 123n);
    expect(Object.keys(w)).toEqual(SIGNED_OFFER_FIELD_NAMES);
  });

  it('lowercases addresses, stringifies uints, stamps signer/nonce/deadline', () => {
    const w = wireFromCreatePayload(payload(), MAKER, 42n, 123n);
    expect(w.lendingAsset).toBe(LEND.toLowerCase());
    expect(w.collateralAsset).toBe(COLL.toLowerCase());
    expect(w.signer).toBe(MAKER.toLowerCase());
    expect(w.amount).toBe('100');
    expect(w.amountMax).toBe('1000');
    expect(w.interestRateBps).toBe('937');
    expect(w.durationDays).toBe('30');
    expect(w.nonce).toBe('42');
    expect(w.deadline).toBe('123');
    expect(w.allowsPartialRepay).toBe(true);
  });
});

describe('collapseForSignedPost (#1145 round-2)', () => {
  /** The matcher's constant-ratio gate, verbatim from
   *  `OfferMatchFacet._vetSignedOfferForMatch`:
   *  `collateralAmount * ceiling == effCollMax * amount` — every signed
   *  post the ticket publishes must satisfy it or no keeper slice can
   *  ever materialize. */
  function passesRatioCheck(p: CreateOfferPayload): boolean {
    const ceiling = p.amountMax === 0n ? p.amount : p.amountMax;
    const effCollMax =
      p.collateralAmountMax === 0n ? p.collateralAmount : p.collateralAmountMax;
    return p.collateralAmount * ceiling === effCollMax * p.amount;
  }

  it('the ticket-default ranged lender Partial payload FAILS the ratio check (the round-2 defect)', () => {
    // Lender default: amount = 10% min-partial floor, amountMax = full,
    // collateral single-value — `C*ceiling != C*amount`.
    expect(passesRatioCheck(payload())).toBe(false);
  });

  it('collapses a ranged lender Partial payload to single-value AON that passes the ratio check', () => {
    const out = collapseForSignedPost(payload());
    expect(out.amount).toBe(1_000n);
    expect(out.amountMax).toBe(1_000n);
    expect(out.fillMode).toBe(1); // Partial → AON: single-value ⇒ one full fill
    expect(passesRatioCheck(out)).toBe(true);
    // Collateral stays the lender single-value pair — untouched.
    expect(out.collateralAmount).toBe(2_000n);
    expect(out.collateralAmountMax).toBe(2_000n);
  });

  it('collapses a ranged lender IOC payload but keeps the IOC tag (expiry semantics are load-bearing)', () => {
    const out = collapseForSignedPost(payload({ fillMode: 2, expiresAt: 123n }));
    expect(out.amount).toBe(1_000n);
    expect(out.fillMode).toBe(2);
    expect(out.expiresAt).toBe(123n);
    expect(passesRatioCheck(out)).toBe(true);
  });

  it('returns an already-single-value lender AON payload unchanged (identity)', () => {
    const p = payload({ amount: 1_000n, fillMode: 1 });
    expect(collapseForSignedPost(p)).toBe(p);
  });

  it('relabels a single-value lender Partial payload as AON without touching amounts', () => {
    const out = collapseForSignedPost(payload({ amount: 1_000n }));
    expect(out.amount).toBe(1_000n);
    expect(out.amountMax).toBe(1_000n);
    expect(out.fillMode).toBe(1);
  });

  it('passes borrower payloads through untouched (single-value both legs already satisfies the ratio)', () => {
    const p = payload({ offerType: 1, amount: 1_000n, interestRateBps: 0 });
    expect(collapseForSignedPost(p)).toBe(p);
    expect(passesRatioCheck(p)).toBe(true);
  });
});

describe('ceiling / remaining', () => {
  it('mirrors _ceiling: amountMax==0 falls back to amount', () => {
    expect(signedOfferCeiling(wire({ amountMax: '0', amount: '77' }))).toBe(77n);
    expect(signedOfferCeiling(wire({ amountMax: '1000' }))).toBe(1_000n);
  });

  it('remaining = ceiling − filled, floored at zero', () => {
    const o = wire({ amountMax: '1000' });
    expect(signedOfferRemaining(o, '0')).toBe(1_000n);
    expect(signedOfferRemaining(o, '400')).toBe(600n);
    expect(signedOfferRemaining(o, '1000')).toBe(0n);
    expect(signedOfferRemaining(o, '2000')).toBe(0n);
    expect(signedOfferRemaining(o, 'garbage')).toBe(0n);
  });
});

describe('signedOrderTimeWindowsOpen (#1145 round-3 P2)', () => {
  const now = BigInt(NOW);
  const margin = SIGNED_ORDER_SUBMIT_MARGIN_SECONDS;

  it('GTC on both windows (zero sentinels) is always open', () => {
    expect(
      signedOrderTimeWindowsOpen(wire({ expiresAt: '0', deadline: '0' }), now),
    ).toBe(true);
  });

  it('GTT expiry EQUAL to chain-now is closed — createOffer rejects expiresAt <= block.timestamp', () => {
    expect(
      signedOrderTimeWindowsOpen(wire({ expiresAt: String(NOW) }), now),
    ).toBe(false);
  });

  it('GTT expiry inside the submit margin is closed; just past it is open', () => {
    expect(
      signedOrderTimeWindowsOpen(
        wire({ expiresAt: String(now + margin) }),
        now,
      ),
    ).toBe(false);
    expect(
      signedOrderTimeWindowsOpen(
        wire({ expiresAt: String(now + margin + 1n) }),
        now,
      ),
    ).toBe(true);
  });

  it('signature deadline inside the submit margin is closed; a far deadline is open', () => {
    expect(
      signedOrderTimeWindowsOpen(wire({ deadline: String(now + margin) }), now),
    ).toBe(false);
    expect(
      signedOrderTimeWindowsOpen(
        wire({ deadline: String(now + 7n * 86_400n) }),
        now,
      ),
    ).toBe(true);
  });

  it('an already-past window is closed', () => {
    expect(
      signedOrderTimeWindowsOpen(wire({ expiresAt: String(NOW - 1) }), now),
    ).toBe(false);
    expect(
      signedOrderTimeWindowsOpen(wire({ deadline: String(NOW - 1) }), now),
    ).toBe(false);
  });
});

describe('signedOrderHash', () => {
  it('is deterministic and binds every field (nonce change ⇒ new hash)', () => {
    const a = wire();
    expect(signedOrderHash(a)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signedOrderHash(a)).toBe(signedOrderHash(wire()));
    expect(signedOrderHash(wire({ nonce: '43' }))).not.toBe(signedOrderHash(a));
  });
});

describe('signedRowToDeskRow', () => {
  it('maps a live lender order into a signed-tagged ladder row', () => {
    const o = wire();
    const row = signedRowToDeskRow(signedRow(o, { filledAmount: '400' }), CHAIN, NOW);
    expect(row).not.toBeNull();
    expect(row!.signed?.orderHash).toBe(signedOrderHash(o));
    expect(row!.creator).toBe(MAKER.toLowerCase());
    expect(row!.offerId).toBe(-1); // sentinel, never an identity
    // remaining via the ladder's own offerRemaining semantics:
    expect(BigInt(row!.amountMax) - BigInt(row!.amountFilled)).toBe(600n);
    expect(row!.interestRateBps).toBe(937);
    expect(row!.durationDays).toBe(30);
  });

  it('drops non-active rows and lapsed signature deadlines', () => {
    const o = wire({ deadline: String(NOW - 1) });
    expect(signedRowToDeskRow(signedRow(o), CHAIN, NOW)).toBeNull();
    expect(
      signedRowToDeskRow(signedRow(wire(), { status: 'filled' }), CHAIN, NOW),
    ).toBeNull();
    // deadline 0 = no deadline (contract sentinel) — kept.
    expect(signedRowToDeskRow(signedRow(wire({ deadline: '0' })), CHAIN, NOW)).not.toBeNull();
  });
});

describe('ladder merge', () => {
  it('aggregates signed and chain depth at the same rate level, flags own', () => {
    const signed = signedRowToDeskRow(signedRow(wire()), CHAIN, NOW)!;
    const ladder = buildLadder([chainOffer(), signed], 30, NOW, MAKER);
    expect(ladder.asks).toHaveLength(1);
    expect(ladder.asks[0].rateBps).toBe(937);
    expect(ladder.asks[0].size).toBe(2_000n); // 1000 chain + 1000 signed
    expect(ladder.asks[0].offers).toHaveLength(2);
    expect(ladder.asks[0].own).toBe(true); // MAKER's signed row
  });

  it('takerCandidate skips signed rows; signedFillCandidate skips own + on-chain', () => {
    // Single-value on principal — ranged rows never arm the direct
    // fill (#1145 round-2, pinned separately below).
    const signed = signedRowToDeskRow(
      signedRow(wire({ amount: '1000' })),
      CHAIN,
      NOW,
    )!;
    const ladder = buildLadder([signed, chainOffer()], 30, NOW, undefined);
    const level = ladder.asks[0];
    // The on-chain row is the deep-link candidate even when the signed
    // row sorts first in the level.
    expect(takerCandidate(level, undefined)?.offerId).toBe(7);
    // Not-own signed row is the fill candidate…
    expect(signedFillCandidate(level, TAKER)?.signed?.signer).toBe(
      MAKER.toLowerCase(),
    );
    // …but the maker themselves gets no fill affordance.
    expect(signedFillCandidate(level, MAKER)).toBeNull();
  });

  it('a purely-signed ladder arms no on-chain taker link', () => {
    const signed = signedRowToDeskRow(signedRow(wire()), CHAIN, NOW)!;
    const ladder = buildLadder([signed], 30, NOW, undefined);
    expect(takerCandidate(ladder.asks[0], undefined)).toBeNull();
  });

  // Codex #1145 round-1 P2 #5 — `acceptSignedOffer`'s vetting
  // (`_vetSignedOffer`) reverts `SignedOfferConsumed` on ANY non-zero
  // fill ledger, so a matcher-partially-filled signed order must never
  // arm the direct Fill affordance. Its remainder is still real depth
  // (matchable via `matchSignedOffer`), so the row stays on the ladder.
  it('signedFillCandidate skips partially matched rows while their remainder still rests as depth', () => {
    const partial = signedRowToDeskRow(
      signedRow(wire(), { filledAmount: '400' }),
      CHAIN,
      NOW,
    )!;
    const ladder = buildLadder([partial], 30, NOW, undefined);
    // The remainder is honest depth…
    expect(ladder.asks[0].size).toBe(600n);
    // …but no direct-fill button: the confirm would be doomed ("gone"
    // before signing).
    expect(signedFillCandidate(ladder.asks[0], TAKER)).toBeNull();
  });

  it('signedFillCandidate picks the unfilled signed row when a level mixes partial and fresh', () => {
    const partial = signedRowToDeskRow(
      signedRow(wire(), { filledAmount: '400' }),
      CHAIN,
      NOW,
    )!;
    // Distinct hash, same rate level; single-value so the direct-fill
    // gate (#1145 round-2) admits it.
    const freshOrder = wire({ nonce: '43', amount: '1000' });
    const fresh = signedRowToDeskRow(signedRow(freshOrder), CHAIN, NOW)!;
    const ladder = buildLadder([partial, fresh], 30, NOW, undefined);
    expect(ladder.asks).toHaveLength(1); // same 937 bps level
    expect(signedFillCandidate(ladder.asks[0], TAKER)?.signed?.orderHash).toBe(
      fresh.signed!.orderHash,
    );
  });

  // Codex #1145 round-2 P2 — a RANGED signed order (amount < ceiling)
  // must never arm the direct fill: `acceptSignedOffer` consumes the
  // fill ledger to the CEILING (`signedOfferFilled[orderHash] =
  // _ceiling(o)`) while the materialized accept binds only the ROLE
  // amount (a borrower offer's headline FLOOR), so a direct fill would
  // vaporize the advertised remainder. The desk's own ticket can no
  // longer produce this shape (lender payloads are collapsed, borrower
  // payloads ship single-value) — the gate defends against range orders
  // POSTed straight to the public indexer API.
  it('signedFillCandidate skips RANGED rows (API-posted shape) while their ceiling still rests as depth', () => {
    // A ranged BORROWER order — the exact depth-vaporizing shape:
    // floor 100, ceiling 1000, advertised depth 1000.
    const ranged = signedRowToDeskRow(
      signedRow(wire({ offerType: '1', interestRateBps: '0' })),
      CHAIN,
      NOW,
    )!;
    const ladder = buildLadder([ranged], 30, NOW, undefined);
    // The full ceiling rests as (matcher-consumable) depth…
    expect(ladder.bids[0].size).toBe(1_000n);
    // …but no direct-fill affordance.
    expect(signedFillCandidate(ladder.bids[0], TAKER)).toBeNull();
    // A ranged LENDER row is gated identically.
    const rangedLender = signedRowToDeskRow(signedRow(wire()), CHAIN, NOW)!;
    const askLadder = buildLadder([rangedLender], 30, NOW, undefined);
    expect(askLadder.asks[0].size).toBe(1_000n);
    expect(signedFillCandidate(askLadder.asks[0], TAKER)).toBeNull();
  });

  it('signedFillCandidate arms on the amountMax==0 single-value wire sentinel', () => {
    const sentinel = signedRowToDeskRow(
      signedRow(wire({ amount: '77', amountMax: '0' })),
      CHAIN,
      NOW,
    )!;
    const ladder = buildLadder([sentinel], 30, NOW, undefined);
    expect(ladder.asks[0].size).toBe(77n);
    expect(signedFillCandidate(ladder.asks[0], TAKER)?.signed?.orderHash).toBe(
      sentinel.signed!.orderHash,
    );
  });
});

describe('topOfBookMatchPair (slice B)', () => {
  const ask = (id: number, rate: number) =>
    chainOffer({ offerId: id, offerType: 0, interestRateBps: rate });
  const bid = (id: number, rate: number) =>
    chainOffer({ offerId: id, offerType: 1, interestRateBpsMax: rate });

  it('returns the best-level first on-chain offer ids when crossed', () => {
    const ladder = buildLadder([ask(1, 500), bid(2, 600)], 30, NOW, undefined);
    expect(topOfBookMatchPair(ladder)).toEqual({
      lenderOfferId: 1,
      borrowerOfferId: 2,
    });
  });

  it('null when not crossed or one-sided', () => {
    expect(
      topOfBookMatchPair(buildLadder([ask(1, 700), bid(2, 600)], 30, NOW, undefined)),
    ).toBeNull();
    expect(
      topOfBookMatchPair(buildLadder([ask(1, 500)], 30, NOW, undefined)),
    ).toBeNull();
    expect(topOfBookMatchPair(null)).toBeNull();
  });

  it('skips signed rows — a purely-signed best level yields no pair', () => {
    const signedAsk = signedRowToDeskRow(
      signedRow(wire({ interestRateBps: '500' })),
      CHAIN,
      NOW,
    )!;
    // Crossed on quotes, but the ask side's best level is signed-only:
    // matchOffers can't cross it (no on-chain offer id) → null.
    const ladder = buildLadder([signedAsk, bid(2, 600)], 30, NOW, undefined);
    expect(ladder.bestAskBps).toBe(500);
    expect(topOfBookMatchPair(ladder)).toBeNull();
    // A same-rate on-chain ask joins the level → the pair arms on it.
    const ladder2 = buildLadder(
      [signedAsk, ask(9, 500), bid(2, 600)],
      30,
      NOW,
      undefined,
    );
    expect(topOfBookMatchPair(ladder2)).toEqual({
      lenderOfferId: 9,
      borrowerOfferId: 2,
    });
  });
});
