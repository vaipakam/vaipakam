/**
 * T-090 v1.1 (#389) Sub 3 (#418) + v1.1 GA (#426) — Fusion
 * resolver-pickup proxy.
 *
 * Endpoint: `POST /intent/fusion/post`
 *
 * The dapp calls this after the borrower's commit transaction
 * lands. Body carries:
 *   - `chainId`           — chain the commit lives on
 *   - `orderHash`         — canonical 1inch LOP v4 hash the commit
 *                           registered for ERC-1271 (on the borrower's
 *                           vault for a swap-to-repay order, #1566 S3e;
 *                           on the diamond for a buyback)
 *   - `order`             — full structured Fusion order the
 *                           resolver auction needs to fill (read
 *                           back from `GET /loans/:id` →
 *                           `swapToRepayIntent` via the indexer)
 *   - `commitTxHash`      — borrower-side tx that registered the
 *                           commit on-chain (used for telemetry +
 *                           the resolver-side audit trail)
 *
 * Why this lives on the agent rather than the dapp:
 *   - The 1inch Fusion API key stays Vaipakam-side (rate-limit
 *     protection + key rotation without dapp redeploys).
 *   - Centralised observability — every committed intent flows
 *     through one Worker we can monitor for fill-rate + resolver-
 *     set health (governance-tuning signal for future allow-list
 *     curation).
 *
 * GA wiring (#426): validates the payload, posts to 1inch's
 * Fusion resolver-pickup endpoint with the
 * `ONEINCH_API_KEY` secret server-side, and passes the
 * upstream JSON response through to the dapp. If the secret is
 * unset (alpha-era deploys), the handler degrades to the
 * pre-GA queued-ack behaviour so a dapp expecting the
 * forward-compatible response shape still gets a clean
 * success-path resolution — the on-chain commit is the source
 * of truth either way.
 *
 * Stage-3 split note: no funds move through this handler.
 * Compromise of the `ONEINCH_API_KEY` secret rate-limits
 * resolver visibility but can't pull collateral — that lives
 * behind the order maker's ERC-1271 signature on the orderHash
 * (the borrower's vault, which asks the diamond; the diamond
 * itself for a buyback), not the agent's auth.
 */

import type { Env } from './env';
import { slotRefusal, takeCredentialSlot } from './rateLimit';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { readJsonBody } from '@vaipakam/lib/requestBody';
import { redactedError } from '@vaipakam/lib/errorDescription';

/** A Fusion post: the order struct, its hash, the commit transaction hash
 *  and a signature (#2756). */
const MAX_FUSION_POST_BODY_BYTES = 16 * 1024;

// T-090 v1.2 #428 — keccak256 of the canonical
// `SwapToRepayIntentCommitted(uint256,bytes32,address,uint256,uint256,uint64)`
// event signature, pre-computed at module load.
const SWAP_TO_REPAY_INTENT_COMMITTED_TOPIC0 = keccak256(
  toBytes(
    'SwapToRepayIntentCommitted(uint256,bytes32,address,uint256,uint256,uint64)',
  ),
);

// T-087 Sub 3.C — keccak256 of the buyback validation event signature.
// `commitBuybackIntentValidated` emits `BuybackIntentValidated(bytes32)`
// after the on-chain Fusion-order-template validation passes. The
// agent preflights against this topic instead of the swap-to-repay
// topic when `kind === 'buyback'`.
const BUYBACK_INTENT_VALIDATED_TOPIC0 = keccak256(
  toBytes('BuybackIntentValidated(bytes32)'),
);

// T-090 v1.2 #428 — per-chain RPC binding lookup. Reuses the same
// per-chain RPC secrets the other agent handlers read from. Only the
// Fusion-supported chains are listed: the preflight runs after the
// unsupported-chain queued-ack (#2756), so no other chain reaches it.
function rpcForChain(env: Env, chainId: number): string | undefined {
  if (chainId === 1) return env.RPC_ETH;
  if (chainId === 8453) return env.RPC_BASE;
  if (chainId === 42161) return env.RPC_ARB;
  if (chainId === 10) return env.RPC_OP;
  if (chainId === 56) return env.RPC_BNB;
  if (chainId === 137) return env.RPC_POLYGON;
  return undefined;
}

// T-090 v1.2 #431 — switched from Fusion's resolver-pickup
// endpoint to 1inch's Limit Order Protocol orderbook endpoint
// because:
//   - Fusion v2 requires `quoteId` from a preceding 1inch
//     quote/build round-trip; Vaipakam's commit flow constructs
//     the order shape from on-chain context (collateral
//     amount + live floor + canonical extension), so we have
//     no quoteId to pass.
//   - The LOP orderbook accepts arbitrary signed orders.
//     Resolvers (any party watching the public LOP orderbook)
//     pick up the order on profitability; ERC-1271 validation
//     against the order maker's `isValidSignature` (the borrower's
//     vault for a swap-to-repay order, #1566 S3e; the diamond for
//     a buyback) still happens the same way at fill time.
// Codex round-2 PR #430 P2 — host is `api.1inch.com`, NOT
// `.dev`. The `.dev` host does not serve the same routes on
// the current API portal.
// Codex round-1 PR #435 P1 — 1inch's current docs list
// `/orderbook/v4.1/{chain}` for the submit shape we use; v4.0
// is documented as deprecated. Updated to v4.1.
const LOP_ORDERBOOK_BASE_URL = 'https://api.1inch.com/orderbook/v4.1';

/// Chain IDs 1inch Fusion supports. Codex round-1 PR #430 P2 —
/// without this allow-list, a dapp on Base Sepolia (84532) or any
/// other testnet would forward to a Fusion path that doesn't exist
/// and every commit would silently fail at the upstream level.
/// Source: 1inch Fusion supported-chains documentation. Mainnet
/// only; Vaipakam testnets are gated to the queued-ack fallback
/// regardless of the secret being set.
const FUSION_SUPPORTED_CHAIN_IDS = new Set<number>([
  1,      // Ethereum
  8453,   // Base
  42161,  // Arbitrum One
  10,     // Optimism
  56,     // BNB Chain
  137,    // Polygon PoS
]);

/// Request body shape — matches the structured order projection
/// the indexer's `GET /loans/:id` returns as `payload.swapToRepayIntent`.
///
/// T-087 Sub 3.C — the `kind` discriminator selects the on-chain
/// preflight: 'swap_to_repay' (default; legacy) matches
/// `SwapToRepayIntentCommitted` event topic; 'buyback' matches
/// `BuybackIntentValidated`.
interface IntentFusionPostRequest {
  chainId: number;
  kind?: 'swap_to_repay' | 'buyback';
  orderHash: `0x${string}`;
  order: {
    maker: `0x${string}`;
    receiver: `0x${string}`;
    makerAsset: `0x${string}`;
    takerAsset: `0x${string}`;
    makerAmount: string;
    takerAmount: string;
    deadline: number;
    salt: string;
    makerTraits: string;
    extension: `0x${string}`;
  };
  commitTxHash: `0x${string}`;
}

/** The two order kinds this endpoint forwards. */
export type IntentKind = 'swap_to_repay' | 'buyback';

/**
 * #1566 S3e — the order's parties, as far as they can be checked before
 * any RPC call. Every order pays the Vaipakam diamond (its receiver), and a
 * buyback order's maker is the diamond as well. A swap-to-repay order's
 * maker is the borrower's vault, which only the on-chain preflight can
 * confirm (it must equal the maker `getIntentCommit` derives on-chain), so a
 * swap post is forwarded only after that preflight ran and matched — see
 * {@link makerConfirmedBeforePost}.
 */
export function orderPartiesError(
  kind: IntentKind,
  order: { maker: string; receiver: string },
  expectedDiamond: string,
): 'maker-receiver-not-diamond' | null {
  const diamond = expectedDiamond.toLowerCase();
  if (order.receiver.toLowerCase() !== diamond) return 'maker-receiver-not-diamond';
  if (kind === 'buyback' && order.maker.toLowerCase() !== diamond) {
    return 'maker-receiver-not-diamond';
  }
  return null;
}

/**
 * #1566 S3e — whether the order's maker is confirmed before this Worker
 * spends its 1inch key on the order: always for a buyback (the offline
 * party check bound it to the diamond), and for a swap-to-repay order only
 * when the on-chain preflight ran and matched every field, the maker
 * included. A degraded or skipped preflight therefore fails a swap post
 * closed — otherwise the body could name any ERC-1271 contract as the maker
 * and spend the key, which is what the party check exists to stop.
 */
export function makerConfirmedBeforePost(
  kind: IntentKind,
  preflight: 'ok' | 'degraded' | 'skipped',
): boolean {
  return kind === 'buyback' || preflight === 'ok';
}

export async function handleIntentFusionPost(
  req: Request,
  env: Env,
  /** CORS origin to echo on the response. Resolved by
   *  `resolveAllowedOrigin(req, env)` upstream — the request's own
   *  Origin iff in `FRONTEND_ORIGIN`, else the first allow-list
   *  entry for non-browser callers. Same pattern every dapp-facing
   *  endpoint on this Worker uses. */
  corsOrigin: string,
): Promise<Response> {
  // #2755 — the Origin gate and the caller budget
  // (`INTENT_FUSION_POST_RATELIMIT`) run at the router, ahead of every
  // key-spending route, and both fail closed (`rateLimit.ts`). They used to
  // be re-implemented here, with a limiter of their own that let a request
  // through when the binding was missing. The 1inch credential budget is
  // taken below, immediately before the one upstream call.

  const read = await readJsonBody(req, MAX_FUSION_POST_BODY_BYTES);
  if (!read.ok) return jsonErr(corsOrigin, read.status, read.error);
  const raw = read.value;
  const parsed = validateBody(raw);
  if (!parsed) return jsonErr(corsOrigin, 400, 'invalid-payload');

  // Sanity: the diamond's commit emitted this exact orderHash; the
  // ERC-1271 binding stored it on-chain. Forwarding a SHAPE-VALID
  // but UNREGISTERED orderHash to Fusion would just fail downstream
  // — the resolver-pickup endpoint's signature-verification
  // staticcalls our ERC-1271 and gets `0xffffffff` for unregistered
  // hashes. We don't pre-flight that here because the dapp already
  // ran the commit tx successfully to get the orderHash; an
  // attacker faking the request still hits the same on-chain
  // rejection.

  // Codex round-8 PR #430 P2 — bind the order's parties to the
  // Vaipakam diamond on the request's chainId. Without this gate,
  // a non-browser caller that spoofs an allowed Origin can
  // submit orders for an arbitrary ERC-1271 contract using our
  // Fusion API quota; Fusion would validate against that
  // attacker contract's `isValidSignature` rather than a
  // Vaipakam maker's. The receiver is always the diamond; since
  // #1566 S3e a swap-to-repay order's maker is the borrower's
  // vault, bound by the on-chain preflight below instead of here
  // (see `orderPartiesError` / `makerConfirmedBeforePost`).
  const kind: IntentKind = parsed.kind ?? 'swap_to_repay';
  const deployment = getDeployment(parsed.chainId);
  if (!deployment) {
    return jsonErr(corsOrigin, 400, 'no-deployment-for-chain');
  }
  const expectedDiamond = deployment.diamond.toLowerCase();
  const partiesError = orderPartiesError(kind, parsed.order, expectedDiamond);
  if (partiesError) {
    return jsonErr(corsOrigin, 400, partiesError);
  }

  // Codex round-1 PR #430 P2 — gate to chains 1inch Fusion
  // supports. A Base Sepolia commit (chainId 84532) would
  // otherwise spend an API call on a path that doesn't exist; the
  // upstream returns 404 and the dapp surfaces a misleading
  // "Fusion upstream failed" error. Cleaner to short-circuit to
  // the queued-ack with an unsupported-chain note so the user
  // knows the on-chain commit is the source of truth + that
  // resolver discovery isn't expected on this chain.
  if (!FUSION_SUPPORTED_CHAIN_IDS.has(parsed.chainId)) {
    console.log('[intent/fusion/post] queued (chain unsupported by Fusion)', {
      chainId: parsed.chainId,
      orderHash: parsed.orderHash,
    });
    return jsonOk(corsOrigin, {
      ok: true,
      status: 'queued',
      orderHash: parsed.orderHash,
      note: `Chain ${parsed.chainId} is not supported by 1inch Fusion. Your collateral, the auction lot included, stays pledged in your vault; cancel after the auction deadline to withdraw the order — do not wait for a fill that will not arrive.`,
    });
  }

  // T-090 v1.1 GA (#426) — post to 1inch Fusion's resolver-pickup
  // endpoint with the operator-held API key. The dapp gets back
  // whatever Fusion replied (success → resolvers see the order;
  // 4xx/5xx → dapp surfaces the upstream error so the borrower
  // knows to cancel after deadline). If the secret is unset
  // (e.g. an alpha-era staging environment that never rotated
  // it in), fall back to the queued-ack behaviour so the dapp's
  // forward-compatible response shape still resolves cleanly.
  if (!env.ONEINCH_API_KEY) {
    console.log('[intent/fusion/post] queued (no API key configured)', {
      chainId: parsed.chainId,
      orderHash: parsed.orderHash,
      commitTxHash: parsed.commitTxHash,
    });
    return jsonOk(corsOrigin, {
      ok: true,
      status: 'queued',
      orderHash: parsed.orderHash,
      note:
        'ONEINCH_API_KEY is not configured on this Worker (operator-pre-activation state). No Fusion solver discovery happens until the secret is bound + the worker redeploys. Your collateral, the auction lot included, stays pledged in your vault; cancel after the auction deadline to withdraw the order — do not wait for a fill that will not arrive.',
    });
  }

  // T-090 v1.2 #428 — on-chain commit preflight. The Origin gate
  // above stops the browser-misconfigured noise; the rate limit
  // bounds spend; the party check above binds the receiver (and a
  // buyback's maker) to the diamond. A swap order's maker is the
  // borrower's vault (#1566 S3e), which only this preflight can
  // confirm — so for a swap it is also what stops a foreign
  // ERC-1271 contract from spending our key, and a swap post
  // without an `ok` preflight is refused below. Beyond that, a
  // non-browser caller that spoofs Origin + binds the body to our
  // diamond could still spam shape-valid-but-fake commits + burn
  // the Fusion quota at the upstream rejection.
  //
  // Defense: fetch the `commitTxHash` receipt + verify it
  // contains a `SwapToRepayIntentCommitted` log whose indexed
  // orderHash (topic[2]) matches the body's `orderHash` AND was
  // emitted by the Vaipakam diamond on this chain. Then read
  // `getIntentCommit(loanId)` to verify EVERY field of the
  // submitted `order` body matches the on-chain record — without
  // this second step the caller could replay a public commit tx
  // hash + mutate the order fields (Codex round-1 P2 fix).
  //
  // It runs only once the two answers that spend nothing (an unsupported
  // chain, an unset key) have been given above, so no caller can make
  // this Worker spend RPC on a post that would never reach Fusion
  // (#2756; it used to run first, although the chain check is the
  // cheaper one).
  //
  // Cost: two RPC calls per request (one `eth_getTransactionReceipt` +
  // one `eth_call` against the diamond), bounded by the caller budget.
  let preflightOutcome: 'ok' | 'degraded' | 'skipped' = 'skipped';
  const rpcUrl = rpcForChain(env, parsed.chainId);
  if (rpcUrl) {
    const preflight = await preflightCommitOnChain(
      rpcUrl,
      parsed,
      expectedDiamond,
    );
    if (preflight.kind === 'reject') {
      return jsonErr(corsOrigin, 400, preflight.reason);
    }
    // 'degraded' falls through for a buyback (its maker is
    // bound offline above); the log line lets ops see when the
    // preflight RPC degraded. A swap post stops short of Fusion
    // instead (#1566 S3e — see `makerConfirmedBeforePost`).
    preflightOutcome = preflight.kind;
  }

  // #1566 S3e — the key is spent only on an order whose maker is
  // confirmed (see `makerConfirmedBeforePost`); the queued-ack
  // paths above spend none, so they stay open.
  if (!makerConfirmedBeforePost(kind, preflightOutcome)) {
    console.warn('[intent/fusion/post] swap maker unconfirmed (preflight ' + preflightOutcome + ')', {
      chainId: parsed.chainId,
      orderHash: parsed.orderHash,
    });
    return jsonErr(corsOrigin, 503, 'preflight-unavailable');
  }

  // T-090 v1.2 #431 — LOP orderbook submit body. The orderHash +
  // signature are top-level; the order fields nest under `data`.
  //
  // ERC-1271 binding: a swap-to-repay order's maker is the
  // borrower's vault (#1566 S3e), a buyback order's the diamond.
  // 1inch's orderbook relayer staticcalls
  // `isValidSignature(orderHash, '')` against the maker at fill
  // time; the vault asks the diamond's `isOrderValid`, the
  // diamond answers a buyback itself, and either way the magic
  // value comes back only for a live registered commit. The dapp
  // doesn't produce an EIP-712 signature for these orders —
  // `signature: '0x'`.
  const signedOrderInput = {
    orderHash: parsed.orderHash,
    signature: '0x',
    data: {
      maker: parsed.order.maker,
      receiver: parsed.order.receiver,
      makerAsset: parsed.order.makerAsset,
      takerAsset: parsed.order.takerAsset,
      makingAmount: parsed.order.makerAmount,
      takingAmount: parsed.order.takerAmount,
      salt: parsed.order.salt,
      makerTraits: parsed.order.makerTraits,
      extension: parsed.order.extension,
    },
  };

  const upstreamUrl = `${LOP_ORDERBOOK_BASE_URL}/${parsed.chainId}`;
  // Charged as spent: one slot of the 1inch budget, shared with
  // `/quote/1inch`, for this one call (#2755).
  const refused = slotRefusal(await takeCredentialSlot(env, 'oneinch'), corsOrigin, 'upstream-quota');
  if (refused) return refused;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ONEINCH_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(signedOrderInput),
    });
    return passthrough(upstream, corsOrigin);
  } catch (err) {
    console.error('[intent/fusion/post] upstream fetch failed', redactedError(err));
    return jsonErr(corsOrigin, 502, 'fusion-upstream-failed');
  }
}

// T-090 v1.2 #428 + Codex round-1 — full on-chain preflight.
// Returns:
//   'ok'       → preflight verified; proceed to Fusion fetch.
//   'reject'   → preflight proved the commit is fake / mismatched;
//                surface the discriminated 400 to the caller.
//   'degraded' → genuine RPC connectivity error (NOT tx-not-found);
//                fall through to Fusion's server-side validation
//                so the user-facing path isn't blocked on the
//                operator's RPC health.
async function preflightCommitOnChain(
  rpcUrl: string,
  parsed: IntentFusionPostRequest,
  expectedDiamond: string,
): Promise<
  | { kind: 'ok' }
  | { kind: 'reject'; reason: string }
  | { kind: 'degraded' }
> {
  const client = createPublicClient({ transport: http(rpcUrl) });

  // 1. Fetch the receipt. viem throws (`TransactionReceiptNotFoundError`)
  //    when the hash isn't found — that's the abuse case this
  //    preflight exists to stop, NOT an RPC degradation
  //    (Codex round-1 P1). Distinguish by the error name.
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: parsed.commitTxHash });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (
      name === 'TransactionReceiptNotFoundError' ||
      /not found/i.test(String((err as Error)?.message ?? ''))
    ) {
      return { kind: 'reject', reason: 'commit-tx-not-found' };
    }
    console.warn(
      '[intent/fusion/post] receipt RPC degraded; proceeding',
      redactedError(err),
    );
    return { kind: 'degraded' };
  }
  if (!receipt || receipt.status !== 'success') {
    return { kind: 'reject', reason: 'commit-tx-not-successful' };
  }

  // 2. Find the expected event topic for the commit's kind.
  //    T-087 Sub 3.C — `'buyback'` matches `BuybackIntentValidated(bytes32)`
  //    emitted by `commitBuybackIntentValidated` after the on-chain
  //    Fusion-order-template validation passes; the default
  //    `'swap_to_repay'` matches the existing T-090 event.
  const expectedOrderHashTopic = parsed.orderHash.toLowerCase();
  const kind = parsed.kind ?? 'swap_to_repay';
  if (kind === 'buyback') {
    // For buyback, the event is single-topic (topic[1] = orderHash).
    // Just verify it landed under our diamond + the orderHash matches.
    let foundBuyback = false;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== expectedDiamond ||
        log.topics[0]?.toLowerCase() !==
          BUYBACK_INTENT_VALIDATED_TOPIC0.toLowerCase()
      ) {
        continue;
      }
      if (log.topics[1]?.toLowerCase() === expectedOrderHashTopic) {
        foundBuyback = true;
        break;
      }
    }
    if (!foundBuyback) {
      return { kind: 'reject', reason: 'orderhash-not-validated-on-chain' };
    }
    // T-087 Sub 3.C round-2 P2 #1 + round-3 P2 #1/#2 — even though
    // `commitBuybackIntentValidated` recomputed the orderHash from
    // the template at commit-time, the agent's caller might:
    //   (a) submit a mutated `order` body alongside a valid
    //       orderHash (round-2 P2 #1, round-3 P2 #2 — partial check
    //       on asset+amounts wasn't enough; takerAsset / salt /
    //       makerTraits / extension could still differ from the
    //       validated template);
    //   (b) replay a tx hash AFTER the order has Filled or Expired,
    //       since `getBuybackOrder` retains the historical fields
    //       (round-3 P2 #1).
    //
    // Defence: read the on-chain ledger entry, verify status ==
    // Pending + expiresAt > now, AND verify the diamond's
    // `isBuybackValidated(orderHash)` still returns true (the flag
    // clears on terminal). Then bind asset+amount fields. Field-
    // level mutation on takerAsset / salt / makerTraits / extension
    // would alter the orderHash recomputation; isValidSignature
    // would already block such a mutated body at fill time, but
    // dropping it here saves our 1inch quota from being burned on
    // an unfillable order.
    try {
      const orderHashCheck = parsed.orderHash;
      const orderField = await client.readContract({
        address: expectedDiamond as `0x${string}`,
        abi: [
          {
            type: 'function',
            name: 'getBuybackOrder',
            stateMutability: 'view',
            inputs: [{ name: 'orderHash', type: 'bytes32' }],
            outputs: [
              {
                type: 'tuple',
                components: [
                  { name: 'token', type: 'address' },
                  { name: 'amountIn', type: 'uint96' },
                  { name: 'minVpfiOut', type: 'uint128' },
                  { name: 'expiresAt', type: 'uint64' },
                  { name: 'status', type: 'uint8' },
                ],
              },
            ],
          },
        ] as const,
        functionName: 'getBuybackOrder',
        args: [orderHashCheck],
      });
      const fields = orderField as {
        token: `0x${string}`;
        amountIn: bigint;
        minVpfiOut: bigint;
        expiresAt: bigint;
        status: number;
      };
      // status 1 = PENDING.
      if (fields.status !== 1) {
        return { kind: 'reject', reason: 'buyback-not-pending' };
      }
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (fields.expiresAt <= nowSec) {
        return { kind: 'reject', reason: 'buyback-expired' };
      }
      if (fields.token.toLowerCase() !== parsed.order.makerAsset.toLowerCase()) {
        return { kind: 'reject', reason: 'buyback-makerAsset-mismatch' };
      }
      if (BigInt(parsed.order.makerAmount) !== fields.amountIn) {
        return { kind: 'reject', reason: 'buyback-makerAmount-mismatch' };
      }
      if (BigInt(parsed.order.takerAmount) !== fields.minVpfiOut) {
        return { kind: 'reject', reason: 'buyback-takerAmount-mismatch' };
      }
      // Also assert isBuybackValidated still true (the diamond
      // clears it at terminal; covers Filled/Expired states the
      // status check above already catches but defence-in-depth).
      const validated = (await client.readContract({
        address: expectedDiamond as `0x${string}`,
        abi: [
          {
            type: 'function',
            name: 'isBuybackValidated',
            stateMutability: 'view',
            inputs: [{ name: 'orderHash', type: 'bytes32' }],
            outputs: [{ type: 'bool' }],
          },
        ] as const,
        functionName: 'isBuybackValidated',
        args: [orderHashCheck],
      })) as boolean;
      if (!validated) {
        return { kind: 'reject', reason: 'buyback-not-validated' };
      }
    } catch (err) {
      console.warn(
        '[intent/fusion/post] buyback ledger read RPC degraded; proceeding',
        redactedError(err),
      );
      // RPC degradation: fall through. The on-chain commit is still
      // the source of truth; a mutated body sent to Fusion would
      // just fail the ERC-1271 binding at fill time and waste
      // resolver gas instead of ours.
    }
    return { kind: 'ok' };
  }
  // ─── swap-to-repay path (default / legacy) ────────────────────
  let loanIdTopic: string | undefined;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== expectedDiamond ||
      log.topics[0]?.toLowerCase() !==
        SWAP_TO_REPAY_INTENT_COMMITTED_TOPIC0.toLowerCase()
    ) {
      continue;
    }
    if (log.topics[2]?.toLowerCase() === expectedOrderHashTopic) {
      // topic[1] is the indexed loanId.
      loanIdTopic = log.topics[1];
      break;
    }
  }
  if (!loanIdTopic) {
    return { kind: 'reject', reason: 'orderhash-not-in-commit-tx' };
  }
  const loanId = BigInt(loanIdTopic);

  // 3. Read `getIntentCommit(loanId)` from the diamond and verify
  //    every field of the submitted `order` body matches the
  //    on-chain record (Codex round-1 P2). Without this step the
  //    caller could replay a public commit tx hash + mutate the
  //    order fields before forwarding to Fusion.
  let onChain: {
    maker: `0x${string}`;
    receiver: `0x${string}`;
    makerAsset: `0x${string}`;
    takerAsset: `0x${string}`;
    makerAmount: bigint;
    takerAmount: bigint;
    deadline: bigint;
    salt: bigint;
    makerTraits: bigint;
    extension: `0x${string}`;
  };
  try {
    onChain = (await client.readContract({
      address: expectedDiamond as `0x${string}`,
      abi: [
        {
          name: 'getIntentCommit',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'loanId', type: 'uint256' }],
          outputs: [
            {
              components: [
                { name: 'maker', type: 'address' },
                { name: 'receiver', type: 'address' },
                { name: 'makerAsset', type: 'address' },
                { name: 'takerAsset', type: 'address' },
                { name: 'makerAmount', type: 'uint256' },
                { name: 'takerAmount', type: 'uint256' },
                { name: 'deadline', type: 'uint64' },
                { name: 'salt', type: 'uint256' },
                { name: 'makerTraits', type: 'uint256' },
                { name: 'extension', type: 'bytes' },
              ],
              name: 'order',
              type: 'tuple',
            },
          ],
        },
      ] as const,
      functionName: 'getIntentCommit',
      args: [loanId],
    })) as typeof onChain;
  } catch (err) {
    // Codex round-2 PR #433 P2 — distinguish contract revert
    // (the commit was torn down on-chain — fill / cancel /
    // force-cancel in between the commit-tx mining and this
    // request; legit reject) from genuine RPC degradation
    // (rate-limit / timeout / provider issue; degrade so an
    // otherwise valid live commit isn't blocked on transient
    // RPC noise).
    //
    // viem throws `ContractFunctionRevertedError` on revert.
    // For belt-and-braces we also detect the error message
    // pattern in case the error class isn't surfaced verbatim
    // (some custom transports wrap the original).
    const name = (err as { name?: string })?.name ?? '';
    const isRevert =
      name === 'ContractFunctionRevertedError' ||
      /revert|execution reverted/i.test(String((err as Error)?.message ?? ''));
    if (isRevert) {
      return { kind: 'reject', reason: 'commit-no-longer-live' };
    }
    console.warn(
      '[intent/fusion/post] getIntentCommit RPC degraded; proceeding',
      redactedError(err),
    );
    return { kind: 'degraded' };
  }

  if (
    onChain.maker.toLowerCase() !== parsed.order.maker.toLowerCase() ||
    onChain.receiver.toLowerCase() !== parsed.order.receiver.toLowerCase() ||
    onChain.makerAsset.toLowerCase() !== parsed.order.makerAsset.toLowerCase() ||
    onChain.takerAsset.toLowerCase() !== parsed.order.takerAsset.toLowerCase() ||
    onChain.makerAmount.toString() !== parsed.order.makerAmount ||
    onChain.takerAmount.toString() !== parsed.order.takerAmount ||
    onChain.deadline.toString() !== String(parsed.order.deadline) ||
    onChain.salt.toString() !== parsed.order.salt ||
    onChain.makerTraits.toString() !== parsed.order.makerTraits ||
    onChain.extension.toLowerCase() !== parsed.order.extension.toLowerCase()
  ) {
    return { kind: 'reject', reason: 'order-fields-mismatch' };
  }

  return { kind: 'ok' };
}

async function passthrough(
  upstream: Response,
  corsOrigin: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    body = { error: 'upstream-non-json', status: upstream.status };
  }
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

// ─── Helpers (kept local; mirrors the existing per-handler style
//     across this Worker — `openseaProxy.ts` / `quoteProxy.ts` both
//     define their own helpers rather than reaching for a shared
//     util module) ─────────────────────────────────────────────

function jsonErr(corsOrigin: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function jsonOk(corsOrigin: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function validateBody(raw: unknown): IntentFusionPostRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0)
    return null;
  // Codex round-3 PR #430 P2 — tighten payload validation so a
  // non-browser caller that spoofs an allowed Origin can't push
  // through arbitrary strings that 1inch will spend our shared
  // API quota rejecting. Hex addresses are 0x + 40 hex chars,
  // hashes / bytes32 are 0x + 64 hex chars, uint256 string
  // decimals are bounded, and the extension is a known canonical
  // length the diamond's `canonicalExtension` view returns.
  if (!isBytes32Hex(o.orderHash) || !isBytes32Hex(o.commitTxHash)) return null;

  const order = o.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== 'object') return null;
  const addrs = ['maker', 'receiver', 'makerAsset', 'takerAsset'] as const;
  for (const f of addrs) {
    if (!isAddressHex(order[f])) return null;
  }
  if (!isExtensionHex(order.extension)) return null;
  const uints = ['makerAmount', 'takerAmount', 'salt', 'makerTraits'] as const;
  for (const f of uints) {
    if (!isUint256DecString(order[f])) return null;
  }
  if (typeof order.deadline !== 'number' || !Number.isInteger(order.deadline) ||
      order.deadline <= 0)
    return null;

  // T-087 Sub 3.C round-1 P1 — preserve the kind discriminator
  // (defaults to 'swap_to_repay' for backwards compat). Without
  // this the preflight always falls into the swap-to-repay branch
  // and buyback commits get rejected with
  // `orderhash-not-in-commit-tx` even though they validated on
  // chain.
  let kind: 'swap_to_repay' | 'buyback' | undefined;
  if (o.kind === 'swap_to_repay' || o.kind === 'buyback') {
    kind = o.kind;
  } else if (o.kind !== undefined) {
    // Unknown kind string — reject the request rather than silently
    // routing it to the default branch.
    return null;
  }

  return {
    chainId: o.chainId,
    kind,
    orderHash: o.orderHash as `0x${string}`,
    commitTxHash: o.commitTxHash as `0x${string}`,
    order: order as IntentFusionPostRequest['order'],
  };
}

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
// Canonical extension: 32-byte offsets header + 40 bytes content
// (two 20-byte addresses per the v1.1 contract's
// `canonicalExtension`); total 0x + 144 hex chars.
const HEX_EXTENSION_RE = /^0x[0-9a-fA-F]{144}$/;
const UINT256_DEC_RE = /^[0-9]{1,78}$/;

function isAddressHex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_ADDR_RE.test(v);
}
function isBytes32Hex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_BYTES32_RE.test(v);
}
function isExtensionHex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_EXTENSION_RE.test(v);
}
function isUint256DecString(v: unknown): v is string {
  if (typeof v !== 'string' || !UINT256_DEC_RE.test(v)) return false;
  try {
    return BigInt(v) < BigInt(2) ** BigInt(256);
  } catch {
    return false;
  }
}
