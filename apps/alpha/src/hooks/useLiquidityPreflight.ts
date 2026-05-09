import { useEffect, useState } from "react";
import type { Address } from "viem";

/**
 * Phase 7b.1 frontend — UX-layer liquidity preflight.
 *
 * Sits in front of `acceptOffer` / `createOffer` for ERC-20 collateral
 * pairs. Asks 0x (via the existing `/quote/0x` Cloudflare Worker
 * route) whether it can route the offer's actual `collateralAmount`
 * from collateral → principal at acceptable slippage. The on-chain
 * `OracleFacet.checkLiquidity` gate is unchanged — this is a UX
 * guard only, blocking a user from initiating an offer that would
 * subsequently be hard / impossible to liquidate.
 *
 * Anyone calling the diamond directly via Etherscan bypasses this
 * preflight and falls back on the contract-layer V3-clone OR-logic,
 * which is the actual security boundary.
 *
 * The hook is no-op (idle) when:
 *   - either asset is null / address(0)
 *   - the collateral leg is non-ERC20 (NFT loans don't route through
 *     a DEX; they take the full-collateral-transfer fallback at
 *     default time)
 *   - `collateralAmount === 0n`
 *   - `workerOrigin` is null (env not configured for this build)
 *
 * Skipped state shows nothing in the UI; callers should let the
 * submit button stay enabled. Only `no-route` and `thin` should
 * surface a banner.
 */

export type PreflightStatus =
  | "idle"
  | "loading"
  | "liquid"
  | "thin"
  | "no-route"
  | "unavailable"
  | "error";

export interface UseLiquidityPreflightInput {
  collateralAsset: Address | null;
  principalAsset: Address | null;
  collateralAmount: bigint;
  /** "erc20" enables the check; anything else (or undefined) = skip. */
  collateralAssetType?: "erc20" | "erc721" | "erc1155";
  chainId: number | undefined | null;
  /** Diamond address — used as the `taker` for the 0x quote so the
   *  returned route is realistic for the eventual on-chain executor. */
  diamond: Address | null;
  workerOrigin: string | null;
  /** Slippage cap to compare the 0x price-impact against. Defaults
   *  to 6% to match the on-chain `MAX_SLIPPAGE_BPS` ceiling. */
  slippageCapBps?: number;
}

export interface UseLiquidityPreflightResult {
  status: PreflightStatus;
  expectedBuyAmount: bigint | null;
  /** Implied slippage percent ("100" * (1 - actual/spot)) when both
   *  buyAmount and a spot reference are available. Null when not
   *  determinable. */
  priceImpactPct: number | null;
  errorMessage: string | null;
  refresh: () => void;
}

interface ZeroExResponse {
  transaction?: { to?: string; data?: string };
  buyAmount?: string;
  // 0x v2 surfaces a per-liquidity-source breakdown but we only
  // care about the aggregate. Fields below are best-effort —
  // missing fields just leave priceImpactPct null.
  expectedSlippage?: string;
  // 0x v2 returns price impact under various keys depending on the
  // response variant; we probe both.
  priceImpact?: string;
  totalNetworkFee?: string;
}

/**
 * Internal helper — POST to the worker, parse, classify into a
 * PreflightStatus. Returns null on a hard failure (network, JSON
 * parse, missing data) so the caller can downgrade to "error".
 */
async function fetchPreflight(
  workerOrigin: string,
  chainId: number,
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
  taker: Address,
  slippageCapBps: number,
): Promise<{
  buyAmount: bigint;
  priceImpactPct: number | null;
  status: "liquid" | "thin";
} | "no-route" | "unavailable" | null> {
  let res: Response;
  try {
    res = await fetch(`${workerOrigin}/quote/0x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId,
        sellToken,
        buyToken,
        sellAmount: sellAmount.toString(),
        taker,
        slippageBps: slippageCapBps,
      }),
    });
  } catch {
    return null;
  }
  // 503 from worker means the operator hasn't configured the API key
  // — distinct from a network / parse failure.
  if (res.status === 503) return "unavailable";
  if (!res.ok) {
    // 4xx from 0x typically means "no route exists for this pair" —
    // treat as no-route rather than error so the UI shows a useful
    // banner instead of a bug-looking "Preview error" state.
    if (res.status >= 400 && res.status < 500) return "no-route";
    return null;
  }
  let body: ZeroExResponse;
  try {
    body = (await res.json()) as ZeroExResponse;
  } catch {
    return null;
  }
  if (!body.buyAmount || !body.transaction?.data) {
    // 0x can return 200 with empty transaction when no path exists.
    return "no-route";
  }
  const buyAmount = BigInt(body.buyAmount);
  const priceImpactPct = body.priceImpact
    ? parseFloat(body.priceImpact)
    : body.expectedSlippage
      ? parseFloat(body.expectedSlippage) * 100
      : null;
  // Classification: the on-chain ceiling is `slippageCapBps / 100`
  // percent. Anything below that = liquid; above = thin (still
  // routable but the UX should warn).
  const capPct = slippageCapBps / 100;
  const status =
    priceImpactPct !== null && priceImpactPct > capPct ? "thin" : "liquid";
  return { buyAmount, priceImpactPct, status };
}

export function useLiquidityPreflight(
  input: UseLiquidityPreflightInput,
): UseLiquidityPreflightResult {
  const [status, setStatus] = useState<PreflightStatus>("idle");
  const [buyAmount, setBuyAmount] = useState<bigint | null>(null);
  const [priceImpactPct, setPriceImpactPct] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const slippageCapBps = input.slippageCapBps ?? 600;
  const enabled =
    !!input.collateralAsset &&
    !!input.principalAsset &&
    !!input.diamond &&
    !!input.workerOrigin &&
    !!input.chainId &&
    input.collateralAssetType === "erc20" &&
    input.collateralAmount > 0n;

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      setBuyAmount(null);
      setPriceImpactPct(null);
      setErrorMessage(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);
    fetchPreflight(
      input.workerOrigin as string,
      input.chainId as number,
      input.collateralAsset as Address,
      input.principalAsset as Address,
      input.collateralAmount,
      input.diamond as Address,
      slippageCapBps,
    )
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setStatus("error");
          setErrorMessage("Preflight check failed (network / parse).");
          return;
        }
        if (result === "no-route") {
          setStatus("no-route");
          setBuyAmount(null);
          setPriceImpactPct(null);
          return;
        }
        if (result === "unavailable") {
          setStatus("unavailable");
          setBuyAmount(null);
          setPriceImpactPct(null);
          return;
        }
        setStatus(result.status);
        setBuyAmount(result.buyAmount);
        setPriceImpactPct(result.priceImpactPct);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // Re-run on input change OR explicit refresh tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    input.collateralAsset,
    input.principalAsset,
    input.collateralAmount.toString(),
    input.diamond,
    input.chainId,
    input.workerOrigin,
    slippageCapBps,
    tick,
  ]);

  return {
    status,
    expectedBuyAmount: buyAmount,
    priceImpactPct,
    errorMessage,
    refresh: () => setTick((t) => t + 1),
  };
}
