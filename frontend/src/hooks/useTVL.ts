import { useCallback, useEffect, useMemo, useState } from 'react';
import { Interface } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, type BatchCall } from '../lib/multicall';
import { AssetType, LoanStatus, type LoanDetails } from '../types/loan';
import { fetchTokenMeta } from '../lib/tokenMeta';
import { beginStep } from '../lib/journeyLog';
import { useProtocolStats } from './useProtocolStats';

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
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress;
  const { stats, loading: statsLoading, error: statsError } = useProtocolStats();
  const [snapshot, setSnapshot] = useState<TVLSnapshot | null>(
    () => cache.get(cacheKey(chainId, diamondAddress))?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(statsError ?? null);

  const iface = useMemo(() => new Interface(DIAMOND_ABI), []);

  const load = useCallback(async () => {
    if (!stats) return;

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
      const activeLoans = stats.loans.filter((l: LoanDetails) => {
        const s = Number(l.status);
        return s === LoanStatus.Active || s === LoanStatus.FallbackPending;
      });

      interface LegKey { asset: string; amount: bigint; kind: 'principal' | 'collateral'; isNft: boolean; }
      const legs: LegKey[] = [];
      for (const loan of activeLoans) {
        if (loan.principal > 0n && loan.principalAsset !== ZERO_ADDRESS) {
          legs.push({
            asset: loan.principalAsset.toLowerCase(),
            amount: loan.principal,
            kind: 'principal',
            isNft: Number(loan.assetType) !== AssetType.ERC20,
          });
        }
        if (loan.collateralAmount > 0n && loan.collateralAsset !== ZERO_ADDRESS) {
          legs.push({
            asset: loan.collateralAsset.toLowerCase(),
            amount: loan.collateralAmount,
            kind: 'collateral',
            isNft: Number(loan.collateralAssetType) !== AssetType.ERC20,
          });
        }
      }

      const uniqueAssets = Array.from(new Set(legs.map((l) => l.asset)));
      const priceCalls: BatchCall[] = uniqueAssets.map((a) => ({
        target: diamondAddress,
        callData: iface.encodeFunctionData('getAssetPrice', [a]),
      }));
      const priceResults = await batchCalls<[bigint, number]>(
        (diamond as unknown as { runner: { provider: never } }).runner.provider as never,
        iface,
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
            const m = await fetchTokenMeta(addr, diamond);
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
  }, [diamond, stats, iface, chainId, diamondAddress]);

  useEffect(() => {
    if (statsLoading || !stats) return;
    load();
  }, [load, statsLoading, stats]);

  return { snapshot, loading: loading || statsLoading, error: error ?? statsError };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearTVLCache() {
  cache.clear();
}
