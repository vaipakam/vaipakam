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
  SIGNED_OFFER_FIELD_NAMES,
  orderHashOf,
  verifySignedOfferSignature,
  type SignedOrderWire,
} from './signedOfferEip712';

/** Open CORS. `max-age=15` — a signed book must be fresher than the 10s
 *  offer-projection reads' default is fine for, but candles-grade staleness
 *  (60s) would advertise consumed orders for a whole minute. */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=15',
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
/** Mirrors `LibVaipakam.MAX_INTEREST_BPS` — the create-time upper-sanity
 *  ceiling on `interestRateBpsMax` (`InterestRateAboveCeiling`). */
const MAX_INTEREST_BPS = 10_000n;

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
 * (`cfgMaxOfferDurationDays`; only the hard 4385 ceiling is static), the
 * fill-time expiry horizon (`OfferExpiryAboveCap` judges against
 * `block.timestamp` at fill, so an above-horizon `expiresAt` becomes
 * fillable as time advances), sanctions, per-asset pause, oracle-derived
 * collateral floors/ceilings, and the signer's vault funding.
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

  // expiresAt — uint64 GTT expiry; 0 = GTC. Reject already-lapsed windows.
  {
    const v = raw.expiresAt;
    if (typeof v !== 'string' || !DEC.test(v) || BigInt(v) > U64_MAX) {
      return { error: 'invalid-expiresAt' };
    }
    const b = BigInt(v);
    if (b !== 0n && (b <= BigInt(now) || b > TS_SANITY_MAX)) {
      return { error: 'invalid-expiresAt' };
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
  // must be distinct contracts (`SelfCollateralizedOffer`; the contract
  // exempts a zero lendingAsset, mirrored via the non-zero check).
  if (
    out.lendingAsset !== '0x0000000000000000000000000000000000000000' &&
    out.lendingAsset === out.collateralAsset
  ) {
    return { error: 'self-collateralized' };
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
 * idempotent re-post of an already-stored order; per-field 400s; 409 when
 * chain state says the order is already consumed / nonce-burned.
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
  // IS this order. Return 200 without touching the row — deliberately NOT
  // INSERT OR REPLACE: a blind REPLACE would resurrect a
  // filled/cancelled/nonce_burned row to status 'active' (the chain ledger
  // is monotonic — a consumed order can never become fillable again), and
  // would let a re-post clobber lifecycle columns the chainIndexer owns.
  try {
    const existing = await env.DB.prepare(
      `SELECT status FROM signed_offers WHERE chain_id = ? AND order_hash = ?`,
    )
      .bind(chainId, orderHash)
      .first<{ status: string }>();
    if (existing) {
      return jsonResponse({ chainId, orderHash }, 200);
    }
  } catch (err) {
    console.error('[signedOfferRoutes] existing-row lookup failed', err);
    return jsonResponse({ error: 'lookup-failed' }, 500);
  }

  // Chain-state ingest gate — reject orders the chain already knows are
  // consumed (filled/cancelled ⇒ signedOfferFilledAmount != 0) or
  // batch-invalidated (isSignedOfferNonceUsed). This closes the "posted
  // AFTER its lifecycle events were indexed" hole: the cursor is past those
  // events, so the handlers would never revisit them and the row would sit
  // 'active' forever. Cost: 2 eth_calls, only reachable AFTER the signature
  // verified (spam can't spend them) and inside the per-IP rate limit.
  //
  // BEST-EFFORT on RPC failure: accept + warn rather than fail closed. For
  // orders posted BEFORE consumption (the overwhelmingly common flow) the
  // lifecycle handlers reconcile within the scan cadence, and a taker who
  // hits the rare stale row gets a clean on-chain revert
  // (SignedOfferConsumed) — availability over strictness for an ingest gate.
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
      return jsonResponse({ error: 'order-consumed' }, 409);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '0', ?, ?)`,
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
        now,
        now,
      )
      .run();
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

/** Hard response cap — the book is per-market, and a single (pair, tenor)
 *  market with >200 live signed orders is beyond the desk's render depth;
 *  cursor pagination can follow if production signal ever wants it. */
const MAX_BOOK_ROWS = 200;

/**
 * GET /signed-offers?chainId=8453&lendingAsset=0x..&collateralAsset=0x..&durationDays=30
 *
 * The ACTIVE, unexpired signed book for one (pair, tenor) market. All three
 * market params are REQUIRED (an unscoped signed book has no consumer — the
 * desk always reads one market — and an accidental global page would
 * advertise the wrong market's rows). Rows are returned with the order JSON
 * parsed so takers can feed it straight into `acceptSignedOffer`.
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

  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = await env.DB.prepare(
      `SELECT order_hash, signer, order_json, signature, status,
              filled_amount, expires_at, deadline
         FROM signed_offers
        WHERE chain_id = ? AND status = 'active'
          AND lending_asset = ? AND collateral_asset = ? AND duration_days = ?
          AND (expires_at = 0 OR expires_at > ?)
          AND (deadline = 0 OR deadline > ?)
        ORDER BY created_at DESC, order_hash
        LIMIT ?`,
    )
      .bind(
        chainId,
        lendingAsset,
        collateralAsset,
        durationDays,
        now,
        now,
        MAX_BOOK_ROWS,
      )
      .all<SignedOfferRow>();
    const offers = (rows.results ?? []).map((r) => ({
      orderHash: r.order_hash,
      signer: r.signer,
      order: JSON.parse(r.order_json) as unknown,
      signature: r.signature,
      status: r.status,
      filledAmount: r.filled_amount,
      expiresAt: r.expires_at,
      deadline: r.deadline,
    }));
    return jsonResponse({ chainId, offers });
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
