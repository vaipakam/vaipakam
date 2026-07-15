/**
 * Rate Desk phase 3 (#1131) — REST handlers for the SIGNED-offer book (the
 * off-chain half of the v0.5/v0.6 signed-offer contracts;
 * SignedOfferBookV05Design.md §1 scoped this out of the contract PR to
 * apps/indexer).
 *
 * Two routes:
 *
 *   POST /signed-offers  — a maker (or their dapp) publishes an
 *     EIP-712-signed gasless order. The Worker verifies it LOCALLY (shape +
 *     struct hash + signature recovery) before accepting — the spam/garbage
 *     gate for a public write surface — then stores the exact replay payload
 *     plus promoted scoping columns in D1 (`signed_offers`, migration 0033).
 *
 *   GET /signed-offers   — the market-scoped active book for one
 *     (pair, tenor) market. Returns the order JSON + signature verbatim so a
 *     taker can replay them into `acceptSignedOffer` / `matchSignedOffer`.
 *
 * Posture mirrors the one existing app-facing POST
 * (`handleLoanPrepayMatchSource`, loanRoutes.ts): per-IP rate-limit FIRST
 * (no-op when the binding isn't provisioned), strict per-field validation
 * with per-field 400s, open CORS, `jsonResponse` idioms. The book is public
 * data by design — anyone can verify any row's signature themselves, and the
 * on-chain fill path re-verifies everything (`LibSignedOffer.verify` +
 * `_vetSignedOffer`), so a stale or hostile cache can never bind a signer to
 * terms they didn't sign; the worst it can do is advertise an unfillable
 * order, which reverts at accept.
 */

import { type Address, type Hex } from 'viem';
import { createPublicClient, http } from 'viem';
import { type Env, getChainConfigs, type ChainConfig } from './env';
import { DIAMOND_SIGNED_OFFER_ABI } from './diamondAbi';
import {
  refreshOneMarketSummary,
  seedMarketSweepCursorIfAbsent,
} from './marketSummary';
import {
  SIGNED_OFFER_FIELD_NAMES,
  orderHashOf,
  verifySignedOfferSignature,
  type SignedOrderWire,
} from './signedOfferEip712';

/** Open CORS. `no-store` (Codex #1145 r8 P3) — the desk's mutation flows
 *  (gasless post / cancel / fill) invalidate their react-query caches and
 *  refetch THIS URL immediately; any HTTP-layer freshness window (the
 *  original max-age=15) let the browser/proxy hand that refetch the
 *  pre-mutation body, silently defeating the invalidation. The desk
 *  already self-paces at a 15s poll, so an HTTP cache adds nothing a
 *  well-behaved client needs — correctness wins over the marginal
 *  shared-cache savings. */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function chainConfig(env: Env, chainId: number): ChainConfig | undefined {
  try {
    return getChainConfigs(env).find((c) => c.id === chainId);
  } catch {
    return undefined;
  }
}

function parseChainId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Strict order validation ─────────────────────────────────────────

const HEX40 = /^0x[0-9a-f]{40}$/; // lowercase-normalized before testing
const HEX40_ANYCASE = /^0x[0-9a-fA-F]{40}$/;
/** Canonical decimal string — no sign, no leading zeros ('0' allowed).
 *  Canonical-form strictness matters: '01' and '1' hash identically once
 *  BigInt-coerced, but would store two different order_json payloads. */
const DEC = /^(0|[1-9][0-9]*)$/;
const U256_MAX = (1n << 256n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
/** Timestamp sanity ceiling — 9999-12-31T23:59:59Z. Anything above is
 *  malformed input, never a deadline a wallet UI would produce (a signer who
 *  wants "no deadline" uses 0, which the contract treats as GTC). Keeps the
 *  INTEGER columns within SQLite/Number-safe range. */
const TS_SANITY_MAX = 253402300799n;
/** API-abuse horizon cap on NON-ZERO signature deadlines that are the
 *  order's TRUE validity bound (Codex #1145 round-2 P2) — i.e. any
 *  deadline not covered by the order's own advertised `expiresAt`. The
 *  desk ticket's GTC policy signs `chainNow + 7d`; 30 days gives
 *  third-party integrators generous room while still refusing the
 *  "effectively unbounded signature" shape (a far-future deadline on a
 *  GTC order is irrevocable without a gas-costing on-chain cancel).
 *  `deadline = 0` keeps its contract-GTC semantics untouched (the GET
 *  filter honors it — earlier-round decision); a non-zero deadline
 *  `<= expiresAt` is always allowed regardless of horizon, because the
 *  signature then dies with the advertised GTT expiry (the ticket's own
 *  GTT policy) and on-chain exposure is `min(deadline, expiresAt)`
 *  anyway (`_vetSignedOffer` checks both). */
const DEADLINE_HORIZON_SECONDS = 30n * 86_400n;
/** Mirrors `LibVaipakam.MAX_OFFER_EXPIRY_HORIZON` (365 days,
 *  LibVaipakam.sol:401) — the create-time expiry horizon every fill path
 *  re-enforces at materialize (`OfferExpiryAboveCap`,
 *  `OfferCreateFacet._writeOfferPrincipalFields`). A non-zero `expiresAt`
 *  beyond `now + 365d` means every fill attempted TODAY is a guaranteed
 *  revert — the row would rest as unfillable depth until enough time
 *  passes; reject at ingest and let the maker re-post once the horizon
 *  covers their expiry (Codex #1145 r3 P2). This also bounds the
 *  DEADLINE_HORIZON_SECONDS exemption below: a non-zero deadline
 *  `<= expiresAt` stays exempt from the 30-day cap, but since `expiresAt`
 *  itself is now capped at 365d the exemption can no longer be stretched
 *  past 365 days either. */
const EXPIRY_HORIZON_SECONDS = 365n * 86_400n;
/** Mirrors `LibVaipakam.MAX_INTEREST_BPS` — the create-time upper-sanity
 *  ceiling on `interestRateBpsMax` (`InterestRateAboveCeiling`). */
const MAX_INTEREST_BPS = 10_000n;
/** Mirrors `LibVaipakam.intervalDays` (LibVaipakam.sol:6031-6043) — the
 *  per-cadence checkpoint interval in days, keyed by the wire enum value
 *  (`PeriodicInterestCadence`: 0 None, 1 Monthly, 2 Quarterly,
 *  3 SemiAnnual, 4 Annual). Values are the PERIODIC_INTERVAL_*_DAYS
 *  constants (LibVaipakam.sol:493-496); None maps to 0 on-chain and is
 *  handled separately by the gates below. */
const CADENCE_INTERVAL_DAYS: Record<string, number> = {
  '1': 30, // Monthly    — PERIODIC_INTERVAL_MONTHLY_DAYS
  '2': 90, // Quarterly  — PERIODIC_INTERVAL_QUARTERLY_DAYS
  '3': 180, // SemiAnnual — PERIODIC_INTERVAL_SEMI_ANNUAL_DAYS
  '4': 365, // Annual     — PERIODIC_INTERVAL_ANNUAL_DAYS
};

/** uint256-in-decimal-string field names (beyond the specially-bounded ones
 *  handled inline below). */
const U256_FIELDS = [
  'amount',
  'amountMax',
  'interestRateBps',
  'interestRateBpsMax',
  'collateralAmount',
  'collateralAmountMax',
  'tokenId',
  'quantity',
  'collateralTokenId',
  'collateralQuantity',
  'refinanceTargetLoanId',
  'nonce',
] as const;

/** uint8 enum fields with their inclusive max (LibVaipakam enums:
 *  OfferType 0..1, AssetType 0..2, FillMode 0..2,
 *  PeriodicInterestCadence 0..4). */
const ENUM_FIELDS: Record<string, number> = {
  offerType: 1,
  assetType: 2,
  collateralAssetType: 2,
  fillMode: 2,
  periodicInterestCadence: 4,
};

const ADDRESS_FIELDS = [
  'lendingAsset',
  'collateralAsset',
  'prepayAsset',
  'signer',
] as const;

const BOOL_FIELDS = [
  'allowsPartialRepay',
  'allowsPrepayListing',
  'allowsParallelSale',
  'useFullTermInterest',
] as const;

/**
 * Validate the POSTed order strictly and return the CANONICAL wire order
 * (addresses lowercased, field order fixed) or a per-field error string.
 *
 * Two layers of checks:
 *
 *  1. Shape + local bounds (enum ranges, duration 1..4385, timestamp
 *     sanity) — the garbage-gate: values no honest signer flow can produce
 *     and that would otherwise pollute the queryable columns.
 *  2. STATIC fill-path materialization invariants (Codex #1145 round-1) —
 *     every fill path (`acceptSignedOffer`, `acceptSignedOfferWithPermit`,
 *     the v0.6 matcher's `matchSignedOffer` slices) materializes the order
 *     through `OfferCreateFacet.createSignedOfferVault/Wallet`, which
 *     re-validates it as a fresh offer. An order violating any of those
 *     time-independent invariants is a GUARANTEED revert at fill — storing
 *     it would advertise an actively harmful row: a taker can be prompted
 *     to sign AcceptTerms and mine an approval for an order that can never
 *     fill. Each check below is commented with the exact contract error it
 *     mirrors (see `_materializeSignedOffer`, `_createOfferSetup`,
 *     `_writeOfferPrincipalFields`, `_writeOfferCollateralFields`).
 *
 * Deliberately NOT mirrored (they re-run on-chain at fill and mirroring
 * would drift): everything DYNAMIC — the governance-tunable duration cap
 * (`cfgMaxOfferDurationDays`; only the hard 4385 ceiling is static),
 * sanctions, per-asset pause, oracle-derived collateral floors/ceilings,
 * the signer's vault funding, and `_validatePeriodicCadence`'s three
 * DYNAMIC cadence filters — the `periodicInterestEnabled` kill switch
 * (governance-tunable protocol config), the both-legs-liquid gate
 * (oracle classification), and the principal-vs-
 * `minPrincipalForFinerCadence` threshold rows (oracle price + tunable
 * threshold). Only that function's two STATIC cadence gates are mirrored
 * — see step (b2) below (Codex #1145 r4). (The fill-time expiry horizon
 * (`OfferExpiryAboveCap`) IS mirrored — see EXPIRY_HORIZON_SECONDS: it
 * judges against `block.timestamp` at fill, so an above-horizon
 * `expiresAt` is guaranteed-unfillable at ingest time even though it
 * would drift fillable later; Codex #1145 r3.)
 */
function validateOrder(
  raw: Record<string, unknown>,
  now: number,
): { order: SignedOrderWire } | { error: string } {
  // Exactly the 28 struct fields — unknown keys are rejected so order_json
  // stays the canonical replay payload (extra junk would survive into the
  // stored JSON otherwise).
  const keys = Object.keys(raw);
  if (keys.length !== SIGNED_OFFER_FIELD_NAMES.length) {
    return { error: 'order-field-count' };
  }
  for (const k of keys) {
    if (!SIGNED_OFFER_FIELD_NAMES.includes(k)) {
      return { error: `order-unknown-field-${k}` };
    }
  }

  const out: Record<string, unknown> = {};

  for (const f of ADDRESS_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'string' || !HEX40_ANYCASE.test(v)) {
      return { error: `invalid-${f}` };
    }
    out[f] = v.toLowerCase();
  }
  // Zero-address gate (Codex #1145 r2) — the shape regex above accepts
  // 0x000…0 for every address field, but for three of the four it is
  // guaranteed-garbage:
  //   - lendingAsset / collateralAsset: every fill path materializes through
  //     `createOffer`, which classifies BOTH legs via
  //     `OracleFacet.checkLiquidity` — and that reverts `InvalidAsset()` on
  //     address(0) (OracleFacet.sol:137). A zero-leg row would sit 'active'
  //     in the book while being unfillable by construction.
  //   - signer: ECDSA recovery can never yield address(0), so the signature
  //     check below already rejects it — the explicit check here just turns
  //     an opaque 'bad-signature' into a per-field error.
  // `prepayAsset` deliberately KEEPS the zero sentinel: zero there is the
  // contract's "no prepay asset" value, not a missing field.
  for (const f of ['lendingAsset', 'collateralAsset', 'signer'] as const) {
    if (out[f] === '0x0000000000000000000000000000000000000000') {
      return { error: `zero-${f}` };
    }
  }
  for (const f of BOOL_FIELDS) {
    if (typeof raw[f] !== 'boolean') return { error: `invalid-${f}` };
    out[f] = raw[f];
  }
  for (const f of U256_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'string' || !DEC.test(v) || BigInt(v) > U256_MAX) {
      return { error: `invalid-${f}` };
    }
    out[f] = v;
  }
  for (const [f, max] of Object.entries(ENUM_FIELDS)) {
    const v = raw[f];
    if (typeof v !== 'string' || !DEC.test(v) || Number(v) > max) {
      return { error: `invalid-${f}` };
    }
    out[f] = v;
  }

  // durationDays — the contracts' hard governance ceiling is
  // MAX_OFFER_DURATION_DAYS_CEIL = 4385 (same bound parseMarketFilter uses).
  {
    const v = raw.durationDays;
    if (typeof v !== 'string' || !DEC.test(v)) return { error: 'invalid-durationDays' };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 4385) {
      return { error: 'invalid-durationDays' };
    }
    out.durationDays = v;
  }

  // amount — the matcher rejects a zero signed minimum (#616 round-3) and
  // createOffer requires a positive principal, so a zero-amount order is
  // unfillable garbage by construction.
  if (BigInt(out.amount as string) === 0n) return { error: 'invalid-amount' };

  // expiresAt — uint64 GTT expiry; 0 = GTC. Reject already-lapsed windows,
  // then cap the window to the contract's 365-day create horizon (Codex
  // #1145 r3 P2): `OfferCreateFacet._writeOfferPrincipalFields` reverts
  // `OfferExpiryAboveCap` when `expiresAt > block.timestamp +
  // LibVaipakam.MAX_OFFER_EXPIRY_HORIZON`, so a beyond-horizon expiry is a
  // guaranteed revert on every fill attempted now (see
  // EXPIRY_HORIZON_SECONDS, incl. its interplay with the deadline
  // exemption below). The TS_SANITY_MAX branch keeps its own error code —
  // a year-9999 timestamp is malformed input, not an out-of-policy window.
  {
    const v = raw.expiresAt;
    if (typeof v !== 'string' || !DEC.test(v) || BigInt(v) > U64_MAX) {
      return { error: 'invalid-expiresAt' };
    }
    const b = BigInt(v);
    if (b !== 0n && (b <= BigInt(now) || b > TS_SANITY_MAX)) {
      return { error: 'invalid-expiresAt' };
    }
    if (b !== 0n && b > BigInt(now) + EXPIRY_HORIZON_SECONDS) {
      return { error: 'expiry-above-horizon' };
    }
    out.expiresAt = v;
  }

  // deadline — signature validity; 0 = no deadline (contract-side GTC).
  {
    const v = raw.deadline;
    if (typeof v !== 'string' || !DEC.test(v) || BigInt(v) > U256_MAX) {
      return { error: 'invalid-deadline' };
    }
    const b = BigInt(v);
    if (b !== 0n && (b <= BigInt(now) || b > TS_SANITY_MAX)) {
      return { error: 'invalid-deadline' };
    }
    // Horizon cap (see DEADLINE_HORIZON_SECONDS): a non-zero deadline
    // beyond now + 30d is rejected UNLESS the order's own `expiresAt`
    // covers it (GTT: signature dies with the offer, so the deadline is
    // not the validity bound). `expiresAt` was validated just above, so
    // `out.expiresAt` is trustworthy here.
    if (
      b !== 0n &&
      b > BigInt(now) + DEADLINE_HORIZON_SECONDS &&
      (out.expiresAt === '0' || b > BigInt(out.expiresAt as string))
    ) {
      return { error: 'deadline-above-horizon' };
    }
    out.deadline = v;
  }

  // ── Static fill-path materialization invariants (Codex #1145 r1) ──
  // Checked in the order the fill path hits them so a multi-violation
  // order reports the same FIRST reason the live revert would.

  // (a) v0.5 supported shape — `_materializeSignedOffer` /
  // `_resolveSignedOfferStakeAsset` (OfferCreateFacet): BOTH legs must
  // be ERC-20 (`SignedOfferUnsupportedShape`; NFT lender / NFT-rental
  // funding is deferred past v0.5)…
  if (out.assetType !== '0' || out.collateralAssetType !== '0') {
    return { error: 'unsupported-asset-type' };
  }
  // …and refinance-tagged signed offers are out of v0.5 scope
  // (`SignedOfferUnsupportedShape`).
  if (BigInt(out.refinanceTargetLoanId as string) !== 0n) {
    return { error: 'unsupported-refinance' };
  }
  // (b) `_createOfferSetup` self-lending guard: principal and collateral
  // must be distinct contracts (`SelfCollateralizedOffer`). The contract
  // exempts a zero lendingAsset from this guard, but the zero-address gate
  // above already rejected that shape, so a plain equality check suffices.
  if (out.lendingAsset === out.collateralAsset) {
    return { error: 'self-collateralized' };
  }

  // (b2) `_validatePeriodicCadence` (called at the tail of
  // `_createOfferSetup`, i.e. BEFORE the principal/collateral writes
  // mirrored in (c)/(d)) — its two STATIC cadence-vs-duration gates
  // (Codex #1145 r4). Both read only the order's own fields; the
  // function's OTHER filters are dynamic and deliberately unmirrored
  // (see the doc comment above), but those can only ADD revert reasons
  // for a violating order, never admit it — so each rejection below is
  // a guaranteed `CadenceNotAllowed` (or earlier) revert on EVERY fill
  // path, since they all materialize through `createSignedOfferVault/
  // Wallet` → `_createOfferSetup`.
  {
    const cadence = out.periodicInterestCadence as string;
    const durationDays = Number(out.durationDays as string);
    // Filter 1 (OfferCreateFacet.sol:1065-1075): a non-None cadence
    // whose checkpoint interval lands at or after maturity is
    // meaningless — `intervalDays(cadence) >= durationDays` reverts
    // `CadenceNotAllowed` (e.g. Monthly on a 7d or 30d order).
    if (
      cadence !== '0' &&
      CADENCE_INTERVAL_DAYS[cadence] >= durationDays
    ) {
      return { error: 'cadence-interval-too-long' };
    }
    // Multi-year mandatory-cadence floor (OfferCreateFacet.sol:994-1034):
    // `durationDays > 365` with cadence None reverts `CadenceNotAllowed`
    // unconditionally — the early return at :995-1001 only fires for
    // `None && !isMultiYear`, and the `isMultiYear && cadence == None`
    // branch at :1025-1034 carries no liquidity/threshold guard. (The
    // function's own comment at :967-973 claims multi-year ILLIQUID
    // loans skip the mandatory Annual floor, but the code reverts
    // regardless — the deployed code is the authority this mirror
    // follows.)
    if (cadence === '0' && durationDays > 365) {
      return { error: 'cadence-required-multiyear' };
    }
  }

  // (c) `_writeOfferPrincipalFields` — principal + rate invariants.
  const amount = BigInt(out.amount as string);
  const amountMax = BigInt(out.amountMax as string);
  // `AmountMaxMustBePositive` — Phase 2 (#183) dropped the 0 ⇒ collapse
  // fallback; a zero max is fail-loud at materialize.
  if (amountMax === 0n) return { error: 'invalid-amountMax' };
  // `InvalidAmountRange` — max below min.
  if (amountMax < amount) return { error: 'amount-range' };
  const rate = BigInt(out.interestRateBps as string);
  const rateMax = BigInt(out.interestRateBpsMax as string);
  // `InvalidRateRange` — max below min (zero on BOTH ends is a
  // legitimate no-interest shape and stays accepted).
  if (rateMax < rate) return { error: 'rate-range' };
  // `InterestRateAboveCeiling` — LibVaipakam.MAX_INTEREST_BPS = 10000.
  if (rateMax > MAX_INTEREST_BPS) return { error: 'rate-above-ceiling' };
  // `AonRequiresSingleValueAmount` — a range under AON is meaningless.
  if (out.fillMode === '1' && amount !== amountMax) {
    return { error: 'aon-single-value' };
  }
  // `IocRequiresExpiry` — IOC's defining knob IS the window.
  if (out.fillMode === '2' && out.expiresAt === '0') {
    return { error: 'ioc-requires-expiry' };
  }

  // (d) `_writeOfferCollateralFields` — collateral invariants. The v0.5
  // shape gate above guarantees ERC-20/ERC-20, so the contract's
  // "true ERC-20 loan" strictness applies to every stored order.
  // `allowsParallelSale` needs Borrower + NFT collateral + AON
  // (`ParallelSaleRequiresBorrowerOffer` / `…RequiresNFTCollateral`) —
  // under the ERC-20-collateral-only v0.5 shape it ALWAYS reverts.
  if (out.allowsParallelSale === true) {
    return { error: 'unsupported-parallel-sale' };
  }
  const collateralAmount = BigInt(out.collateralAmount as string);
  const collateralAmountMax = BigInt(out.collateralAmountMax as string);
  // `CollateralMustBePositive` / `CollateralAmountMaxMustBePositive` —
  // both-zero passes (the explicit no-collateral lender shape); a mixed
  // zero is the silent-zero bug the contract fail-louds on.
  if (!(collateralAmount === 0n && collateralAmountMax === 0n)) {
    if (collateralAmount === 0n) return { error: 'invalid-collateralAmount' };
    if (collateralAmountMax === 0n) {
      return { error: 'invalid-collateralAmountMax' };
    }
  }
  // `InvalidCollateralAmountRange` — max below min.
  if (collateralAmountMax < collateralAmount) {
    return { error: 'collateral-range' };
  }
  // `LenderCollateralRangeNotAllowed` — lender collateral is single-value
  // by #164's structural invariant (their collateralAmount IS the derived
  // requirement); only Borrower offers range on collateral.
  if (out.offerType === '0' && collateralAmountMax !== collateralAmount) {
    return { error: 'lender-collateral-range' };
  }
  // `SignedOfferRatioNotConstant` (OfferMatchFacet._vetSignedOfferForMatch,
  // Codex #1145 r3 P2) — a RANGED order (`amountMax > amount`) is consumed
  // through `matchSignedOffer` slices (direct fill is disabled for ranged
  // principal), and the matcher requires a CONSTANT collateral:principal
  // ratio across the signed range before it will slice, cross-multiplied
  // to avoid division:
  //     effCollMax = collateralAmountMax == 0 ? collateralAmount
  //                                           : collateralAmountMax;
  //     if (collateralAmount * ceiling != effCollMax * amount) revert;
  // `ceiling` is `amountMax` here (its 0-sentinel collapse can't apply —
  // a zero amountMax was rejected above). Mirrored EXACTLY so a ranged row
  // with non-proportional collateral (e.g. 100..1000 principal against
  // 10..20 collateral) can't rest as ladder depth no keeper can consume.
  // The both-zero no-collateral shape passes trivially (0 == 0), same as
  // on-chain; single-value rows (amountMax == amount) are untouched.
  if (amountMax > amount) {
    const effCollMax =
      collateralAmountMax === 0n ? collateralAmount : collateralAmountMax;
    if (collateralAmount * amountMax !== effCollMax * amount) {
      return { error: 'ranged-collateral-ratio' };
    }
  }

  return { order: out as unknown as SignedOrderWire };
}

/** Build the canonical order_json — the 28 fields in struct order, addresses
 *  already lowercased by validateOrder. Stable key order means byte-identical
 *  JSON for the same order, so idempotent re-posts are trivially comparable. */
function canonicalOrderJson(order: SignedOrderWire): string {
  const o: Record<string, unknown> = {};
  for (const f of SIGNED_OFFER_FIELD_NAMES) {
    o[f] = (order as unknown as Record<string, unknown>)[f];
  }
  return JSON.stringify(o);
}

// ── POST /signed-offers ─────────────────────────────────────────────

/**
 * POST /signed-offers
 *
 * Body: `{ chainId: number, order: <28-field SignedOffer wire object>,
 *          signature: 0x-hex }` — every uint as a decimal string, addresses
 * 0x-40-hex, bools as booleans (the same shape GET returns and takers replay
 * on-chain).
 *
 * Acceptance pipeline (each step's rationale inline):
 *   1. per-IP rate limit (no-op when the binding isn't provisioned),
 *   2. strict field validation (local, free),
 *   3. EIP-712 struct hash + signature recovery (local, ~free — no RPC spend
 *      before this holds, so spam can't amplify into chain subrequests),
 *   4. best-effort chain-state check (2 eth_calls — see below),
 *   5. insert.
 *
 * Responses: 201 `{ chainId, orderHash }` on first accept; 200 on an
 * idempotent re-post of an already-stored ACTIVE order; per-field 400s; 409
 * when the stored row is already terminal (filled / cancelled /
 * nonce_burned) or chain state says the order is consumed (ledger AT the
 * ceiling — a BELOW-ceiling partial fill on a ranged non-AON order is live
 * matcher depth and is ACCEPTED with `filled_amount` initialized to the
 * observed cumulative; Codex #1145 r7) or nonce-burned.
 */
export async function handleSignedOfferPost(
  req: Request,
  env: Env,
): Promise<Response> {
  // Rate-limit BEFORE the validation gates (the loanRoutes #335 posture) so
  // a scripted attacker spamming malformed payloads can't burn the D1/CPU
  // budget on invalid-input branches. No-op when unprovisioned.
  if (env.SIGNED_OFFERS_RATELIMIT) {
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.SIGNED_OFFERS_RATELIMIT.limit({ key: ip });
    if (!success) {
      return jsonResponse({ error: 'rate-limited' }, 429);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (body === null || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid-body' }, 400);
  }
  const b = body as Record<string, unknown>;

  if (
    typeof b.chainId !== 'number' ||
    !Number.isInteger(b.chainId) ||
    b.chainId <= 0
  ) {
    return jsonResponse({ error: 'bad-chain-id' }, 400);
  }
  const chainId = b.chainId;
  // Fail closed on unindexed chains: without an RPC + Diamond config the
  // lifecycle handlers can never reconcile this book, so accepting the row
  // would advertise orders whose consumption we'd never observe.
  const chain = chainConfig(env, chainId);
  if (!chain) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }

  // Signature: 65-byte ECDSA (130 hex) or EIP-2098 compact (128 hex).
  if (
    typeof b.signature !== 'string' ||
    !/^0x[0-9a-fA-F]+$/.test(b.signature) ||
    (b.signature.length !== 132 && b.signature.length !== 130)
  ) {
    return jsonResponse({ error: 'invalid-signature-shape' }, 400);
  }
  const signature = b.signature as Hex;

  if (b.order === null || typeof b.order !== 'object') {
    return jsonResponse({ error: 'invalid-order' }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const validated = validateOrder(b.order as Record<string, unknown>, now);
  if ('error' in validated) {
    return jsonResponse({ error: validated.error }, 400);
  }
  const order = validated.order;

  // Recompute the EIP-712 struct hash (= the ledger key) and verify the
  // signature recovers order.signer — all local computation via viem, with
  // the domain {name:'Vaipakam SignedOffer', version:'1', chainId,
  // verifyingContract: diamond} the contracts pin (LibSignedOffer.sol).
  // EOA-only in v1; ERC-1271 contract signers are rejected here (see the
  // limitation note on verifySignedOfferSignature).
  //
  // Sanctions screening is deliberately NOT done at ingest — the indexer has
  // no sanctions-oracle client, and the on-chain fill path Tier-1-gates both
  // parties (`_assertNotSanctioned` in createOffer/acceptOffer), so a
  // sanctioned signer's order can sit here but can never bind on-chain.
  const orderHash = orderHashOf(order);
  const sigOk = await verifySignedOfferSignature(
    order,
    signature,
    chainId,
    chain.diamond as Address,
  );
  if (!sigOk) {
    return jsonResponse({ error: 'bad-signature' }, 400);
  }

  // Idempotent re-post: the order hash binds every field, so an existing row
  // IS this order. An ACTIVE row returns 200 without being touched, a
  // terminal row returns 409 — deliberately NOT INSERT OR REPLACE: a blind
  // REPLACE would resurrect a filled/cancelled/nonce_burned row to status
  // 'active' (the chain ledger is monotonic — a consumed order can never
  // become fillable again), and would let a re-post clobber lifecycle
  // columns the chainIndexer owns.
  try {
    const existing = await env.DB.prepare(
      `SELECT status FROM signed_offers WHERE chain_id = ? AND order_hash = ?`,
    )
      .bind(chainId, orderHash)
      .first<{ status: string }>();
    if (existing) {
      if (existing.status === 'active') {
        return jsonResponse({ chainId, orderHash }, 200);
      }
      // Terminal re-post (Codex #1145 r2): the chain ledger is monotonic —
      // a filled / cancelled / nonce_burned order can never become fillable
      // again. A bare 200 here would tell the poster "accepted" while GET
      // will never list the row and every on-chain fill attempt reverts
      // (`SignedOfferConsumed` / `SignedOfferNonceInvalidated`); surface the
      // dead order instead, with its terminal status so the caller can tell
      // "you cancelled this" apart from "this already filled".
      return jsonResponse(
        { error: 'order-terminal', status: existing.status },
        409,
      );
    }
  } catch (err) {
    console.error('[signedOfferRoutes] existing-row lookup failed', err);
    return jsonResponse({ error: 'lookup-failed' }, 500);
  }

  // Chain-state ingest gate — reject orders the chain already knows are
  // dead: batch-invalidated (isSignedOfferNonceUsed — terminal for every
  // order under the nonce) or ledgered AT the ceiling
  // (signedOfferFilledAmount >= amountMax ⇒ fully filled OR cancelled: the
  // cancel path poisons the ledger to the ceiling as its unfillable
  // marker). This closes the "posted AFTER its lifecycle events were
  // indexed" hole: the cursor is past those events, so the handlers would
  // never revisit them and the row would sit 'active' forever. Cost: 2
  // eth_calls, only reachable AFTER the signature verified (spam can't
  // spend them) and inside the per-IP rate limit.
  //
  // A ledger value BELOW the ceiling is NOT consumption (Codex #1145 r7):
  // a ranged order distributed out-of-band can take SignedOfferMatched
  // slices before ever being posted here, and the contract treats the
  // remainder as live matcher-fillable depth (`_vetSignedOfferForMatch`
  // only reverts SignedOfferConsumed at `filled >= ceiling`). The
  // SignedOfferMatched handler models exactly that (row stays 'active'
  // with a ratcheted filled_amount below the ceiling) — so this gate
  // accepts the remainder and seeds `filled_amount` with the observed
  // cumulative instead of rejecting still-live depth.
  //
  // BEST-EFFORT on RPC failure: accept + warn rather than fail closed. For
  // orders posted BEFORE consumption (the overwhelmingly common flow) the
  // lifecycle handlers reconcile within the scan cadence, and a taker who
  // hits the rare stale row gets a clean on-chain revert
  // (SignedOfferConsumed) — availability over strictness for an ingest gate.
  // The same posture applies to the partial-fill seed: an already-partially-
  // filled order posted during an RPC blip lands with filled_amount '0'
  // until the next SignedOfferMatched slice / scan reconciles it —
  // acceptable, because the direct-fill decision re-vets the LIVE ledger
  // client-side and `matchSignedOffer` reads the on-chain ledger anyway.
  let initialFilledAmount = '0';
  try {
    const client = createPublicClient({ transport: http(chain.rpc) });
    const [nonceUsed, filled] = await Promise.all([
      client.readContract({
        address: chain.diamond as Address,
        abi: DIAMOND_SIGNED_OFFER_ABI,
        functionName: 'isSignedOfferNonceUsed',
        args: [order.signer as Address, BigInt(order.nonce)],
      }) as Promise<boolean>,
      client.readContract({
        address: chain.diamond as Address,
        abi: DIAMOND_SIGNED_OFFER_ABI,
        functionName: 'signedOfferFilledAmount',
        args: [orderHash],
      }) as Promise<bigint>,
    ]);
    if (nonceUsed) {
      return jsonResponse({ error: 'nonce-used' }, 409);
    }
    if (filled !== 0n) {
      // The contract's `_ceiling` collapses a zero amountMax to `amount`,
      // but validateOrder rejected zero (`invalid-amountMax`), so the
      // ceiling here is always amountMax itself.
      const ceiling = BigInt(order.amountMax);
      if (filled >= ceiling) {
        return jsonResponse({ error: 'order-consumed' }, 409);
      }
      // 0 < filled < ceiling — accept as live remainder ONLY for a shape
      // the matcher can still consume: RANGED (amountMax > amount) and
      // non-AON. Mode reasoning:
      //   - Partial (0) ranged: the canonical matcher-slice shape; the
      //     on-chain vet even guarantees the remainder >= the signed
      //     minimum (`postRemainder != 0 && < amount` reverts).
      //   - AON (1): validateOrder pins amount == amountMax, and both
      //     on-chain consumers write the ledger 0 → ceiling in one step
      //     (direct accept sets the ceiling; the matcher's AON branch
      //     requires filled == 0 && fillAmount == ceiling), so any
      //     non-zero AON ledger is AT the ceiling and the branch above
      //     already 409'd it. The explicit check below is defensive.
      //   - IOC (2) ranged: slices exactly like Partial while its GTT
      //     window is open (`_vetSignedOfferForMatch` puts Ioc in the
      //     same else-branch as Partial; the window itself is enforced
      //     by validateOrder at ingest, the GET freshness predicates,
      //     and on-chain at fill) — so a below-ceiling IOC remainder is
      //     live depth too and is accepted.
      // A SINGLE-VALUE (amount == amountMax) ledger can also only be 0 or
      // ceiling on-chain (direct fill and cancel both write the ceiling;
      // the matcher's min-slice rule makes the only legal slice the full
      // amount) — a below-ceiling non-zero value there is unreachable
      // state; treat it as consumed rather than advertise a remainder no
      // path can fill.
      if (order.fillMode === '1' || BigInt(order.amount) >= ceiling) {
        return jsonResponse({ error: 'order-consumed' }, 409);
      }
      initialFilledAmount = filled.toString();
    }
  } catch (err) {
    console.warn(
      '[signedOfferRoutes] chain-state ingest check failed; accepting (lifecycle handlers reconcile)',
      err,
    );
  }

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO signed_offers
        (chain_id, order_hash, signer, order_json, signature,
         offer_type, lending_asset, collateral_asset, duration_days,
         asset_type, collateral_asset_type,
         interest_rate_bps, interest_rate_bps_max,
         amount, amount_max, collateral_amount, collateral_amount_max,
         fill_mode, expires_at, deadline, nonce,
         status, filled_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
      .bind(
        chainId,
        orderHash,
        order.signer,
        canonicalOrderJson(order),
        signature,
        Number(order.offerType),
        order.lendingAsset,
        order.collateralAsset,
        Number(order.durationDays),
        Number(order.assetType),
        Number(order.collateralAssetType),
        Number(order.interestRateBps),
        Number(order.interestRateBpsMax),
        order.amount,
        order.amountMax,
        order.collateralAmount,
        order.collateralAmountMax,
        Number(order.fillMode),
        Number(order.expiresAt),
        Number(order.deadline),
        order.nonce,
        // '0' on a fresh order; the observed on-chain cumulative when the
        // ingest gate saw a live below-ceiling remainder (Codex #1145 r7).
        initialFilledAmount,
        now,
        now,
      )
      .run();
    // #1270 — gasless posts never cross the chain scan, so the POST
    // maintains its own market's discovery row synchronously (the
    // scan-tail sweep would also catch it via updated_at, but only at
    // scan cadence — a fresh signed-only market should be discoverable
    // immediately). Fail-open: the row is persisted and served by
    // GET /signed-offers regardless; a summary hiccup self-heals on
    // the next sweep.
    try {
      await refreshOneMarketSummary(
        env.DB,
        chainId,
        {
          lendingAsset: order.lendingAsset,
          collateralAsset: order.collateralAsset,
          durationDays: Number(order.durationDays),
        },
        now,
      );
      // #1270 (Codex #1288 r5) — best-effort OPTIMIZATION: on a chain
      // empty at migration this POST is the first market write, so seed
      // the sweep watermark now to spare the first ingest sweep a
      // one-time `since = 0` full recompute. Not correctness-critical:
      // if this seed fails (or is skipped), the sweep's absent-cursor
      // fallback is `since = 0`, which still reflects this row exactly
      // (Codex #1288 r6) — which is why it stays inside the same
      // fail-open block as the refresh.
      await seedMarketSweepCursorIfAbsent(env.DB, chainId, now);
    } catch (err) {
      console.error('[signedOfferRoutes] market_summary refresh failed', err);
    }
    return jsonResponse({ chainId, orderHash }, 201);
  } catch (err) {
    console.error('[signedOfferRoutes] insert failed', err);
    return jsonResponse({ error: 'insert-failed' }, 500);
  }
}

// ── GET /signed-offers ──────────────────────────────────────────────

/** Interest-rate bps promoted columns are small ints; the money-shaped
 *  columns stay decimal strings end-to-end. */
interface SignedOfferRow {
  order_hash: string;
  signer: string;
  order_json: string;
  signature: string;
  status: string;
  filled_amount: string;
  expires_at: number;
  deadline: number;
}

/** Hard response cap PER SIDE, and the capped slice is PRICE-RELEVANT,
 *  not newest-first (Codex #1145 r4 P2): gasless posts are cheap and only
 *  per-IP rate-limited, so under a newest-first global cap 200 fresh
 *  off-market orders could hide an older best bid/ask entirely — wrong
 *  displayed top-of-book while the better rows are still active. Each
 *  side instead returns its best-priced rows (see the per-side ORDER BY
 *  below), tie-broken OLDER-first so an equal-priced spam row can never
 *  displace an earlier one. 100 per side is beyond the desk's render
 *  depth; cursor pagination can follow if production signal wants it. */
const MAX_BOOK_ROWS_PER_SIDE = 100;

/** Per-side cap for SIGNER-SCOPED reads (Codex #1269 r3) — the public
 *  100 exists to keep spam from drowning the ladder, but a scoped read
 *  returns only the caller-named maker's own rows (spam can't inflate
 *  it), and the desk's cancel UI is sourced solely from this response:
 *  a clipped own-orders page leaves live fillable signatures the maker
 *  cannot reach to revoke. 500/side covers any realistic single-market
 *  maker; the `truncated` flag still reports honestly beyond it. */
const SIGNER_BOOK_ROWS_PER_SIDE = 500;

/**
 * GET /signed-offers?chainId=8453&lendingAsset=0x..&collateralAsset=0x..&durationDays=30
 *
 * The ACTIVE, unexpired signed book for one (pair, tenor) market. All three
 * market params are REQUIRED (an unscoped signed book has no consumer — the
 * desk always reads one market — and an accidental global page would
 * advertise the wrong market's rows). Rows are returned with the order JSON
 * parsed so takers can feed it straight into `acceptSignedOffer`.
 *
 * Capping is per-side and by EXECUTABLE PRICE (Codex #1145 r4 P2): a
 * LENDER order (offer_type 0) rests as an ASK at `interest_rate_bps` —
 * the rate the taker pays, so LOWEST is best — and a BORROWER order
 * (offer_type 1) rests as a BID at `interest_rate_bps_max` (the ceiling
 * the borrower will pay), so HIGHEST is best. Up to
 * MAX_BOOK_ROWS_PER_SIDE best-priced rows per side, ties older-first,
 * asks then bids in the merged `offers` array (per-row shape unchanged;
 * the desk rebuilds its price ladder from the rows, so array order is
 * not load-bearing — only membership is).
 *
 * Expiry is enforced query-side the same way /offers/markets treats lazy GTT
 * expiry: `expires_at = 0` is GTC, `deadline = 0` is no-deadline (contract
 * semantics — `_vetSignedOffer` only rejects when non-zero and lapsed).
 */
export async function handleSignedOffersGet(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }

  // Market scope — the parseMarketFilter idiom (lowercased addresses, 400 on
  // malformed, tenor bounded by the 4385 governance ceiling) but with all
  // three params REQUIRED.
  const lendingAsset = (url.searchParams.get('lendingAsset') ?? '').toLowerCase();
  const collateralAsset = (url.searchParams.get('collateralAsset') ?? '').toLowerCase();
  const durationRaw = url.searchParams.get('durationDays');
  if (!HEX40.test(lendingAsset)) {
    return jsonResponse({ error: 'bad-lending-asset' }, 400);
  }
  if (!HEX40.test(collateralAsset)) {
    return jsonResponse({ error: 'bad-collateral-asset' }, 400);
  }
  const durationDays = durationRaw === null ? NaN : Number(durationRaw);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 4385) {
    return jsonResponse({ error: 'bad-duration-days' }, 400);
  }
  // #1247 PAG-011 — optional signer scope: the price-ordered per-side
  // cap silently drops lower-priority depth, which is fine for a
  // top-of-book ladder but must never hide a maker's OWN cancellable
  // orders behind other makers' depth. A signer-scoped read returns
  // that wallet's rows regardless of book position.
  const signerRaw = url.searchParams.get('signer');
  const signer =
    signerRaw !== null && /^0x[0-9a-fA-F]{40}$/.test(signerRaw)
      ? signerRaw.toLowerCase()
      : null;
  if (signerRaw !== null && signer === null) {
    return jsonResponse({ error: 'bad-signer' }, 400);
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    // One query per side so each cap is applied within a PRICE-ordered
    // slice (see MAX_BOOK_ROWS_PER_SIDE). `orderBy` is a whitelisted
    // literal chosen here, never caller input.
    const perSideCap =
      signer !== null ? SIGNER_BOOK_ROWS_PER_SIDE : MAX_BOOK_ROWS_PER_SIDE;
    const sideQuery = (offerType: 0 | 1, orderBy: string) =>
      env.DB.prepare(
        `SELECT order_hash, signer, order_json, signature, status,
                filled_amount, expires_at, deadline
           FROM signed_offers
          WHERE chain_id = ? AND status = 'active'
            AND lending_asset = ? AND collateral_asset = ? AND duration_days = ?
            AND offer_type = ?
            ${signer !== null ? 'AND signer = ?' : ''}
            AND (expires_at = 0 OR expires_at > ?)
            AND (deadline = 0 OR deadline > ?)
          ORDER BY ${orderBy}, created_at ASC, order_hash
          LIMIT ?`,
      )
        .bind(
          ...[
            chainId,
            lendingAsset,
            collateralAsset,
            durationDays,
            offerType,
            ...(signer !== null ? [signer] : []),
            now,
            now,
            // One past the cap so truncation is DETECTED, not guessed
            // (#1247 PAG-011 — the slice below keeps the cap; the flag
            // tells clients depth was dropped).
            perSideCap + 1,
          ],
        )
        .all<SignedOfferRow>();
    const [asks, bids] = await Promise.all([
      // Lender side — ASK at interest_rate_bps: lowest first.
      sideQuery(0, 'interest_rate_bps ASC'),
      // Borrower side — BID at interest_rate_bps_max: highest first.
      sideQuery(1, 'interest_rate_bps_max DESC'),
    ]);
    const askRows = asks.results ?? [];
    const bidRows = bids.results ?? [];
    const truncated =
      askRows.length > perSideCap || bidRows.length > perSideCap;
    const offers = [
      ...askRows.slice(0, perSideCap),
      ...bidRows.slice(0, perSideCap),
    ].map((r) => ({
      orderHash: r.order_hash,
      signer: r.signer,
      order: JSON.parse(r.order_json) as unknown,
      signature: r.signature,
      status: r.status,
      filledAmount: r.filled_amount,
      expiresAt: r.expires_at,
      deadline: r.deadline,
    }));
    return jsonResponse({ chainId, offers, truncated });
  } catch (err) {
    console.error('[signedOfferRoutes] book read failed', err);
    return jsonResponse({ error: 'book-failed' }, 500);
  }
}

function chainConfigured(env: Env, chainId: number): boolean {
  return chainConfig(env, chainId) !== undefined;
}

/** Preflight echo for /signed-offers — open CORS, GET + POST (this surface
 *  carries the Worker's second POST endpoint after #335's match-source). */
export function handleSignedOffersPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// Re-exported for the unit tests (shape validation is pure logic worth
// pinning independently of the route plumbing).
export { validateOrder, canonicalOrderJson };
