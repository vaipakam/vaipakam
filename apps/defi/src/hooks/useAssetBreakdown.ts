import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { fetchTokenMeta } from '../lib/tokenMeta';
import { useLoanStats } from './useLoanStats';

export interface AssetBreakdownRow {
  asset: string;
  symbol: string;
  decimals: number;
  loans: number;
  /** Raw summed principal in token-native units (BigInt). */
  volume: bigint;
  /** USD value of `volume` at current oracle prices; 0 for assets
   *  without a feed (illiquid). */
  volumeUsd: number;
  /** % share of total USD volume; 0 when no asset has a USD price. */
  share: number;
  /** True iff the oracle returned a non-zero price for this asset. */
  liquid: boolean;
}

interface UseAssetBreakdownResult {
  rows: AssetBreakdownRow[] | null;
  loading: boolean;
}

/**
 * Indexer-first per-asset principal volume breakdown for the
 * Analytics page. Drives the "Asset distribution" section.
 *
 * Cost shape:
 *   - One worker call (`/loans/stats`) returns `{volumeByAsset,
 *     loansByAsset}` keyed by lowercased asset address.
 *   - One on-chain multicall over `getAssetPrice(asset)` for every
 *     UNIQUE asset (typically <10, scales with the protocol's
 *     supported-token set, not loan history). This is the only
 *     remaining chain read on the happy path — Chainlink prices
 *     have to come from the on-chain oracle adapter.
 *   - One per-asset `fetchTokenMeta` lookup for symbol + decimals,
 *     served from the existing localStorage-backed token cache so
 *     repeat visits hit zero RPC.
 *
 * Pre-refactor, the equivalent breakdown was derived inside
 * `useProtocolStats` from a `getLoanDetails` multicall over EVERY
 * loan. That multicall scaled linearly with protocol history; this
 * hook scales with the unique-asset set (effectively constant).
 *
 * Returns `rows: null` when the indexer is unreachable. The
 * Analytics page falls back to `useProtocolStats.assetBreakdown` in
 * that case.
 */
export function useAssetBreakdown(): UseAssetBreakdownResult {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = (chain.diamondAddress ??
    DEFAULT_CHAIN.diamondAddress) as Address;
  const { stats: loanStats, loading: statsLoading } = useLoanStats();
  const [rows, setRows] = useState<AssetBreakdownRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (statsLoading) return;
    if (!loanStats) {
      setRows(null);
      setLoading(false);
      return;
    }
    // Defensive shape filter — drop any malformed-address keys
    // (`"0x"` etc.) before the price multicall encodes them. The
    // server already filters at write time but old rows can still
    // surface bad-shape keys; viem's `getAssetPrice` encoder
    // throws `InvalidAddressError` if a non-20-byte hex slips in,
    // poisoning the whole batch. Cheap belt-and-braces guard.
    const assets = Object.keys(loanStats.volumeByAsset).filter(
      (a) =>
        typeof a === 'string' &&
        a.length === 42 &&
        a.startsWith('0x'),
    );
    if (assets.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Chain reads scale with the UNIQUE asset set. That set is
        // bounded by the protocol's supported-token list (~handful
        // of stables + a few collateral tokens), not by loan
        // history. Acceptable cost for an aggregate page.
        const priceCalls = encodeBatchCalls(
          diamondAddress,
          DIAMOND_ABI,
          'getAssetPrice',
          assets.map((a) => [a as Address] as const),
        );
        const priceResults = await batchCalls<[bigint, number]>(
          publicClient,
          DIAMOND_ABI,
          'getAssetPrice',
          priceCalls,
        );
        if (cancelled) return;
        const meta = await Promise.all(
          assets.map(async (a) => {
            try {
              const m = await fetchTokenMeta(a, publicClient);
              return { symbol: m.symbol, decimals: m.decimals };
            } catch {
              return { symbol: a.slice(0, 6) + '…', decimals: 18 };
            }
          }),
        );
        if (cancelled) return;

        // First pass: compute USD per asset (zero for illiquid).
        // Second pass derives the share against the USD total.
        type WorkRow = AssetBreakdownRow & { volumeUsdRaw: number };
        const work: WorkRow[] = assets.map((asset, i) => {
          const m = meta[i];
          const priceTuple = priceResults[i];
          const liquid = !!priceTuple && (priceTuple[0] ?? 0n) > 0n;
          const volume = BigInt(loanStats.volumeByAsset[asset] ?? '0');
          let volumeUsdRaw = 0;
          if (liquid && priceTuple) {
            const priceScaled =
              Number(priceTuple[0]) / 10 ** Number(priceTuple[1] ?? 8);
            const tokenScaled = Number(volume) / 10 ** m.decimals;
            volumeUsdRaw = priceScaled * tokenScaled;
          }
          return {
            asset,
            symbol: m.symbol,
            decimals: m.decimals,
            loans: loanStats.loansByAsset[asset] ?? 0,
            volume,
            volumeUsd: volumeUsdRaw,
            volumeUsdRaw,
            share: 0,
            liquid,
          };
        });
        const totalUsd = work.reduce((acc, r) => acc + r.volumeUsdRaw, 0);
        for (const r of work) {
          r.share = totalUsd > 0 ? (r.volumeUsdRaw / totalUsd) * 100 : 0;
        }
        // Largest first by USD volume; illiquid rows get 0 USD so
        // they sink to the bottom — same ordering convention the
        // legacy `useProtocolStats.assetBreakdown` used.
        work.sort((a, b) => b.volumeUsd - a.volumeUsd);
        if (!cancelled) {
          setRows(
            work.map(({ volumeUsdRaw: _drop, ...rest }) => rest),
          );
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setRows(null);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loanStats, statsLoading, publicClient, diamondAddress, chainId]);

  return { rows, loading };
}
