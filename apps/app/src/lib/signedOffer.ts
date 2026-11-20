/**
 * Rate Desk phase 3, slice D (#1131) — pure signed-offer helpers for the
 * GASLESS off-chain order book (SignedOfferFacet / LibSignedOffer v0.5).
 *
 * Mirrors the indexer's `apps/indexer/src/signedOfferEip712.ts` (which in
 * turn mirrors `contracts/src/libraries/LibSignedOffer.sol`):
 *
 *  - `SIGNED_OFFER_TYPES.SignedOffer` lists the 36 fields in the SAME
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
import { hashStruct, type Hex } from 'viem';
import type { IndexedOffer, IndexedSignedOffer } from '../data/indexer';
import type { CreateOfferPayload } from './offerSchema';
import { lifRateBpsUp, type LifTerms } from './initiationFee';
import {
  SIGNED_OFFER_FIELDS,
  SIGNED_OFFER_FIELD_NAMES as SIGNED_OFFER_WIRE_FIELD_NAMES,
  NO_COLLECTION,
  NO_RATE_LINK,
  placementProblem,
  type SignedOfferPlacement,
  type SignedOrderWire,
} from '@vaipakam/lib/signedOfferWire';
import { signedOfferMessage, type SignedOfferMessage } from '@vaipakam/lib/signedOfferSet';

/** The 46-field SignedOffer typed-data description — struct order EXACTLY
 *  as `LibSignedOffer.SignedOffer` declares it (enums ⇒ uint8, GTT ⇒
 *  uint64). The list is `@vaipakam/lib/signedOfferWire`'s, the same one the
 *  indexer's ingest gate derives its typehash from (#3327: one statement,
 *  where the app used to carry its own copy). */
export const SIGNED_OFFER_TYPES = { SignedOffer: SIGNED_OFFER_FIELDS } as const;

/** The 46 field names in canonical struct order — the POST body /
 *  `order_json` key order the indexer stores and replays. */
export const SIGNED_OFFER_FIELD_NAMES: readonly string[] = SIGNED_OFFER_WIRE_FIELD_NAMES;

/** The wire shape the indexer's POST/GET routes speak: every uint as a
 *  decimal string, addresses lowercase 0x-40-hex, bytes32 lowercase hex,
 *  bools as booleans. Takers replay this verbatim into `acceptSignedOffer`.
 *  The type is `@vaipakam/lib/signedOfferWire`'s, derived from the one
 *  field list. */
export type { SignedOrderWire };

/** Wire → the bigint-typed message viem's typed-data encoder (and the
 *  `acceptSignedOffer` / `cancelSignedOffer` ABI tuple) expects. */
export function signedOfferTypedMessage(order: SignedOrderWire): SignedOfferMessage {
  return signedOfferMessage(order);
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

/** Submit-time safety margin (seconds) for the signed-order time
 *  windows — the same 60 s convention as the ticket's
 *  `EXPIRY_SUBMIT_MARGIN_SECONDS` (Codex #1134 round-4): wallet
 *  prompts and a possible classic-approval transaction sit between
 *  the preflight read and the fill landing, so a window that clears
 *  chain-now by less than this is treated as already shut. */
export const SIGNED_ORDER_SUBMIT_MARGIN_SECONDS = 60n;

/**
 * Whether BOTH of a signed order's time windows are still open at
 * `chainNow` (`block.timestamp` of the latest block — the chain-time
 * doctrine forbids the device clock here), with
 * {@link SIGNED_ORDER_SUBMIT_MARGIN_SECONDS} applied (Codex #1145
 * round-3 P2). Zero is each field's "no window" sentinel (GTC).
 *
 *  - `deadline` — maker-signature validity. `_vetSignedOffer` rejects
 *    `block.timestamp > deadline`.
 *  - `expiresAt` — the GTT expiry of the offer the fill MATERIALIZES.
 *    The fill routes through `createOffer`, which rejects
 *    `params.expiresAt <= block.timestamp` (`OfferExpiryInPast`) —
 *    equality IS expired, a STRICTER boundary than `_vetSignedOffer`'s
 *    own `>` check, so the preflight must judge `>=`-at-equality (plus
 *    the margin) or the taker signs and approves into a guaranteed
 *    revert.
 */
export function signedOrderTimeWindowsOpen(
  order: SignedOrderWire,
  chainNow: bigint,
): boolean {
  const horizon = chainNow + SIGNED_ORDER_SUBMIT_MARGIN_SECONDS;
  const deadline = BigInt(order.deadline);
  if (deadline !== 0n && deadline <= horizon) return false;
  const expiresAt = BigInt(order.expiresAt);
  if (expiresAt !== 0n && expiresAt <= horizon) return false;
  return true;
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
/** #1949 — the maker's Full tariff opt-in for a signed order: the opt-in flag, the
 *  ceiling on the maker's tariff (VPFI wei, required when opting in) and whether a
 *  downgrade is permitted. Absent ⇒ off, which is what the ticket signs today (the
 *  maker-side control is a separate card). */
export interface MakerFullIntent {
  full: boolean;
  maxCStar: bigint;
  allowDowngrade: boolean;
}

/** #3327 — the fee caps the maker signs: the protocol fees shown in the
 *  review, so a later fee rise refuses the fill instead of re-pricing it. */
export interface MakerFeeCaps {
  maxTreasuryFeeBps: number;
  maxLoanInitiationFeeBps: number;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** #3327 — the fill authorisation for an order with no co-signer: the
 *  `FillAuth` argument every fill entry takes, empty. */
export const NO_FILL_AUTH = { validUntil: 0n, coSignature: '0x' as Hex } as const;

/** #3327 part 2 — the `OfferSet` argument every fill entry takes: where the
 *  order sits in the set its maker signed with one signature (the other
 *  orders' struct hashes, in signing order, and its index), or the empty
 *  placement the contract reads as "signed alone". */
export function signedOfferSetArg(
  set: SignedOfferPlacement | null,
): { others: readonly Hex[]; index: bigint } {
  return set === null
    ? { others: [], index: 0n }
    : { others: set.others, index: BigInt(set.index) };
}

export function wireFromCreatePayload(
  payload: CreateOfferPayload,
  signer: string,
  nonce: bigint,
  deadline: bigint,
  feeCaps: MakerFeeCaps,
  makerFull?: MakerFullIntent,
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
    lifecycleFlex: '0',
    // #3682 — this app names no integrator.
    integrator: ZERO_ADDRESS,
    creatorFull: makerFull?.full ?? false,
    creatorMaxCStar: (makerFull?.maxCStar ?? 0n).toString(),
    creatorAllowFullDowngrade: makerFull?.allowDowngrade ?? false,
    maxTreasuryFeeBps: String(feeCaps.maxTreasuryFeeBps),
    maxLoanInitiationFeeBps: String(feeCaps.maxLoanInitiationFeeBps),
    // The app offers neither a named taker nor a co-signer yet (#3327
    // follow-ups); both are signed as "none".
    allowedTaker: ZERO_ADDRESS,
    coSigner: ZERO_ADDRESS,
    signer: signer.toLowerCase(),
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    // The app signs ordinary orders only; collection offers are posted
    // on-chain (#3328).
    ...NO_COLLECTION,
    ...NO_RATE_LINK,
  };
}

/**
 * Collapse a LENDER payload to the single-value shape a signed post must
 * carry to be consumable (#1145 round-2 Codex P2).
 *
 * `SignedOfferFacet._vetSignedOfferForMatch` requires a CONSTANT
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

/** #3327 — why a taker cannot fill a signed order, or `null` when nothing
 *  the order itself says stands in the way. Mirrors the refusals
 *  `LibSignedOffer.fillFailure` adds:
 *   - `taker`: the order names another wallet as its only taker;
 *   - `coSigner`: the order needs a fresh co-signature per fill, which this
 *     app cannot request yet (the fill would be refused without it);
 *   - `feeAboveCap`: a live protocol fee is above the maker's cap (only
 *     judged when `fees` is given). The initiation fee is term-scaled
 *     (#3649): its cap is compared, as the contract does, with the rate at
 *     the order's term rounded up;
 *   - `cancelled`: the nonce is below the signer's cancel floor (only
 *     judged when `cancelFloor` is given). */
export type SignedTakerRefusal = 'taker' | 'coSigner' | 'feeAboveCap' | 'cancelled';

export function signedOrderTakerRefusal(
  order: SignedOrderWire,
  taker: string | undefined,
  live?: {
    fees?: { treasuryFeeBps: number; lifTerms: LifTerms };
    cancelFloor?: bigint;
  },
): SignedTakerRefusal | null {
  if (order.allowedTaker !== ZERO_ADDRESS && order.allowedTaker !== taker?.toLowerCase()) {
    return 'taker';
  }
  if (order.coSigner !== ZERO_ADDRESS) return 'coSigner';
  if (live?.cancelFloor !== undefined && BigInt(order.nonce) < live.cancelFloor) return 'cancelled';
  if (
    live?.fees !== undefined &&
    (live.fees.treasuryFeeBps > Number(order.maxTreasuryFeeBps) ||
      lifRateBpsUp(live.fees.lifTerms, Number(order.durationDays)) >
        Number(order.maxLoanInitiationFeeBps))
  ) {
    return 'feeAboveCap';
  }
  return null;
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** Random 64-bit nonce at or above the signer's cancel floor. The
 *  contract's signed-offer nonces are ARBITRARY (a `signer → nonce → used`
 *  mapping, burned only by an explicit `invalidateSignedOfferNonce`), NOT
 *  sequential — so a random draw can't collide with the maker's other live
 *  orders (64 bits ≫ any plausible order count), and a per-order unique
 *  nonce keeps `invalidateSignedOfferNonce` a single-order cancel. #3327:
 *  every order of the signer with a nonce below `floor`
 *  (`signedOfferCancelFloor`) is cancelled, so the draw starts at it. */
export function randomSignedOfferNonce(floor: bigint = 0n): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  // The draw stays inside [floor, 2^256 - 1]: a floor near the top of the
  // range leaves less than 64 bits of room, and `floor + n` would then
  // exceed uint256 and the signature could never be encoded or filled.
  const room = MAX_UINT256 - floor;
  return floor + (room >= n ? n : n % (room + 1n));
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
  /** #3327 part 2 — the order's place in the set its maker signed; null
   *  when it was signed alone. */
  set: SignedOfferPlacement | null;
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
  // #3327 part 2 — a set order's fill needs its placement to check the
  // signature, so a row naming a malformed one cannot be filled.
  const set = row.set ?? null;
  if (set !== null && placementProblem(set) !== null) return null;
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
      set,
    },
  };
}
