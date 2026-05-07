import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, http, parseAbi, type Abi, type Address, type PublicClient } from 'viem';
import { CHAIN_REGISTRY, type ChainConfig } from '../contracts/config';
import { MetricsFacetABI } from '../contracts/abis';
import { beginStep } from '../lib/journeyLog';

// `getGlobalCounts()` exists in current MetricsFacet.sol but not every
// deployed ABI snapshot. Defined inline here so viem can decode the call
// when the facet dispatches it; fetchChain swallows reverts so a missing
// selector doesn't break the rest of the row.
const EXTRA_ABI: Abi = parseAbi([
  'function getGlobalCounts() external view returns (uint256 totalLoansCreated, uint256 totalOffersCreated)',
]);
const FULL_ABI: Abi = [
  ...(MetricsFacetABI as unknown as Abi),
  ...EXTRA_ABI,
] as Abi;

const USD_SCALE = 1e18;
const STALE_MS = 30_000;
const HISTORY_KEY = 'vaipakam:combinedChainsStats:tvlHistory:v1';
const HISTORY_MAX_ENTRIES = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChainStatsRow {
  chainId: number;
  name: string;
  shortName: string;
  testnet: boolean;
  diamondAddress: string;
  tvlUsd: number;
  erc20CollateralUsd: number;
  nftCollateralCount: number;
  activeLoans: number;
  activeLoansValueUsd: number;
  lifetimeLoans: number;
  activeOffers: number;
  /** Every offer ever created on this chain — `nextOfferId` from the Diamond.
   *  Best-effort: if `getGlobalCounts()` isn't dispatched on the deployed
   *  facet set, this falls back to `activeOffers` so the UI degrades quietly. */
  lifetimeOffers: number;
  volumeLentUsd: number;
  interestEarnedUsd: number;
  error?: string;
}

export interface CombinedStats {
  /** Sum of {@link ChainStatsRow.tvlUsd} across chains that responded. */
  tvlUsd: number;
  /** Sum of ERC-20 collateral USD (subset of {@link tvlUsd}). */
  erc20CollateralUsd: number;
  /** Sum of NFT collateral COUNT (protocol reports NFT TVL as a count). */
  nftCollateralCount: number;
  activeLoans: number;
  activeLoansValueUsd: number;
  lifetimeLoans: number;
  activeOffers: number;
  /** Sum of {@link ChainStatsRow.lifetimeOffers} — every offer ever created
   *  across every responding chain. */
  lifetimeOffers: number;
  volumeLentUsd: number;
  interestEarnedUsd: number;
  /** Percent change in combined TVL vs. the earliest cached snapshot within
   *  the last 24h. `null` when no snapshot in that window (fresh install). */
  tvlChange24hPct: number | null;
  /** Same as {@link tvlChange24hPct} but anchored 7d back. */
  tvlChange7dPct: number | null;
  chainsCovered: number;
  chainsErrored: number;
  fetchedAt: number;
}

export interface CombinedChainsSnapshot {
  combined: CombinedStats;
  byChain: ChainStatsRow[];
}

interface CacheEntry {
  data: CombinedChainsSnapshot;
  at: number;
}

interface HistoryPoint {
  t: number;
  tvlUsd: number;
}

let cache: CacheEntry | null = null;

type DeployedChain = ChainConfig & { diamondAddress: string };

function deployedChains(): DeployedChain[] {
  return Object.values(CHAIN_REGISTRY).filter(
    (c): c is DeployedChain => c.diamondAddress !== null,
  );
}

function readHistory(): HistoryPoint[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryPoint[];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p.t === 'number' && typeof p.tvlUsd === 'number') : [];
  } catch {
    return [];
  }
}

function writeHistory(points: HistoryPoint[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(points.slice(-HISTORY_MAX_ENTRIES)));
  } catch {
    // quota / private mode — tolerate, deltas just won't compute until space.
  }
}

/**
 * Percent change of `current` relative to the most recent snapshot older than
 * `windowMs`. Returns null when there is no eligible snapshot (first load or
 * too fresh a history) or when the baseline is zero (avoid div-by-zero).
 */
function changePctAgainstWindow(
  history: HistoryPoint[],
  current: number,
  windowMs: number,
): number | null {
  const cutoff = Date.now() - windowMs;
  let baseline: HistoryPoint | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= cutoff) {
      baseline = history[i];
      break;
    }
  }
  if (!baseline || baseline.tvlUsd === 0) return null;
  return ((current - baseline.tvlUsd) / baseline.tvlUsd) * 100;
}

async function fetchChain(chain: DeployedChain): Promise<ChainStatsRow> {
  const row: ChainStatsRow = {
    chainId: chain.chainId,
    name: chain.name,
    shortName: chain.shortName,
    testnet: chain.testnet,
    diamondAddress: chain.diamondAddress,
    tvlUsd: 0,
    erc20CollateralUsd: 0,
    nftCollateralCount: 0,
    activeLoans: 0,
    activeLoansValueUsd: 0,
    lifetimeLoans: 0,
    activeOffers: 0,
    lifetimeOffers: 0,
    volumeLentUsd: 0,
    interestEarnedUsd: 0,
  };
  try {
    const publicClient = createPublicClient({
      transport: http(chain.rpcUrl),
    }) as PublicClient;
    const diamondAddress = chain.diamondAddress as Address;
    const call = async <T>(functionName: string): Promise<T> => {
      return (await publicClient.readContract({
        address: diamondAddress,
        abi: FULL_ABI,
        functionName,
      })) as T;
    };
    // `getProtocolStats` returns 8 fields (totalUniqueUsers, activeLoansCount,
    // activeOffersCount, totalLoansEverCreated, totalVolumeLentNumeraire,
    // totalInterestEarnedNumeraire, defaultRateBps, averageAPR) in one call — no
    // multicall needed. `getProtocolTVL` and `getLoanSummary` are both O(1)
    // counter-backed reads, so three parallel requests per chain is fine.
    const [tvlResult, statsResult, loanSummary] = await Promise.all([
      call<readonly [bigint, bigint, bigint]>('getProtocolTVL'),
      call<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]>(
        'getProtocolStats',
      ),
      call<readonly [bigint, bigint, bigint]>('getLoanSummary'),
    ]);
    row.tvlUsd = Number(tvlResult[0]) / USD_SCALE;
    row.erc20CollateralUsd = Number(tvlResult[1]) / USD_SCALE;
    row.nftCollateralCount = Number(tvlResult[2]);
    row.activeLoans = Number(statsResult[1]);
    row.activeOffers = Number(statsResult[2]);
    row.lifetimeLoans = Number(statsResult[3]);
    row.volumeLentUsd = Number(statsResult[4]) / USD_SCALE;
    row.interestEarnedUsd = Number(statsResult[5]) / USD_SCALE;
    row.activeLoansValueUsd = Number(loanSummary[0]) / USD_SCALE;
    // `getGlobalCounts` returns `nextOfferId`, which is the lifetime offer
    // count. The function is defined in MetricsFacet.sol but isn't in every
    // deployed ABI snapshot — swallow revert/unknown-selector so the rest of
    // the row still lands, and fall back to activeOffers for the headline.
    try {
      const globals = await call<readonly [bigint, bigint]>('getGlobalCounts');
      row.lifetimeOffers = Number(globals[1]);
    } catch {
      row.lifetimeOffers = row.activeOffers;
    }
  } catch (err) {
    row.error = (err as Error)?.message ?? 'fetch failed';
  }
  return row;
}

/**
 * Lightweight cross-chain aggregator — fans out one JsonRpcProvider per
 * deployed chain (`CHAIN_REGISTRY` entries whose `diamondAddress !== null`)
 * and calls three O(1) MetricsFacet getters per chain: `getProtocolTVL`,
 * `getProtocolStats`, `getLoanSummary`. Results are aggregated into a
 * protocol-wide roll-up plus a per-chain row used by selectors.
 *
 * TVL percent changes over the last 24h and 7d are derived from a
 * localStorage-persisted ring buffer of prior combined-TVL snapshots — each
 * successful load appends `{ t, tvlUsd }` so subsequent page visits can
 * compute deltas against real historical baselines without an archive node
 * or log-scan. On a fresh install the deltas are `null` until the first
 * snapshot is older than the corresponding window.
 *
 * Deliberately avoids {@link useProtocolStats} / {@link useTVL} because
 * those pull the whole loan list via multicall + log scans — multiplied
 * across every chain it would blow up the dashboard load and violate the
 * spec requirement that the public dashboard remain usable without a
 * wallet and at low RPC cost (docs/WebsiteReadme.md §"Data-fetching
 * strategy").
 *
 * Errored chains are reported in `row.error` and counted in
 * `combined.chainsErrored`; they don't prevent the roll-up from rendering
 * with the chains that did succeed.
 */
export function useCombinedChainsStats() {
  const [snapshot, setSnapshot] = useState<CombinedChainsSnapshot | null>(
    () => cache?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    const now = Date.now();
    if (cache && now - cache.at < STALE_MS) {
      setSnapshot(cache.data);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'dashboard',
      flow: 'useCombinedChainsStats',
      step: 'fan-out',
    });
    try {
      const targets = deployedChains();
      const rows = await Promise.all(targets.map((c) => fetchChain(c)));
      const ok = rows.filter((r) => !r.error);
      const errored = rows.length - ok.length;

      const tvlUsd = ok.reduce((a, r) => a + r.tvlUsd, 0);
      const history = readHistory();
      const tvlChange24hPct = changePctAgainstWindow(history, tvlUsd, DAY_MS);
      const tvlChange7dPct = changePctAgainstWindow(history, tvlUsd, 7 * DAY_MS);
      // Append the fresh sample only AFTER computing deltas so "change since
      // last visit" doesn't silently become 0%.
      writeHistory([...history, { t: Date.now(), tvlUsd }]);

      const combined: CombinedStats = {
        tvlUsd,
        erc20CollateralUsd: ok.reduce((a, r) => a + r.erc20CollateralUsd, 0),
        nftCollateralCount: ok.reduce((a, r) => a + r.nftCollateralCount, 0),
        activeLoans: ok.reduce((a, r) => a + r.activeLoans, 0),
        activeLoansValueUsd: ok.reduce((a, r) => a + r.activeLoansValueUsd, 0),
        lifetimeLoans: ok.reduce((a, r) => a + r.lifetimeLoans, 0),
        activeOffers: ok.reduce((a, r) => a + r.activeOffers, 0),
        lifetimeOffers: ok.reduce((a, r) => a + r.lifetimeOffers, 0),
        volumeLentUsd: ok.reduce((a, r) => a + r.volumeLentUsd, 0),
        interestEarnedUsd: ok.reduce((a, r) => a + r.interestEarnedUsd, 0),
        tvlChange24hPct,
        tvlChange7dPct,
        chainsCovered: ok.length,
        chainsErrored: errored,
        fetchedAt: Date.now(),
      };

      const next: CombinedChainsSnapshot = { combined, byChain: rows };
      cache = { data: next, at: Date.now() };
      setSnapshot(next);
      step.success({
        note: `${ok.length}/${rows.length} chains, TVL $${tvlUsd.toFixed(2)}`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cache = null;
    await load();
  }, [load]);

  return { snapshot, loading, error, reload };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearCombinedChainsStatsCache() {
  cache = null;
}

/** Test-only: wipe the persisted TVL history ring buffer. */
export function __clearCombinedChainsStatsHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}
