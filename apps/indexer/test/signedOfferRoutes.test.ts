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
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { handleSignedOfferPost } from '../src/signedOfferRoutes';
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
    amount: '1000000000000000000',
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
