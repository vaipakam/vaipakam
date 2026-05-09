import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { AssetType, LoanStatus, type LoanDetails } from '../types/loan';
import { fetchTokenMeta } from '../lib/tokenMeta';
import { beginStep } from '../lib/journeyLog';
import { useProtocolStats } from './useProtocolStats';
import {
  fetchActiveLoans,
  type IndexedLoan,
} from '../lib/indexerClient';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STALE_MS = 30_000;

export interface AssetTVL {
  asset: string;
  amount: bigint;
  decimals: number;
  symbol: string;
  usd: number;
  liquid: boolean;
}

export interface TVLSnapshot {
  totalUsd: number;
  erc20CollateralUsd: number;
  nftCollateralCount: number;
  principalUsd: number;
  byAsset: AssetTVL[];
  fetchedAt: number;
}

interface CacheEntry {
  data: TVLSnapshot;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(chainId: number, diamondAddress: string): string {
  return `${chainId}:${diamondAddress.toLowerCase()}`;
}

/**
 * Total Value Locked — USD-denominated aggregation over every active loan's
 * principal and ERC-20 collateral. NFT collateral is counted but contributes
 * $0 to the USD roll-up (no on-chain oracle). Prices come from Chainlink via
 * {@link OracleFacet.getAssetPrice}; any asset that reverts (no feed / stale)
 * is treated as $0 but still listed in the per-asset breakdown.
 */
export function useTVL() {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  // Indexer-failure tracker — flips to true the first time the
  // paginated `/loans/active` walk returns null (worker offline).
  // Drives the `useProtocolStats({ enabled })` gate below so the
  // chain-side fallback only fires when the indexer is confirmed-
  // unreachable. Sticky-true until the next `tvlWatermark` advance
  // resets it via the load callback's success path.
  const [indexerFailed, setIndexerFailed] = useState(false);
  const { stats, loading: statsLoading, error: statsError } = useProtocolStats({
    enabled: indexerFailed,
  });
  // Cool-tier auto-refresh — TVL is a slow-moving aggregate; 180 s
  // active probe with the standard idle/walk-away backoff matches
  // the rest of the Analytics surface.
  const { version: tvlWatermark } = useLiveWatermark(watermarkPolicy('cool'));
  const [snapshot, setSnapshot] = useState<TVLSnapshot | null>(
    () => cache.get(cacheKey(chainId, diamondAddress))?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(statsError ?? null);

  // Paginate `/loans/active` until the worker says "no more pages"
  // (`nextBefore === null`). Hard-capped at 25 pages × 200 rows =
  // 5000 active loans — plenty of headroom; if the protocol ever
  // genuinely exceeds that, lift the cap. Returns null on any
  // worker-side failure so the caller can fall through to the
  // legacy multicall path. Without pagination the TVL would
  // silently truncate to the worker's default page size of 50,
  // understating the real-world value locked.
  const fetchActiveLoansFromIndexer = useCallback(async (): Promise<
    IndexedLoan[] | null
  > => {
    const all: IndexedLoan[] = [];
    let before: number | undefined = undefined;
    for (let i = 0; i < 25; i++) {
      const page = await fetchActiveLoans(chainId, { limit: 200, before });
      if (!page) return null;
      all.push(...page.loans);
      if (page.nextBefore === null) return all;
      before = page.nextBefore;
    }
    return all;
  }, [chainId]);

  const load = useCallback(async () => {
    const key = cacheKey(chainId, diamondAddress);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setSnapshot(cached.data);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useTVL', step: 'price-active-loans' });
    try {
      // Indexer-first: pull the FULL active-loans set via paginated
      // `/loans/active`. Falls back to `useProtocolStats.loans`
      // (which derives from the chain-side `getLoanDetails` multi-
      // call) only when the worker is unreachable. Both paths feed
      // the same downstream pricing logic; the difference is
      // whether the loans-list discovery cost was indexer JSON or
      // chain RPCs.
      let activeLoans: Pick<
        LoanDetails,
        | 'principal'
        | 'principalAsset'
        | 'assetType'
        | 'collateralAmount'
        | 'collateralAsset'
        | 'collateralAssetType'
        | 'status'
      >[];
      const indexerActive = await fetchActiveLoansFromIndexer();
      if (indexerActive !== null) {
        // Worker is healthy — clear the fallback gate. If we'd
        // previously flipped to the chain-side path during an
        // outage, this returns us to the indexer-first happy path.
        setIndexerFailed(false);
        activeLoans = indexerActive.map((l) => ({
          principal: BigInt(l.principal),
          principalAsset: l.lendingAsset,
          assetType: BigInt(l.assetType),
          collateralAmount: BigInt(l.collateralAmount),
          collateralAsset: l.collateralAsset,
          collateralAssetType: BigInt(l.collateralAssetType),
          status: BigInt(LoanStatus.Active),
        }));
      } else {
        // Worker unreachable — engage the chain-side fallback by
        // flipping the gate flag. `useProtocolStats` will then
        // fire its multicall on the next render. The first render
        // after the flip will see `stats === null` and bail; the
        // re-fired effect after stats lands picks it up.
        setIndexerFailed(true);
        if (!stats) return;
        activeLoans = stats.loans.filter((l: LoanDetails) => {
          const s = Number(l.status);
          return s === LoanStatus.Active || s === LoanStatus.FallbackPending;
        });
      }

      interface LegKey { asset: string; amount: bigint; kind: 'principal' | 'collateral'; isNft: boolean; }
      // Some indexer rows surface malformed addresses like the
      // literal string `"0x"` (2 chars, no hex body) for legacy
      // testnet loans where a Transfer event was indexed before
      // the contract write that populated the lendingAsset /
      // collateralAsset slots. The pre-existing `!== ZERO_ADDRESS`
      // check (compares against the 42-char zero address) didn't
      // catch them, so they leaked through into `getAssetPrice`
      // encoding and threw `InvalidAddressError: Address "0x" is
      // invalid` (viem hard-validates 20-byte hex). Tighten to
      // also require the standard 42-char shape — anything that
      // isn't a real address gets dropped silently rather than
      // poisoning the multicall batch.
      const isValidAddr = (a: string): boolean =>
        typeof a === 'string' && a.length === 42 && a.startsWith('0x');
      const legs: LegKey[] = [];
      for (const loan of activeLoans) {
        if (
          loan.principal > 0n &&
          loan.principalAsset !== ZERO_ADDRESS &&
          isValidAddr(loan.principalAsset)
        ) {
          legs.push({
            asset: loan.principalAsset.toLowerCase(),
            amount: loan.principal,
            kind: 'principal',
            isNft: Number(loan.assetType) !== AssetType.ERC20,
          });
        }
        if (
          loan.collateralAmount > 0n &&
          loan.collateralAsset !== ZERO_ADDRESS &&
          isValidAddr(loan.collateralAsset)
        ) {
          legs.push({
            asset: loan.collateralAsset.toLowerCase(),
            amount: loan.collateralAmount,
            kind: 'collateral',
            isNft: Number(loan.collateralAssetType) !== AssetType.ERC20,
          });
        }
      }

      const uniqueAssets = Array.from(new Set(legs.map((l) => l.asset)));
      const priceCalls = encodeBatchCalls(
        diamondAddress,
        DIAMOND_ABI,
        'getAssetPrice',
        uniqueAssets.map((a) => [a as Address] as const),
      );
      const priceResults = await batchCalls<[bigint, number]>(
        publicClient,
        DIAMOND_ABI,
        'getAssetPrice',
        priceCalls,
      );
      const priceByAsset = new Map<string, { price: bigint; decimals: number } | null>();
      uniqueAssets.forEach((addr, i) => {
        const r = priceResults[i];
        if (!r) {
          priceByAsset.set(addr, null);
          return;
        }
        priceByAsset.set(addr, { price: r[0] as bigint, decimals: Number(r[1] ?? 8) });
      });

      const metaByAsset = new Map<string, { symbol: string; decimals: number }>();
      await Promise.all(
        uniqueAssets.map(async (addr) => {
          try {
            const m = await fetchTokenMeta(addr, publicClient);
            metaByAsset.set(addr, { symbol: m.symbol, decimals: m.decimals });
          } catch {
            metaByAsset.set(addr, { symbol: addr.slice(0, 6) + '…', decimals: 18 });
          }
        }),
      );

      const aggregated = new Map<string, { amount: bigint; usd: number; liquid: boolean; isNft: boolean }>();
      for (const leg of legs) {
        const price = priceByAsset.get(leg.asset);
        const meta = metaByAsset.get(leg.asset) ?? { symbol: leg.asset.slice(0, 6), decimals: 18 };
        let usd = 0;
        let liquid = false;
        if (price && !leg.isNft) {
          const priceScaled = Number(price.price) / 10 ** price.decimals;
          const tokenScaled = Number(leg.amount) / 10 ** meta.decimals;
          usd = priceScaled * tokenScaled;
          liquid = true;
        }
        const bucket = aggregated.get(leg.asset) ?? { amount: 0n, usd: 0, liquid: false, isNft: leg.isNft };
        bucket.amount += leg.amount;
        bucket.usd += usd;
        bucket.liquid = bucket.liquid || liquid;
        bucket.isNft = bucket.isNft || leg.isNft;
        aggregated.set(leg.asset, bucket);
      }

      const byAsset: AssetTVL[] = Array.from(aggregated.entries()).map(([asset, v]) => {
        const meta = metaByAsset.get(asset) ?? { symbol: asset.slice(0, 6), decimals: 18 };
        return {
          asset,
          amount: v.amount,
          decimals: meta.decimals,
          symbol: meta.symbol,
          usd: v.usd,
          liquid: v.liquid,
        };
      });

      let principalUsd = 0;
      let erc20CollateralUsd = 0;
      let nftCollateralCount = 0;
      for (const loan of activeLoans) {
        const pAsset = loan.principalAsset.toLowerCase();
        const pMeta = metaByAsset.get(pAsset);
        const pPrice = priceByAsset.get(pAsset);
        if (pMeta && pPrice && Number(loan.assetType) === AssetType.ERC20) {
          principalUsd +=
            (Number(pPrice.price) / 10 ** pPrice.decimals) *
            (Number(loan.principal) / 10 ** pMeta.decimals);
        }
        const cAsset = loan.collateralAsset.toLowerCase();
        if (Number(loan.collateralAssetType) === AssetType.ERC20) {
          const cMeta = metaByAsset.get(cAsset);
          const cPrice = priceByAsset.get(cAsset);
          if (cMeta && cPrice) {
            erc20CollateralUsd +=
              (Number(cPrice.price) / 10 ** cPrice.decimals) *
              (Number(loan.collateralAmount) / 10 ** cMeta.decimals);
          }
        } else {
          nftCollateralCount += 1;
        }
      }

      const totalUsd = principalUsd + erc20CollateralUsd;
      const next: TVLSnapshot = {
        totalUsd,
        erc20CollateralUsd,
        nftCollateralCount,
        principalUsd,
        byAsset,
        fetchedAt: Date.now(),
      };
      cache.set(key, { data: next, at: Date.now() });
      setSnapshot(next);
      step.success({ note: `TVL $${totalUsd.toFixed(2)}` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [publicClient, stats, chainId, diamondAddress, fetchActiveLoansFromIndexer]);

  useEffect(() => {
    // No longer gated on `stats` being ready — the indexer-first
    // path doesn't need it. Only the worker-down fallback consults
    // `stats`, and that branch handles the still-loading case
    // internally with an early return. `tvlWatermark` provides the
    // cool-tier auto-refresh trigger on its own watermark cadence.
    load();
  }, [load, tvlWatermark]);

  return { snapshot, loading: loading || statsLoading, error: error ?? statsError };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearTVLCache() {
  cache.clear();
}
