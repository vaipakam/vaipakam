/**
 * DEX-direct quote service for the flash-loan / discount-path branch.
 *
 * Phase 3 of `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
 *
 * Why this is separate from `serverQuotes.ts`:
 *   `serverQuotes.ts` returns quotes packed as **diamond-LibSwap-
 *   adapter calldata** — the `adapterData` blob is
 *   `abi.encode(swapTarget, swapCalldata)`, and the diamond's
 *   on-chain `AggregatorAdapterBase` re-decodes it after using the
 *   adapter's registered allowance target. That works perfectly for
 *   the existing `triggerLiquidation` / `triggerLiquidationSplit` /
 *   `triggerPartialLiquidation` paths which all route through
 *   `LibSwap` inside the diamond.
 *
 *   The flash-loan branch's `FlashLoanLiquidator` lives OUTSIDE the
 *   diamond, so it has no access to the diamond's adapter registry —
 *   it needs the **DEX-direct shape**:
 *
 *     (swapTarget, swapAllowanceTarget, swapCalldata)
 *
 *   ...where `swapAllowanceTarget` is the ERC-20 allowance recipient
 *   (sometimes different from `swapTarget` per 0x v2 Permit2 pattern)
 *   and `swapCalldata` is the raw bytes payload the receiver
 *   `.call()`s.
 *
 *   Keeping this service separate avoids contorting `serverQuotes.ts`
 *   into doing two jobs and keeps the on-chain wire formats from
 *   leaking into each other.
 *
 * V1 venue coverage: 0x v2 + 1inch v6.
 *   - Both return per-quote `(swapTarget, swapCalldata)` natively;
 *     0x v2 also returns a separate `allowanceTarget` (Permit2);
 *     1inch v6 uses the same address for both.
 *   - Balancer V2 SOR direct-quote requires the Balancer SDK or a
 *     custom solver against the Vault's `batchSwap` interface — a
 *     bigger lift, deferred to a follow-up. Most flash-loan-funded
 *     trades route fine via 0x/1inch alone.
 */

import type { Address, Hex, PublicClient } from 'viem';

import type { Env } from './env';

/** A single DEX-direct quote — exactly the shape
 *  `FlashLoanLiquidator.liquidateViaAaveV3` /
 *  `liquidateViaBalancerV2` wants for their swap-target +
 *  allowance + calldata arguments.
 */
export interface DexDirectQuote {
  /** Which aggregator returned this quote. */
  kind: 'zeroex' | 'oneinch';
  /** Expected output amount (in buy-token base units) at the
   *  quoted slippage tolerance. The keeper's profitability
   *  simulation uses this as the lower-bound proceeds estimate. */
  expectedOutput: bigint;
  /** Address the `FlashLoanLiquidator` should `.call()` with
   *  `swapCalldata` to execute the swap. Per the aggregator's
   *  `transaction.to` field. */
  swapTarget: Address;
  /** ERC-20 allowance recipient for the sell token. For 0x v2 this
   *  is the AllowanceHolder/Permit2 contract; for 1inch v6 this is
   *  the same as `swapTarget`. */
  swapAllowanceTarget: Address;
  /** Raw calldata bytes the swap-target consumes. */
  swapCalldata: Hex;
}

export interface DexDirectQuoteRequest {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  /** The address that will execute the swap on-chain — for the
   *  flash-loan branch this is the `FlashLoanLiquidator`
   *  receiver, NOT the keeper EOA. The aggregator builds calldata
   *  tailored to this taker. */
  taker: Address;
  /** Slippage tolerance in BPS. Defaults to 600 (6%) — matches
   *  the diamond's max liquidation slippage so the FlashLoanLiquidator's
   *  post-swap balance check has the same headroom as the
   *  atomic-path's adapter-level check. */
  slippageBps?: number;
}

export interface DexDirectQuoteResult {
  /** All quotes that succeeded, ranked best-first by
   *  `expectedOutput`. */
  ranked: DexDirectQuote[];
  /** Quote sources that failed (HTTP error, malformed response,
   *  no API key). Surfaced for diagnostic logging. */
  failed: ('zeroex' | 'oneinch')[];
}

// ─── 0x v2 — `transaction.to` + Permit2 allowance target ─────────────

interface ZeroExV2Resp {
  transaction?: {
    to?: string;
    data?: string;
    /** Permit2 allowance recipient. Distinct from `transaction.to`
     *  in the AllowanceHolder/Settler pattern — the EOA approves
     *  Permit2 once globally, and Settler pulls funds via Permit2
     *  on each swap. For our receiver contract that doesn't hold
     *  Permit2 approval, we approve `transaction.to` directly OR
     *  the `allowanceTarget` field — the safer single-call shape
     *  the 0x docs recommend is approve `allowanceTarget`. */
    allowanceTarget?: string;
  };
  buyAmount?: string;
}

async function fetchZeroExDirect(
  env: Env,
  req: DexDirectQuoteRequest,
): Promise<DexDirectQuote | null> {
  if (!env.ZEROEX_API_KEY) return null;
  const url = new URL('https://api.0x.org/swap/allowance-holder/quote');
  url.searchParams.set('chainId', String(req.chainId));
  url.searchParams.set('sellToken', req.sellToken);
  url.searchParams.set('buyToken', req.buyToken);
  url.searchParams.set('sellAmount', req.sellAmount.toString());
  url.searchParams.set('taker', req.taker);
  url.searchParams.set('slippageBps', String(req.slippageBps ?? 600));
  try {
    const res = await fetch(url.toString(), {
      headers: {
        '0x-api-key': env.ZEROEX_API_KEY,
        '0x-version': 'v2',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ZeroExV2Resp;
    const swapTo = body.transaction?.to;
    const data = body.transaction?.data;
    const allowance = body.transaction?.allowanceTarget ?? swapTo;
    const out = body.buyAmount;
    if (!isAddressLike(swapTo)) return null;
    if (!isAddressLike(allowance)) return null;
    if (!data || !data.startsWith('0x')) return null;
    if (!out) return null;
    return {
      kind: 'zeroex',
      expectedOutput: BigInt(out),
      swapTarget: swapTo as Address,
      swapAllowanceTarget: allowance as Address,
      swapCalldata: data as Hex,
    };
  } catch {
    return null;
  }
}

// ─── 1inch v6 — `tx.to` is both swap target and allowance target ─────

interface OneInchV6Resp {
  tx?: { to?: string; data?: string };
  /** Current 1inch v6 response shape uses `dstAmount`; older
   *  versions used `toAmount` — keep both for fallback. */
  dstAmount?: string;
  toAmount?: string;
}

async function fetchOneInchDirect(
  env: Env,
  req: DexDirectQuoteRequest,
): Promise<DexDirectQuote | null> {
  if (!env.ONEINCH_API_KEY) return null;
  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${req.chainId}/swap`,
  );
  url.searchParams.set('src', req.sellToken);
  url.searchParams.set('dst', req.buyToken);
  url.searchParams.set('amount', req.sellAmount.toString());
  url.searchParams.set('from', req.taker);
  // 1inch slippage param is in percent (1.0 = 1%), so divide BPS
  // by 100 to convert.
  url.searchParams.set('slippage', String((req.slippageBps ?? 600) / 100));
  url.searchParams.set('disableEstimate', 'true');
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.ONEINCH_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OneInchV6Resp;
    const swapTo = body.tx?.to;
    const data = body.tx?.data;
    const out = body.dstAmount ?? body.toAmount;
    if (!isAddressLike(swapTo)) return null;
    if (!data || !data.startsWith('0x')) return null;
    if (!out) return null;
    return {
      kind: 'oneinch',
      expectedOutput: BigInt(out),
      swapTarget: swapTo as Address,
      // 1inch v6 AggregationRouter is both `to` and the allowance
      // recipient (no Permit2 split).
      swapAllowanceTarget: swapTo as Address,
      swapCalldata: data as Hex,
    };
  } catch {
    return null;
  }
}

const ADDRESS_HEX_LEN = 42; // 0x + 40 hex chars

function isAddressLike(s: string | undefined): s is Address {
  return (
    typeof s === 'string' &&
    s.startsWith('0x') &&
    s.length === ADDRESS_HEX_LEN
  );
}

/**
 * Fetch DEX-direct quotes from every available aggregator for a
 * single (sellToken, buyToken, sellAmount, taker) tuple. Returns a
 * ranked list of successes + a diagnostic list of failed venues.
 * Caller picks the best-ranked entry; if `ranked` is empty, the
 * flash-loan branch skips this loan.
 *
 * `publicClient` is reserved for a future Balancer V2 SOR
 * integration (the Balancer Vault interface is on-chain, not
 * REST). v1 doesn't use it; the param stays to keep the signature
 * stable.
 */
export async function orchestrateDexDirectQuotes(
  env: Env,
  _publicClient: PublicClient,
  req: DexDirectQuoteRequest,
): Promise<DexDirectQuoteResult> {
  const results = await Promise.all([
    fetchZeroExDirect(env, req),
    fetchOneInchDirect(env, req),
  ]);
  const ranked: DexDirectQuote[] = [];
  const failed: ('zeroex' | 'oneinch')[] = [];
  const labels: ('zeroex' | 'oneinch')[] = ['zeroex', 'oneinch'];
  for (let i = 0; i < results.length; ++i) {
    const r = results[i];
    if (r) ranked.push(r);
    else failed.push(labels[i]);
  }
  // Sort best-first by expectedOutput descending. Equal-output ties
  // resolve by API order (0x first, 1inch second) — deterministic
  // for tests.
  ranked.sort((a, b) => {
    if (a.expectedOutput > b.expectedOutput) return -1;
    if (a.expectedOutput < b.expectedOutput) return 1;
    return 0;
  });
  return { ranked, failed };
}
