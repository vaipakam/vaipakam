import { useEffect, useMemo, useState } from 'react';
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
/** Shared empty result so the no-assets answer keeps a stable identity. */
const EMPTY_ROWS: AssetBreakdownRow[] = [];

export function useAssetBreakdown(): UseAssetBreakdownResult {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = (chain.diamondAddress ??
    DEFAULT_CHAIN.diamondAddress) as Address;
  const { stats: loanStats, loading: statsLoading } = useLoanStats();
  // Tagged with chain + Diamond + the exact asset set the rows describe. The
  // rows carry per-asset USD volume and a percentage SHARE of the total, so a
  // set computed for one chain rendered against another is not stale
  // decoration — the shares are a breakdown of a different total.
  //
  // `loanStats` is itself an async read (and keyed on chain since #1759), so
  // the two resolve at different times; without a tag, the analytics page
  // showed the previous chain's breakdown beside the new chain's totals.
  // Defensive shape filter — drop any malformed-address keys (`"0x"` etc.)
  // before the price multicall encodes them. The server already filters at
  // write time but old rows can still surface bad-shape keys; viem's
  // `getAssetPrice` encoder throws `InvalidAddressError` if a non-20-byte hex
  // slips in, poisoning the whole batch. Cheap belt-and-braces guard.
  //
  // Computed at RENDER, not inside the effect, because the empty case is an
  // ANSWER — no assets means no rows — and answers are derived here rather
  // than written from an effect. That was the last synchronous write left.
  const assets = useMemo(
    () =>
      Object.keys(loanStats?.volumeByAsset ?? {}).filter(
        (a) => typeof a === 'string' && a.length === 42 && a.startsWith('0x'),
      ),
    [loanStats],
  );

  const reqKey =
    statsLoading || !loanStats
      ? null
      : `${chainId}|${diamondAddress.toLowerCase()}|${[...assets].sort().join(',')}`;
  const [result, setResult] = useState<{ key: string; rows: AssetBreakdownRow[] | null } | null>(
    null,
  );

  useEffect(() => {
    if (!reqKey || !loanStats) return;
    if (assets.length === 0) return;
    let cancelled = false;
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
          setResult({
            key: reqKey,
            rows: work.map(({ volumeUsdRaw: _drop, ...rest }) => rest),
          });
        }
      } catch {
        if (!cancelled) setResult({ key: reqKey, rows: null });
      }
    })();
    return () => {
      cancelled = true;
      // Dropped on the way out so a chain returned to after a switch re-reads
      // rather than showing shares computed against the other chain's total.
      setResult(null);
    };
  }, [loanStats, statsLoading, publicClient, diamondAddress, chainId, reqKey, assets]);

  const matched = result?.key === reqKey;
  return {
    rows: reqKey !== null && assets.length === 0 ? EMPTY_ROWS : matched ? result.rows : null,
    // Still loading while the upstream stats are loading, and while this read
    // has not answered the current question. `loanStats === null` is a SETTLED
    // "indexer offline" answer, not a pending one — the page shows its own
    // placeholder for that and must not be pinned in a spinner.
    loading:
      statsLoading || (reqKey !== null && assets.length > 0 && !matched),
  };
}
