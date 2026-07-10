/**
 * Rate Desk phase 3, slice D (#1131) — pure signed-offer helpers for the
 * GASLESS off-chain order book (SignedOfferFacet / LibSignedOffer v0.5).
 *
 * Mirrors the indexer's `apps/indexer/src/signedOfferEip712.ts` (which in
 * turn mirrors `contracts/src/libraries/LibSignedOffer.sol`):
 *
 *  - `SIGNED_OFFER_TYPES.SignedOffer` lists the 28 fields in the SAME
 *    order as the Solidity struct / `SIGNED_OFFER_TYPEHASH` type string.
 *    Field order is load-bearing — any drift silently changes every hash
 *    and breaks both the maker's signature and the taker's replay.
 *  - The signing domain is `{name: 'Vaipakam SignedOffer', version: '1',
 *    chainId, verifyingContract: <diamond>}`.
 *  - `signedOrderHash` is the STRUCT hash (`hashStruct`, NOT the full
 *    digest) — the same value `SignedOfferFacet.signedOfferOrderHash`
 *    returns and the key both the on-chain `signedOfferFilled` ledger and
 *    the indexer's `signed_offers` table use.
 *
 * Everything here is side-effect-free local computation (no RPC, no
 * hooks) so vitest can pin the wire mapping, the remaining-size math and
 * the ladder-merge shape deterministically.
 */
import { hashStruct, type Address, type Hex } from 'viem';
import type { IndexedOffer, IndexedSignedOffer } from '../data/indexer';
import type { CreateOfferPayload } from './offerSchema';

/** The 28-field SignedOffer typed-data description — struct order EXACTLY
 *  as `LibSignedOffer.SignedOffer` declares it (enums ⇒ uint8, GTT ⇒
 *  uint64). Byte-for-byte the same list the indexer's ingest gate derives
 *  its typehash from. */
export const SIGNED_OFFER_TYPES = {
  SignedOffer: [
    { name: 'offerType', type: 'uint8' },
    { name: 'lendingAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'amountMax', type: 'uint256' },
    { name: 'interestRateBps', type: 'uint256' },
    { name: 'interestRateBpsMax', type: 'uint256' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'collateralAmountMax', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' },
    { name: 'assetType', type: 'uint8' },
    { name: 'collateralAssetType', type: 'uint8' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'collateralTokenId', type: 'uint256' },
    { name: 'collateralQuantity', type: 'uint256' },
    { name: 'prepayAsset', type: 'address' },
    { name: 'allowsPartialRepay', type: 'bool' },
    { name: 'allowsPrepayListing', type: 'bool' },
    { name: 'allowsParallelSale', type: 'bool' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'fillMode', type: 'uint8' },
    { name: 'periodicInterestCadence', type: 'uint8' },
    { name: 'refinanceTargetLoanId', type: 'uint256' },
    { name: 'useFullTermInterest', type: 'bool' },
    { name: 'signer', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** The 28 field names in canonical struct order — the POST body /
 *  `order_json` key order the indexer stores and replays. */
export const SIGNED_OFFER_FIELD_NAMES: readonly string[] =
  SIGNED_OFFER_TYPES.SignedOffer.map((f) => f.name);

/** The wire shape the indexer's POST/GET routes speak: every uint as a
 *  decimal string, addresses lowercase 0x-40-hex, bools as booleans.
 *  Takers replay this verbatim into `acceptSignedOffer`. */
export interface SignedOrderWire {
  offerType: string;
  lendingAsset: string;
  amount: string;
  amountMax: string;
  interestRateBps: string;
  interestRateBpsMax: string;
  collateralAsset: string;
  collateralAmount: string;
  collateralAmountMax: string;
  durationDays: string;
  assetType: string;
  collateralAssetType: string;
  tokenId: string;
  quantity: string;
  collateralTokenId: string;
  collateralQuantity: string;
  prepayAsset: string;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  expiresAt: string;
  fillMode: string;
  periodicInterestCadence: string;
  refinanceTargetLoanId: string;
  useFullTermInterest: boolean;
  signer: string;
  nonce: string;
  deadline: string;
}

/** Wire → the bigint-typed message viem's typed-data encoder (and the
 *  `acceptSignedOffer` / `cancelSignedOffer` ABI tuple) expects. */
export function signedOfferTypedMessage(order: SignedOrderWire) {
  return {
    offerType: Number(order.offerType),
    lendingAsset: order.lendingAsset as Address,
    amount: BigInt(order.amount),
    amountMax: BigInt(order.amountMax),
    interestRateBps: BigInt(order.interestRateBps),
    interestRateBpsMax: BigInt(order.interestRateBpsMax),
    collateralAsset: order.collateralAsset as Address,
    collateralAmount: BigInt(order.collateralAmount),
    collateralAmountMax: BigInt(order.collateralAmountMax),
    durationDays: BigInt(order.durationDays),
    assetType: Number(order.assetType),
    collateralAssetType: Number(order.collateralAssetType),
    tokenId: BigInt(order.tokenId),
    quantity: BigInt(order.quantity),
    collateralTokenId: BigInt(order.collateralTokenId),
    collateralQuantity: BigInt(order.collateralQuantity),
    prepayAsset: order.prepayAsset as Address,
    allowsPartialRepay: order.allowsPartialRepay,
    allowsPrepayListing: order.allowsPrepayListing,
    allowsParallelSale: order.allowsParallelSale,
    expiresAt: BigInt(order.expiresAt),
    fillMode: Number(order.fillMode),
    periodicInterestCadence: Number(order.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(order.refinanceTargetLoanId),
    useFullTermInterest: order.useFullTermInterest,
    signer: order.signer as Address,
    nonce: BigInt(order.nonce),
    deadline: BigInt(order.deadline),
  };
}

/** The order hash — the EIP-712 STRUCT hash (`hashStruct`), matching
 *  `SignedOfferFacet.signedOfferOrderHash`. Recomputed LOCALLY from the
 *  order fields wherever it matters (the AcceptTerms `offerKey` binding)
 *  so a stale or hostile indexer cache can never make a taker sign
 *  against a hash that doesn't belong to the displayed terms. */
export function signedOrderHash(order: SignedOrderWire): Hex {
  return hashStruct({
    data: signedOfferTypedMessage(order),
    primaryType: 'SignedOffer',
    types: SIGNED_OFFER_TYPES,
  });
}

/** The order's principal ceiling — mirrors `SignedOfferFacet._ceiling`:
 *  `amountMax == 0 ? amount : amountMax`. */
export function signedOfferCeiling(order: SignedOrderWire): bigint {
  const max = BigInt(order.amountMax);
  return max === 0n ? BigInt(order.amount) : max;
}

/** Whether a signed order is SINGLE-VALUE on principal — `amount ==
 *  ceiling` (an `amountMax` of `0` is the wire's single-value sentinel:
 *  the ceiling falls back to `amount`, so it always passes). Load-bearing
 *  for the direct-fill affordance (#1145 round-2 Codex P2): see
 *  `signedFillCandidate` for why a RANGED signed order must never arm a
 *  direct fill. */
export function signedOrderIsSingleValue(order: SignedOrderWire): boolean {
  return signedOfferCeiling(order) === BigInt(order.amount);
}

/** Unfilled remainder of a signed order: `ceiling − filledAmount`,
 *  floored at 0 (a consumed/cancelled order has `filled == ceiling`). */
export function signedOfferRemaining(
  order: SignedOrderWire,
  filledAmount: string,
): bigint {
  let filled: bigint;
  try {
    filled = BigInt(filledAmount || '0');
  } catch {
    return 0n;
  }
  const ceiling = signedOfferCeiling(order);
  return ceiling > filled ? ceiling - filled : 0n;
}

/**
 * Build the canonical wire order from the ticket's `CreateOfferPayload` —
 * the SAME role-asymmetric mapping `createOffer` ships (lender floor =
 * min partial fill, borrower ceiling = rate input, etc.), plus the three
 * signed-offer-only fields the on-chain payload doesn't carry:
 *
 *  - `signer`  — the maker's address (lowercased; addresses are
 *    lowercase on the wire so the stored `order_json` is canonical).
 *  - `nonce`   — caller-supplied. The contract's nonces are ARBITRARY
 *    user-chosen values (`isSignedOfferNonceUsed(signer, nonce)` is a
 *    plain mapping; `invalidateSignedOfferNonce` batch-burns one value),
 *    not sequential — see {@link randomSignedOfferNonce}.
 *  - `deadline` — signature validity; see the ticket for the GTT/GTC
 *    deadline policy.
 *
 * Keys are emitted in canonical struct order so `JSON.stringify` of the
 * result is byte-identical to the indexer's stored `order_json`.
 */
export function wireFromCreatePayload(
  payload: CreateOfferPayload,
  signer: string,
  nonce: bigint,
  deadline: bigint,
): SignedOrderWire {
  return {
    offerType: String(payload.offerType),
    lendingAsset: payload.lendingAsset.toLowerCase(),
    amount: payload.amount.toString(),
    amountMax: payload.amountMax.toString(),
    interestRateBps: String(payload.interestRateBps),
    interestRateBpsMax: String(payload.interestRateBpsMax),
    collateralAsset: payload.collateralAsset.toLowerCase(),
    collateralAmount: payload.collateralAmount.toString(),
    collateralAmountMax: payload.collateralAmountMax.toString(),
    durationDays: String(payload.durationDays),
    assetType: String(payload.assetType),
    collateralAssetType: String(payload.collateralAssetType),
    tokenId: payload.tokenId.toString(),
    quantity: payload.quantity.toString(),
    collateralTokenId: payload.collateralTokenId.toString(),
    collateralQuantity: payload.collateralQuantity.toString(),
    prepayAsset: payload.prepayAsset.toLowerCase(),
    allowsPartialRepay: payload.allowsPartialRepay,
    allowsPrepayListing: payload.allowsPrepayListing,
    allowsParallelSale: payload.allowsParallelSale,
    expiresAt: payload.expiresAt.toString(),
    fillMode: String(payload.fillMode),
    periodicInterestCadence: String(payload.periodicInterestCadence),
    refinanceTargetLoanId: payload.refinanceTargetLoanId.toString(),
    useFullTermInterest: payload.useFullTermInterest,
    signer: signer.toLowerCase(),
    nonce: nonce.toString(),
    deadline: deadline.toString(),
  };
}

/**
 * Collapse a LENDER payload to the single-value shape a signed post must
 * carry to be consumable (#1145 round-2 Codex P2).
 *
 * `OfferMatchFacet._vetSignedOfferForMatch` requires a CONSTANT
 * collateral:principal ratio across the signed range before it will
 * materialize any slice:
 *
 *   `if (o.collateralAmount * ceiling != effCollMax * o.amount)
 *        revert SignedOfferRatioNotConstant();`
 *
 * A lender order's collateral is structurally single-value
 * (`LenderCollateralRangeNotAllowed` at materialize, mirrored by the
 * indexer's ingest gate), so with `collMin == collMax > 0` the check
 * reduces to `ceiling == amount` — a RANGED lender signed order
 * (`amount < amountMax`, e.g. the ticket's default 10% min-partial
 * floor) can NEVER pass the matcher; only a direct full fill could
 * consume it, while the book would advertise it as sliceable partial
 * depth. The only matcher-compatible lender shape is single-value, so:
 *
 *  - `amount` collapses to `amountMax` (the full size).
 *  - `fillMode` Partial is relabelled AON: a single-value non-AON order
 *    is already fillable ONLY as one whole fill (the matcher's minimum
 *    slice is `amount` = the full size), so AON is the honest wire tag
 *    rather than a behaviour change. IOC keeps its tag — its expiry
 *    semantics are load-bearing and a single-value IOC ("fill in full
 *    before the deadline") is already honest.
 *
 * BORROWER payloads pass through untouched: the ticket ships them
 * single-value on both legs already (`amount == amountMax`,
 * `collateralAmount == collateralAmountMax`), which satisfies the ratio
 * check as-is — and unlike lenders, a future ranged borrower order CAN
 * be matcher-compatible by ranging collateral proportionally (borrower
 * collateral ranges are allowed on-chain).
 *
 * Pure + idempotent: an already-single-value lender payload only gets
 * the Partial→AON relabel; everything else is returned unchanged.
 */
export function collapseForSignedPost(
  payload: CreateOfferPayload,
): CreateOfferPayload {
  if (payload.offerType !== 0) return payload; // borrower — see above
  const fillMode = payload.fillMode === 0 ? 1 : payload.fillMode;
  if (payload.amount === payload.amountMax && fillMode === payload.fillMode) {
    return payload;
  }
  return { ...payload, amount: payload.amountMax, fillMode };
}

/** Random 64-bit nonce. The contract's signed-offer nonces are ARBITRARY
 *  (a `signer → nonce → used` mapping, burned only by an explicit
 *  `invalidateSignedOfferNonce`), NOT sequential — so a random draw needs
 *  no on-chain read and can't collide with the maker's other live orders
 *  (64 bits ≫ any plausible order count). A per-order unique nonce also
 *  keeps `invalidateSignedOfferNonce` a single-order batch-cancel rather
 *  than accidentally revoking unrelated orders sharing a nonce. */
export function randomSignedOfferNonce(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// ---------------------------------------------------------------------------
// Ladder merge — signed rows as IndexedOffer-compatible book rows
// ---------------------------------------------------------------------------

/** The signed-origin tag carried by a merged book row — everything a
 *  taker fill or an on-chain cancel needs to replay the order. */
export interface SignedRowMeta {
  orderHash: string;
  signer: string;
  signature: string;
  order: SignedOrderWire;
  filledAmount: string;
}

/**
 * One book row as the desk ladder consumes it. Chain/indexer rows are
 * plain `IndexedOffer`s; signed off-chain orders are mapped into the
 * SAME shape and tagged `signed` — chosen over a parallel signed-level
 * type so `buildLadder` stays pure and single-sourced (one aggregation,
 * one sort, one cumulative sum) and a rate level can honestly mix
 * on-chain and signed depth. Consumers that must not treat a signed row
 * as an on-chain offer (taker deep links, previewMatch/matchOffers ids)
 * discriminate on the tag — `offerId` on a signed row is a sentinel
 * (-1), never an identity; `orderHash` is the identity.
 */
export type DeskBookRow = IndexedOffer & { signed?: SignedRowMeta };

/**
 * Map one indexer signed-book row into a ladder-consumable
 * {@link DeskBookRow}, or `null` when the row can't honestly rest on the
 * book (lapsed signature deadline, non-active status, malformed
 * numerics). Rate-side semantics match the on-chain rows exactly:
 * lender orders quote asks at `interestRateBps` (the floor), borrower
 * orders quote bids at `interestRateBpsMax` (the ceiling) — the same
 * headline `buildLadder` keys each side on. Remaining depth is
 * `ceiling(amountMax || amount) − filledAmount` via the `amountMax` /
 * `amountFilled` fields `offerRemaining` reads.
 */
export function signedRowToDeskRow(
  row: IndexedSignedOffer,
  chainId: number,
  nowSec: number,
): DeskBookRow | null {
  if (row.status !== 'active') return null;
  // A lapsed signature deadline makes the order unfillable even though
  // the (≤15 s stale) server copy still lists it; `deadline = 0` is the
  // contract's no-deadline sentinel. GTT expiry (`expiresAt`) is left to
  // `isLiveMarketRow`, same as on-chain rows.
  if (row.deadline !== 0 && row.deadline <= nowSec) return null;
  const o = row.order;
  let remaining: bigint;
  try {
    remaining = signedOfferRemaining(o, row.filledAmount);
  } catch {
    return null; // malformed numerics — never render garbage depth
  }
  return {
    chainId,
    // Sentinel — signed rows have no on-chain offer id until fill.
    // NEVER feed this to acceptOffer/previewMatch/deep links; the
    // ladder's consumers gate on the `signed` tag instead.
    offerId: -1,
    status: 'active',
    creator: o.signer,
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset,
    collateralAsset: o.collateralAsset,
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    principalLiquidity: 0,
    collateralLiquidity: 0,
    tokenId: o.tokenId,
    collateralTokenId: o.collateralTokenId,
    quantity: o.quantity,
    collateralQuantity: o.collateralQuantity,
    amount: o.amount,
    // ceiling/remaining semantics: offerRemaining() computes
    // `amountMax − amountFilled`, so ship the CEILING as amountMax.
    amountMax: signedOfferCeiling(o).toString(),
    amountFilled: (signedOfferCeiling(o) - remaining).toString(),
    interestRateBps: Number(o.interestRateBps),
    interestRateBpsMax: Number(o.interestRateBpsMax),
    collateralAmount: o.collateralAmount,
    durationDays: Number(o.durationDays),
    positionTokenId: '0',
    prepayAsset: o.prepayAsset,
    useFullTermInterest: o.useFullTermInterest,
    creatorRiskAndTermsConsent: true, // the maker's signature IS the consent
    allowsPartialRepay: o.allowsPartialRepay,
    firstSeenBlock: 0,
    firstSeenAt: 0,
    updatedAt: 0,
    expiresAt: Number(o.expiresAt),
    fillMode: Number(o.fillMode),
    signed: {
      orderHash: row.orderHash,
      signer: o.signer,
      signature: row.signature,
      order: o,
      filledAmount: row.filledAmount,
    },
  };
}
