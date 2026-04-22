import { useCallback, useEffect, useMemo, useState } from 'react';
import { Interface } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, type BatchCall } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
import { AssetType, LoanStatus, type LoanDetails } from '../types/loan';
import { fetchTokenMeta } from '../lib/tokenMeta';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STALE_MS = 30_000;

export interface AssetBreakdown {
  asset: string;
  symbol: string;
  decimals: number;
  loans: number;
  /** Raw summed principal in token-native units (wei-scaled by token decimals). */
  volume: bigint;
  /** USD value of `volume` at current oracle prices; 0 for assets without a feed. */
  volumeUsd: number;
  /** Share of this asset expressed against USD-denominated total (0 if no USD total). */
  share: number;
  liquid: boolean;
}

export interface AssetPriceInfo {
  price: bigint;
  priceDecimals: number;
  tokenDecimals: number;
  symbol: string;
}

export interface ProtocolStats {
  totalLoans: number;
  activeLoans: number;
  completedLoans: number;
  defaultedLoans: number;
  totalOffers: number;
  activeOffers: number;
  totalVolumeByAsset: Record<string, bigint>;
  totalInterestBps: bigint;
  averageAprBps: number;
  nftRentalsActive: number;
  erc20ActiveLoans: number;
  assetBreakdown: AssetBreakdown[];
  collateralBreakdown: AssetBreakdown[];
  /** Lifetime sum of principal across every ERC-20 loan ever created, USD-priced
   *  at current oracle rates. Spec: `WebsiteReadme.md` top metrics. */
  totalVolumeLentUsd: number;
  /** Lifetime sum of earned interest on completed (non-active) ERC-20 loans,
   *  USD-priced at current oracle rates. */
  totalInterestEarnedUsd: number;
  /** Live USD value of ERC-20 principal across only currently-active loans. */
  activeLoansValueUsd: number;
  /** Per-asset metadata used for normalization elsewhere (histograms, charts). */
  assetInfo: Record<string, AssetPriceInfo>;
  loans: LoanDetails[];
  liquidationRate: number;
  blockNumber: number | null;
  fetchedAt: number;
}

interface CacheEntry {
  data: ProtocolStats;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(chainId: number, diamondAddress: string): string {
  return `${chainId}:${diamondAddress.toLowerCase()}`;
}

/**
 * Aggregates protocol-wide metrics used by the public analytics dashboard.
 * All values are derived from on-chain state (loan structs via multicall)
 * plus the event-backed loan / offer index. Everything is privacy-preserving
 * aggregate — no per-user lookups.
 *
 * Results are cached in-memory for {@link STALE_MS} to amortize the
 * multicall + log-scan cost across dashboard navigations.
 */
export function useProtocolStats() {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress;
  const {
    loans: indexedLoans,
    offerIds,
    openOfferIds,
    loading: indexLoading,
    error: indexError,
    reload: reloadIndex,
  } = useLogIndex();
  const [stats, setStats] = useState<ProtocolStats | null>(
    () => cache.get(cacheKey(chainId, diamondAddress))?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(indexError ?? null);

  const iface = useMemo(() => new Interface(DIAMOND_ABI), []);

  const load = useCallback(async () => {
    const key = cacheKey(chainId, diamondAddress);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setStats(cached.data);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useProtocolStats', step: 'multicall-loans' });
    try {
      const provider = (diamond as unknown as { runner?: { provider?: unknown } }).runner?.provider as
        | { getBlockNumber?: () => Promise<number> }
        | undefined;
      const blockNumber = provider?.getBlockNumber ? await provider.getBlockNumber() : null;

      const loanDetailsCalls: BatchCall[] = indexedLoans.map((l) => ({
        target: diamondAddress,
        callData: iface.encodeFunctionData('getLoanDetails', [l.loanId]),
      }));

      const loans = (await batchCalls<LoanDetails>(
        (diamond as unknown as { runner: { provider: never } }).runner.provider as never,
        iface,
        'getLoanDetails',
        loanDetailsCalls,
      )).filter((x): x is LoanDetails => x !== null);

      let activeLoans = 0;
      let completedLoans = 0;
      let defaultedLoans = 0;
      let nftRentalsActive = 0;
      let erc20ActiveLoans = 0;
      let totalInterestBps = 0n;
      let aprCount = 0;
      const volumeByAsset: Record<string, bigint> = {};
      const loansByAsset: Record<string, number> = {};
      const erc20AssetSet = new Set<string>();
      const collateralByAsset: Record<string, { vol: bigint; count: number }> = {};

      for (const loan of loans) {
        const status = Number(loan.status) as LoanStatus;
        const assetType = Number(loan.assetType) as AssetType;

        totalInterestBps += loan.interestRateBps;
        aprCount += 1;

        if (status === LoanStatus.Active || status === LoanStatus.FallbackPending) {
          activeLoans += 1;
          if (assetType === AssetType.ERC20) {
            erc20ActiveLoans += 1;
          } else {
            nftRentalsActive += 1;
          }
        } else if (status === LoanStatus.Defaulted) {
          defaultedLoans += 1;
          completedLoans += 1;
        } else {
          completedLoans += 1;
        }

        const pa = loan.principalAsset.toLowerCase();
        volumeByAsset[pa] = (volumeByAsset[pa] ?? 0n) + loan.principal;
        loansByAsset[pa] = (loansByAsset[pa] ?? 0) + 1;
        if (assetType === AssetType.ERC20) erc20AssetSet.add(pa);

        if (loan.collateralAsset && loan.collateralAsset !== ZERO_ADDRESS) {
          const ca = loan.collateralAsset.toLowerCase();
          const bucket = collateralByAsset[ca] ?? { vol: 0n, count: 0 };
          bucket.vol += loan.collateralAmount;
          bucket.count += 1;
          collateralByAsset[ca] = bucket;
        }
      }

      // ── Fetch oracle price + token metadata for every ERC-20 asset touched
      //    so volume/interest figures are comparable across assets (USDC 6d,
      //    WBTC 8d, WETH 18d...) rather than raw token-native summed bigints.
      const pricedAssets = Array.from(erc20AssetSet);
      const priceCalls: BatchCall[] = pricedAssets.map((a) => ({
        target: diamondAddress,
        callData: iface.encodeFunctionData('getAssetPrice', [a]),
      }));
      const priceResults = pricedAssets.length
        ? await batchCalls<[bigint, number]>(
            (diamond as unknown as { runner: { provider: never } }).runner.provider as never,
            iface,
            'getAssetPrice',
            priceCalls,
          )
        : [];

      const assetInfo: Record<string, AssetPriceInfo> = {};
      await Promise.all(
        pricedAssets.map(async (addr, i) => {
          let symbol = addr.slice(0, 6) + '…';
          let tokenDecimals = 18;
          try {
            const m = await fetchTokenMeta(addr, diamond);
            symbol = m.symbol;
            tokenDecimals = m.decimals;
          } catch {
            /* asset without standard metadata — keep defaults */
          }
          const r = priceResults[i];
          assetInfo[addr] = {
            price: r ? (r[0] as bigint) : 0n,
            priceDecimals: r ? Number(r[1] ?? 8) : 0,
            tokenDecimals,
            symbol,
          };
        }),
      );

      const priceUsd = (asset: string, amount: bigint): number => {
        const info = assetInfo[asset];
        if (!info || info.price === 0n || amount === 0n) return 0;
        const priceScaled = Number(info.price) / 10 ** info.priceDecimals;
        const tokenScaled = Number(amount) / 10 ** info.tokenDecimals;
        return priceScaled * tokenScaled;
      };

      let totalVolumeLentUsd = 0;
      let totalInterestEarnedUsd = 0;
      let activeLoansValueUsd = 0;
      for (const loan of loans) {
        if (Number(loan.assetType) !== AssetType.ERC20) continue;
        const pa = loan.principalAsset.toLowerCase();
        const usd = priceUsd(pa, loan.principal);
        totalVolumeLentUsd += usd;
        const status = Number(loan.status) as LoanStatus;
        if (status === LoanStatus.Active || status === LoanStatus.FallbackPending) {
          activeLoansValueUsd += usd;
        } else {
          totalInterestEarnedUsd += (usd * Number(loan.interestRateBps)) / 10000;
        }
      }

      const totalCollateralSum = Object.values(collateralByAsset).reduce(
        (acc, v) => acc + v.vol,
        0n,
      );

      const assetBreakdown: AssetBreakdown[] = Object.entries(volumeByAsset)
        .map(([asset, volume]) => {
          const info = assetInfo[asset];
          const volumeUsd = priceUsd(asset, volume);
          return {
            asset,
            symbol: info?.symbol ?? asset.slice(0, 6) + '…',
            decimals: info?.tokenDecimals ?? 18,
            loans: loansByAsset[asset] ?? 0,
            volume,
            volumeUsd,
            share:
              totalVolumeLentUsd === 0 ? 0 : (volumeUsd / totalVolumeLentUsd) * 100,
            liquid: !!info && info.price > 0n,
          };
        })
        .sort((a, b) => b.volumeUsd - a.volumeUsd);

      const collateralBreakdown: AssetBreakdown[] = Object.entries(collateralByAsset)
        .map(([asset, bucket]) => {
          const info = assetInfo[asset];
          const volumeUsd = info ? priceUsd(asset, bucket.vol) : 0;
          return {
            asset,
            symbol: info?.symbol ?? asset.slice(0, 6) + '…',
            decimals: info?.tokenDecimals ?? 18,
            loans: bucket.count,
            volume: bucket.vol,
            volumeUsd,
            share:
              totalCollateralSum === 0n
                ? 0
                : Number((bucket.vol * 10000n) / totalCollateralSum) / 100,
            liquid: !!info && info.price > 0n,
          };
        })
        .sort((a, b) => b.volumeUsd - a.volumeUsd);

      const averageAprBps = aprCount === 0 ? 0 : Number(totalInterestBps) / aprCount;
      const liquidationRate =
        loans.length === 0 ? 0 : (defaultedLoans / loans.length) * 100;

      const next: ProtocolStats = {
        totalLoans: loans.length,
        activeLoans,
        completedLoans,
        defaultedLoans,
        totalOffers: offerIds.length,
        activeOffers: openOfferIds.length,
        totalVolumeByAsset: volumeByAsset,
        totalInterestBps,
        averageAprBps,
        nftRentalsActive,
        erc20ActiveLoans,
        assetBreakdown,
        collateralBreakdown,
        totalVolumeLentUsd,
        totalInterestEarnedUsd,
        activeLoansValueUsd,
        assetInfo,
        loans,
        liquidationRate,
        blockNumber,
        fetchedAt: Date.now(),
      };
      cache.set(key, { data: next, at: Date.now() });
      setStats(next);
      step.success({ note: `${loans.length} loans aggregated` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, indexedLoans, offerIds, openOfferIds, iface, chainId, diamondAddress]);

  useEffect(() => {
    if (indexLoading) return;
    load();
  }, [load, indexLoading]);

  const reload = useCallback(async () => {
    cache.delete(cacheKey(chainId, diamondAddress));
    await reloadIndex();
    await load();
  }, [reloadIndex, load, chainId, diamondAddress]);

  return {
    stats,
    loading: loading || indexLoading,
    error: error ?? indexError,
    reload,
  };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearProtocolStatsCache() {
  cache.clear();
}
