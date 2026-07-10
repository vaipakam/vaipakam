/**
 * Rate Desk phase 3 (#1131) — `POST /signed-offers` re-post semantics
 * (Codex #1145 round 2).
 *
 * The order hash binds every field, so an existing row IS the posted order.
 * What the route answers must depend on the row's lifecycle status:
 *
 *   - 'active'   → 200, the idempotent re-post (row untouched).
 *   - terminal   → 409 `{ error: 'order-terminal', status }` — the chain
 *     ledger is monotonic, a filled / cancelled / nonce_burned order can
 *     never become fillable again. The pre-fix behaviour returned a bare
 *     200 "ok" for these, telling the poster "accepted" while GET would
 *     never list the row and every on-chain fill attempt reverts.
 *
 * Everything up to the DB lookup is LOCAL (validation + EIP-712 recovery),
 * so these tests run offline with a stubbed D1. The 201 first-accept path
 * is exercised too: its best-effort chain-state gate is pointed at an
 * unroutable RPC, which the route deliberately treats as accept-and-warn.
 * The chain-state ingest-gate suite at the bottom (Codex #1145 r7) instead
 * stubs global fetch with a canned JSON-RPC responder so the gate's
 * nonce-used / at-ceiling / below-ceiling branches are pinned against
 * REAL eth_call answers.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Abi, AbiFunction, Hex } from 'viem';
import { encodeFunctionResult, getAbiItem, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DIAMOND_SIGNED_OFFER_ABI } from '../src/diamondAbi';
import {
  handleSignedOfferPost,
  handleSignedOffersGet,
} from '../src/signedOfferRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  SIGNED_OFFER_TYPES,
  orderHashOf,
  signedOfferDomain,
  toTypedMessage,
  type SignedOrderWire,
} from '../src/signedOfferEip712';
import { getChainConfigs, type Env } from '../src/env';

const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil key 0
const SIGNER = privateKeyToAccount(TEST_PK);
const CHAIN_ID = 84532; // Base Sepolia — present in the deployments bundle
const FUTURE = 4102444800; // 2100-01-01
/** In-horizon signature deadline for the GTC fixture — the desk ticket's
 *  own policy is chainNow + 7d, well inside the route's 30-day
 *  API-abuse cap on uncovered non-zero deadlines (#1145 round-2). */
const DEADLINE_7D = Math.floor(Date.now() / 1000) + 7 * 86_400;

function makeOrder(overrides: Partial<SignedOrderWire> = {}): SignedOrderWire {
  return {
    offerType: '0',
    lendingAsset: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    // Single-value principal — the desk's collapseForSignedPost shape for
    // lenders. A RANGED lender order with constant non-zero collateral can
    // never satisfy the matcher's constant-ratio vet and is now rejected at
    // ingest (see the r3 ratio-vet suite below), so the base fixture must
    // not carry that shape.
    amount: '5000000000000000000',
    amountMax: '5000000000000000000',
    interestRateBps: '500',
    interestRateBpsMax: '800',
    collateralAsset: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    collateralAmount: '2000000000000000000',
    collateralAmountMax: '2000000000000000000',
    durationDays: '30',
    assetType: '0',
    collateralAssetType: '0',
    tokenId: '0',
    quantity: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    prepayAsset: '0x0000000000000000000000000000000000000000',
    allowsPartialRepay: true,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    expiresAt: '0',
    fillMode: '0',
    periodicInterestCadence: '0',
    refinanceTargetLoanId: '0',
    useFullTermInterest: false,
    signer: SIGNER.address.toLowerCase(),
    nonce: '7',
    deadline: String(DEADLINE_7D),
    ...overrides,
  };
}

/** Minimal D1 stub: the existing-row SELECT answers `existingStatus`
 *  (null = no row), every write reports one changed row. */
function makeEnv(existingStatus: string | null): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () =>
            sql.includes('SELECT status FROM signed_offers') && existingStatus
              ? { status: existingStatus }
              : null,
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    // Unroutable on purpose — only the 201 path's BEST-EFFORT chain-state
    // gate touches it, and a failed read is accept-and-warn by design.
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as Env;
}

function diamondFor(env: Env): Hex {
  const chain = getChainConfigs(env).find((c) => c.id === CHAIN_ID);
  if (!chain) throw new Error('Base Sepolia missing from deployments bundle');
  return chain.diamond as Hex;
}

async function post(env: Env, order: SignedOrderWire): Promise<Response> {
  const signature = await SIGNER.signTypedData({
    domain: signedOfferDomain(CHAIN_ID, diamondFor(env)),
    types: SIGNED_OFFER_TYPES,
    primaryType: 'SignedOffer',
    message: toTypedMessage(order),
  });
  const req = new Request('http://indexer.test/signed-offers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId: CHAIN_ID, order, signature }),
  });
  return handleSignedOfferPost(req, env);
}

describe('POST /signed-offers — re-post status branching (Codex #1145 r2)', () => {
  it('re-posting an ACTIVE row stays the idempotent 200', async () => {
    const order = makeOrder();
    const res = await post(makeEnv('active'), order);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ chainId: CHAIN_ID, orderHash: orderHashOf(order) });
  });

  it.each(['filled', 'cancelled', 'nonce_burned'])(
    "re-posting a '%s' row returns 409 order-terminal with the status",
    async (status) => {
      const res = await post(makeEnv(status), makeOrder());
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: 'order-terminal', status });
    },
  );

  it('a first post (no row) still lands 201 with the chain gate best-effort-failing', async () => {
    const order = makeOrder();
    const res = await post(makeEnv(null), order);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ chainId: CHAIN_ID, orderHash: orderHashOf(order) });
  });
});

describe('POST /signed-offers — deadline horizon cap (Codex #1145 r2)', () => {
  const NOW = () => Math.floor(Date.now() / 1000);

  it('rejects a GTC order whose deadline exceeds now + 30d (the API-abuse cap)', async () => {
    // expiresAt 0 = GTC, so the deadline IS the order's validity bound;
    // a year-2100 signature is effectively unbounded exposure.
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: '0', deadline: String(FUTURE) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'deadline-above-horizon' });
  });

  it('rejects an above-horizon deadline that also outlives the advertised expiry', async () => {
    // GTT, but the deadline outlives expiresAt AND the horizon — the
    // uncovered tail is the same unbounded shape as the GTC case.
    const res = await post(
      makeEnv(null),
      makeOrder({
        expiresAt: String(NOW() + 10 * 86_400),
        deadline: String(FUTURE),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'deadline-above-horizon' });
  });

  it('accepts deadline = 0 (contract-GTC signature semantics, untouched)', async () => {
    const res = await post(makeEnv(null), makeOrder({ deadline: '0' }));
    expect(res.status).toBe(201);
  });

  it('accepts a beyond-horizon GTT deadline covered by expiresAt (signature dies with the offer)', async () => {
    // deadline == expiresAt at 90 days — the desk ticket's own GTT
    // policy; on-chain exposure is min(deadline, expiresAt), so the
    // 30-day cap must not reject it.
    const ninetyDays = String(NOW() + 90 * 86_400);
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: ninetyDays, deadline: ninetyDays }),
    );
    expect(res.status).toBe(201);
  });

  it('accepts an in-horizon GTC deadline (the ticket-policy 7d shape)', async () => {
    const res = await post(makeEnv(null), makeOrder());
    expect(res.status).toBe(201);
  });
});

describe('POST /signed-offers — expiresAt create-horizon cap (Codex #1145 r3)', () => {
  const NOW = () => Math.floor(Date.now() / 1000);
  const YEAR = 365 * 86_400;

  it('rejects expiresAt beyond now + 365d (OfferExpiryAboveCap mirror)', async () => {
    // 1h past the horizon — comfortably beyond even with clock skew
    // between the test's NOW() and the route's own clock read.
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: String(NOW() + YEAR + 3_600) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expiry-above-horizon' });
  });

  it('rejects a far-future expiresAt (year-2100) the old check let through', async () => {
    const res = await post(makeEnv(null), makeOrder({ expiresAt: String(FUTURE) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expiry-above-horizon' });
  });

  it('accepts expiresAt just under the horizon', async () => {
    // 1h inside — the route's clock can only be AT or AFTER the test's
    // NOW(), which moves the threshold later, never earlier, so this
    // margin is one-sided-safe.
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: String(NOW() + YEAR - 3_600) }),
    );
    expect(res.status).toBe(201);
  });

  it('accepts expiresAt exactly at now + 365d (cap is inclusive, like the contract)', async () => {
    // Route-clock >= test-clock ⇒ route threshold >= this value; the
    // contract's own check is `>` (strictly above the cap reverts).
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: String(NOW() + YEAR) }),
    );
    expect(res.status).toBe(201);
  });

  it('keeps GTC (expiresAt = 0) exempt from the horizon', async () => {
    const res = await post(makeEnv(null), makeOrder({ expiresAt: '0' }));
    expect(res.status).toBe(201);
  });

  it('a beyond-horizon deadline can no longer ride the expiresAt exemption past 365d', async () => {
    // deadline == expiresAt at 2 years: the 30d deadline cap's
    // covered-by-expiry exemption would allow the deadline, but the
    // expiry itself now fails the 365d create horizon first.
    const twoYears = String(NOW() + 2 * YEAR);
    const res = await post(
      makeEnv(null),
      makeOrder({ expiresAt: twoYears, deadline: twoYears }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expiry-above-horizon' });
  });
});

describe('POST /signed-offers — ranged constant-ratio vet (Codex #1145 r3)', () => {
  // Mirrors OfferMatchFacet._vetSignedOfferForMatch's
  // `collateralAmount * ceiling == effCollMax * amount` cross-multiplication
  // for ranged rows (amountMax > amount), which are matcher-only depth.

  it('rejects a ranged borrower order with non-proportional collateral', async () => {
    // The finding's own example: 100..1000 principal against 10..20
    // collateral — 10*1000 != 20*100, so no keeper slice can ever vet.
    const res = await post(
      makeEnv(null),
      makeOrder({
        offerType: '1',
        amount: '100',
        amountMax: '1000',
        collateralAmount: '10',
        collateralAmountMax: '20',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'ranged-collateral-ratio' });
  });

  it('accepts a ranged borrower order with proportional collateral', async () => {
    // 10*1000 == 100*100 — constant ratio across the range, sliceable.
    const res = await post(
      makeEnv(null),
      makeOrder({
        offerType: '1',
        amount: '100',
        amountMax: '1000',
        collateralAmount: '10',
        collateralAmountMax: '100',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('accepts a ranged order with the both-zero no-collateral carve-out', async () => {
    // collMin = collMax = 0 ⇒ 0*ceiling == 0*amount on-chain too — the
    // explicit no-collateral shape stays sliceable.
    const res = await post(
      makeEnv(null),
      makeOrder({
        amount: '100',
        amountMax: '1000',
        collateralAmount: '0',
        collateralAmountMax: '0',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('rejects a ranged lender order — constant collateral can never satisfy the ratio', async () => {
    // The pre-fix base fixture's shape: lender collateral is structurally
    // single-value, so with ceiling > amount the ratio is unsatisfiable —
    // the same reasoning the desk's collapseForSignedPost encodes.
    const res = await post(
      makeEnv(null),
      makeOrder({
        amount: '1000000000000000000',
        amountMax: '5000000000000000000',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'ranged-collateral-ratio' });
  });

  it('leaves single-value rows untouched (borrower collateral range still allowed)', async () => {
    // ceiling == amount ⇒ direct-fillable; the matcher-only ratio vet
    // must not reject an on-chain-legal borrower collateral range.
    const res = await post(
      makeEnv(null),
      makeOrder({
        offerType: '1',
        amount: '1000',
        amountMax: '1000',
        collateralAmount: '10',
        collateralAmountMax: '20',
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /signed-offers — static cadence gates (Codex #1145 r4)', () => {
  // Mirrors the two STATIC gates of OfferCreateFacet._validatePeriodicCadence:
  // Filter 1 (OfferCreateFacet.sol:1065-1075) — non-None cadence with
  // intervalDays(cadence) >= durationDays; and the multi-year mandatory-
  // cadence floor (:994-1034) — durationDays > 365 with cadence None.
  // Cadence wire values: 0 None, 1 Monthly (30d), 4 Annual (365d).

  it('rejects Monthly on a 30d order (interval == duration)', async () => {
    const res = await post(
      makeEnv(null),
      makeOrder({ periodicInterestCadence: '1', durationDays: '30' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cadence-interval-too-long' });
  });

  it('accepts Monthly on a 31d order (interval strictly below duration)', async () => {
    const res = await post(
      makeEnv(null),
      makeOrder({ periodicInterestCadence: '1', durationDays: '31' }),
    );
    expect(res.status).toBe(201);
  });

  it('rejects cadence None on a 366d order (multi-year mandatory floor)', async () => {
    const res = await post(makeEnv(null), makeOrder({ durationDays: '366' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cadence-required-multiyear' });
  });

  it('accepts cadence None on a 365d order (not multi-year; early return on-chain)', async () => {
    const res = await post(makeEnv(null), makeOrder({ durationDays: '365' }));
    expect(res.status).toBe(201);
  });

  it('accepts Annual on a 366d order (365 < 366 satisfies Filter 1, floor satisfied)', async () => {
    const res = await post(
      makeEnv(null),
      makeOrder({ periodicInterestCadence: '4', durationDays: '366' }),
    );
    expect(res.status).toBe(201);
  });
});

// ── GET /signed-offers — per-side price-relevant caps (Codex #1145 r4) ──
//
// The behaviour under test IS the SQL (per-side LIMIT applied within a
// price-ordered scan), so these run against a real in-memory SQLite
// database created from the REAL migration 0033 DDL — which also pins
// that the migration (incl. the two per-side price indexes) parses.

const MIGRATION_0033 = readFileSync(
  new URL('../migrations/0033_signed_offer_book.sql', import.meta.url),
  'utf8',
);
const LEND = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COLL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DAYS = 30;

interface SeedRow {
  orderHash: string;
  offerType: 0 | 1;
  rateBps: number;
  rateBpsMax: number;
  createdAt: number;
  expiresAt?: number;
  deadline?: number;
  status?: string;
}

function seedBook(rows: SeedRow[]): Env {
  const { db, d1 } = createSqliteD1([MIGRATION_0033]);
  const insert = db.prepare(
    `INSERT INTO signed_offers
       (chain_id, order_hash, signer, order_json, signature,
        offer_type, lending_asset, collateral_asset, duration_days,
        asset_type, collateral_asset_type,
        interest_rate_bps, interest_rate_bps_max,
        amount, amount_max, collateral_amount, collateral_amount_max,
        fill_mode, expires_at, deadline, nonce,
        status, filled_amount, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '0xsig', ?, ?, ?, ?, 0, 0, ?, ?,
             '100', '100', '10', '10', 0, ?, ?, '1', ?, '0', ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      CHAIN_ID,
      r.orderHash,
      SIGNER.address.toLowerCase(),
      r.offerType,
      LEND,
      COLL,
      DAYS,
      r.rateBps,
      r.rateBpsMax,
      r.expiresAt ?? 0,
      r.deadline ?? 0,
      r.status ?? 'active',
      r.createdAt,
      r.createdAt,
    );
  }
  return {
    DB: d1,
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env;
}

async function getBook(env: Env): Promise<{ orderHash: string }[]> {
  const req = new Request(
    `http://indexer.test/signed-offers?chainId=${CHAIN_ID}` +
      `&lendingAsset=${LEND}&collateralAsset=${COLL}&durationDays=${DAYS}`,
  );
  const res = await handleSignedOffersGet(req, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { offers: { orderHash: string }[] };
  return body.offers;
}

describe('GET /signed-offers — per-side price-relevant caps (Codex #1145 r4)', () => {
  it('lender spam cannot hide an older best ask: cap keeps the best-priced rows', async () => {
    // The finding scenario: 150 fresh off-market asks (rate 900) posted
    // AFTER two older, better-priced asks. The old newest-first LIMIT
    // returned only the spam; the price-relevant cap must keep the best
    // asks at the head and evict the newest spam beyond 100 rows.
    const rows: SeedRow[] = [
      { orderHash: 'ask-best', offerType: 0, rateBps: 100, rateBpsMax: 100, createdAt: 1_000 },
      { orderHash: 'ask-mid', offerType: 0, rateBps: 500, rateBpsMax: 500, createdAt: 1_500 },
    ];
    for (let i = 0; i < 150; i++) {
      rows.push({
        orderHash: `spam-${String(i).padStart(3, '0')}`,
        offerType: 0,
        rateBps: 900,
        rateBpsMax: 900,
        createdAt: 2_000 + i,
      });
    }
    const offers = await getBook(seedBook(rows));
    expect(offers).toHaveLength(100); // per-side cap
    expect(offers[0].orderHash).toBe('ask-best');
    expect(offers[1].orderHash).toBe('ask-mid');
    // Equal-priced spam fills the rest OLDER-first: spam-000..spam-097.
    expect(offers[2].orderHash).toBe('spam-000');
    expect(offers[99].orderHash).toBe('spam-097');
    expect(offers.map((o) => o.orderHash)).not.toContain('spam-149');
  });

  it('borrower bids rank highest-rate-first and are capped independently of lender spam', async () => {
    // 150 lender rows saturate THEIR side; the borrower side must still
    // return every bid, best (highest interestRateBpsMax) first.
    const rows: SeedRow[] = [
      { orderHash: 'bid-400', offerType: 1, rateBps: 0, rateBpsMax: 400, createdAt: 3_000 },
      { orderHash: 'bid-950', offerType: 1, rateBps: 0, rateBpsMax: 950, createdAt: 3_100 },
      { orderHash: 'bid-200', offerType: 1, rateBps: 0, rateBpsMax: 200, createdAt: 3_200 },
    ];
    for (let i = 0; i < 150; i++) {
      rows.push({
        orderHash: `ask-spam-${String(i).padStart(3, '0')}`,
        offerType: 0,
        rateBps: 900,
        rateBpsMax: 900,
        createdAt: 2_000 + i,
      });
    }
    const offers = await getBook(seedBook(rows));
    expect(offers).toHaveLength(103); // 100 asks + all 3 bids
    // Asks first (merged response), then bids by rate DESC.
    expect(offers.slice(100).map((o) => o.orderHash)).toEqual([
      'bid-950',
      'bid-400',
      'bid-200',
    ]);
  });

  it('equal-priced rows tie-break older-first (a same-price re-post cannot displace)', async () => {
    const offers = await getBook(
      seedBook([
        { orderHash: 'ask-newer', offerType: 0, rateBps: 300, rateBpsMax: 300, createdAt: 5_000 },
        { orderHash: 'ask-older', offerType: 0, rateBps: 300, rateBpsMax: 300, createdAt: 1_000 },
      ]),
    );
    expect(offers.map((o) => o.orderHash)).toEqual(['ask-older', 'ask-newer']);
  });

  it('freshness predicates still apply per side (expired / lapsed-deadline / terminal rows drop)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const offers = await getBook(
      seedBook([
        { orderHash: 'ask-live', offerType: 0, rateBps: 500, rateBpsMax: 500, createdAt: 1_000 },
        { orderHash: 'ask-expired', offerType: 0, rateBps: 100, rateBpsMax: 100, createdAt: 1_000, expiresAt: now - 60 },
        { orderHash: 'ask-deadline', offerType: 0, rateBps: 100, rateBpsMax: 100, createdAt: 1_000, deadline: now - 60 },
        { orderHash: 'ask-filled', offerType: 0, rateBps: 100, rateBpsMax: 100, createdAt: 1_000, status: 'filled' },
      ]),
    );
    expect(offers.map((o) => o.orderHash)).toEqual(['ask-live']);
  });
});

// ── POST /signed-offers — chain-state ingest gate (Codex #1145 r7) ──
//
// The gate's decision table needs REAL eth_call answers, so these tests
// stub global fetch with a canned JSON-RPC responder keyed on the two view
// selectors the route reads (derived from the same ABI the route imports —
// zero signature drift). D1 is the real in-memory SQLite adapter so the
// 201 path's stored `filled_amount` seed is asserted end-to-end, including
// through GET.

const RPC_MOCK = 'http://rpc.mock';

const SEL_NONCE_USED = toFunctionSelector(
  getAbiItem({
    abi: DIAMOND_SIGNED_OFFER_ABI as Abi,
    name: 'isSignedOfferNonceUsed',
  }) as AbiFunction,
);
const SEL_FILLED = toFunctionSelector(
  getAbiItem({
    abi: DIAMOND_SIGNED_OFFER_ABI as Abi,
    name: 'signedOfferFilledAmount',
  }) as AbiFunction,
);

interface RpcReq {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
}

/** Answer the gate's two eth_calls from canned chain state; anything else
 *  (other URLs, other methods, other selectors) throws loudly. */
function stubRpc(state: { nonceUsed: boolean; filled: bigint }): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.startsWith(RPC_MOCK)) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const raw =
        typeof init?.body === 'string'
          ? init.body
          : await new Request(url, init).text();
      const parsed = JSON.parse(raw) as RpcReq | RpcReq[];
      const answer = (r: RpcReq) => {
        if (r.method !== 'eth_call') {
          throw new Error(`unexpected RPC method ${r.method}`);
        }
        const data = (r.params[0] as { data: string }).data;
        let result: string;
        if (data.startsWith(SEL_NONCE_USED)) {
          result = encodeFunctionResult({
            abi: DIAMOND_SIGNED_OFFER_ABI as Abi,
            functionName: 'isSignedOfferNonceUsed',
            result: state.nonceUsed,
          });
        } else if (data.startsWith(SEL_FILLED)) {
          result = encodeFunctionResult({
            abi: DIAMOND_SIGNED_OFFER_ABI as Abi,
            functionName: 'signedOfferFilledAmount',
            result: state.filled,
          });
        } else {
          throw new Error(`unexpected eth_call selector ${data.slice(0, 10)}`);
        }
        return { jsonrpc: '2.0', id: r.id, result };
      };
      const payload = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
}

/** Real-SQLite env pointed at the fetch-stubbed RPC. */
function makeChainEnv() {
  const { db, d1 } = createSqliteD1([MIGRATION_0033]);
  const env = { DB: d1, RPC_BASE_SEPOLIA: RPC_MOCK } as unknown as Env;
  return { env, db };
}

/** The matcher-sliceable shape: ranged Partial borrower order with the
 *  constant collateral:principal ratio the r3 vet requires. Ceiling 1000. */
function rangedPartialOrder(
  overrides: Partial<SignedOrderWire> = {},
): SignedOrderWire {
  return makeOrder({
    offerType: '1',
    amount: '100',
    amountMax: '1000',
    collateralAmount: '10',
    collateralAmountMax: '100',
    ...overrides,
  });
}

describe('POST /signed-offers — chain-state ingest gate (Codex #1145 r7)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a below-ceiling partial fill on a ranged Partial order lands 201 with the remainder ledgered', async () => {
    // The finding scenario: the order was distributed out-of-band, took a
    // 300/1000 SignedOfferMatched slice, and is only NOW posted here. The
    // 700 remainder is live matcher depth — the old gate 409'd it.
    stubRpc({ nonceUsed: false, filled: 300n });
    const { env, db } = makeChainEnv();
    const order = rangedPartialOrder();
    const res = await post(env, order);
    expect(res.status).toBe(201);
    const row = db
      .prepare(
        `SELECT status, filled_amount FROM signed_offers WHERE order_hash = ?`,
      )
      .get(orderHashOf(order)) as { status: string; filled_amount: string };
    expect(row).toEqual({ status: 'active', filled_amount: '300' });
  });

  it('a ledger AT the ceiling stays 409 order-consumed (filled or cancel-poisoned)', async () => {
    stubRpc({ nonceUsed: false, filled: 1000n });
    const { env } = makeChainEnv();
    const res = await post(env, rangedPartialOrder());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order-consumed' });
  });

  it('an AON order with any non-zero ledger is 409 — at ceiling by construction', async () => {
    // Both on-chain AON consumers write 0 → ceiling in one step, so the
    // realistic non-zero AON ledger IS the ceiling (>= branch).
    stubRpc({ nonceUsed: false, filled: 5000000000000000000n });
    const { env } = makeChainEnv();
    const res = await post(env, makeOrder({ fillMode: '1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order-consumed' });
  });

  it('a below-ceiling non-zero ledger on a single-value order is 409 (unreachable-state defense)', async () => {
    // No contract path can leave a single-value (== AON-shaped) ledger
    // strictly between 0 and the ceiling; the defensive branch refuses to
    // advertise a remainder no fill path can consume.
    stubRpc({ nonceUsed: false, filled: 1n });
    const { env } = makeChainEnv();
    const res = await post(env, makeOrder({ fillMode: '1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order-consumed' });
  });

  it('a partially-filled ranged IOC order inside its window is live remainder too (201)', async () => {
    // _vetSignedOfferForMatch puts Ioc in the same partial-fillable branch
    // as Partial; only the GTT window (already enforced at validation /
    // GET / fill) distinguishes it.
    stubRpc({ nonceUsed: false, filled: 300n });
    const { env, db } = makeChainEnv();
    const order = rangedPartialOrder({
      fillMode: '2',
      expiresAt: String(Math.floor(Date.now() / 1000) + 10 * 86_400),
    });
    const res = await post(env, order);
    expect(res.status).toBe(201);
    const row = db
      .prepare(
        `SELECT status, filled_amount FROM signed_offers WHERE order_hash = ?`,
      )
      .get(orderHashOf(order)) as { status: string; filled_amount: string };
    expect(row).toEqual({ status: 'active', filled_amount: '300' });
  });

  it('a burned nonce stays 409 nonce-used (batch invalidation is terminal)', async () => {
    stubRpc({ nonceUsed: true, filled: 0n });
    const { env } = makeChainEnv();
    const res = await post(env, rangedPartialOrder());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nonce-used' });
  });

  it('an untouched ledger still lands 201 with filled_amount 0', async () => {
    stubRpc({ nonceUsed: false, filled: 0n });
    const { env, db } = makeChainEnv();
    const order = rangedPartialOrder();
    const res = await post(env, order);
    expect(res.status).toBe(201);
    const row = db
      .prepare(
        `SELECT status, filled_amount FROM signed_offers WHERE order_hash = ?`,
      )
      .get(orderHashOf(order)) as { status: string; filled_amount: string };
    expect(row).toEqual({ status: 'active', filled_amount: '0' });
  });

  it('GET serves the partially-filled row as active depth with the seeded filledAmount', async () => {
    stubRpc({ nonceUsed: false, filled: 300n });
    const { env } = makeChainEnv();
    const order = rangedPartialOrder();
    expect((await post(env, order)).status).toBe(201);
    vi.unstubAllGlobals(); // GET never touches the RPC

    const req = new Request(
      `http://indexer.test/signed-offers?chainId=${CHAIN_ID}` +
        `&lendingAsset=${order.lendingAsset}` +
        `&collateralAsset=${order.collateralAsset}` +
        `&durationDays=${order.durationDays}`,
    );
    const res = await handleSignedOffersGet(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      offers: { orderHash: string; status: string; filledAmount: string }[];
    };
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      orderHash: orderHashOf(order),
      status: 'active',
      filledAmount: '300',
    });
  });
});
