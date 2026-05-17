import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { Address, Hex } from 'viem';
import { encodeFunctionData } from 'viem';
import { SimulationPreview } from '../components/app/SimulationPreview';
import { LiquidityPreflightBanner } from '../components/app/LiquidityPreflightBanner';
import { useLiquidityPreflight } from '../hooks/useLiquidityPreflight';
import { useAssetLiquidity } from '../hooks/useAssetLiquidity';
import { usePermit2Signing } from '../hooks/usePermit2Signing';
import { useWallet } from '../context/WalletContext';
import { useWalletClient } from 'wagmi';
import { useDiamondContract, useDiamondRead, useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { buildErc20Proxy } from '../contracts/useERC20';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { L as Link } from '../components/L';
import { BookOpen, PlusCircle, AlertTriangle, ShieldCheck, Droplet, ListOrdered, Wallet } from 'lucide-react';
import { Picker } from '@vaipakam/ui/Picker';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { SanctionsBanner } from '../components/app/SanctionsBanner';
import { RiskDisclosures, RiskConsentLabel } from '../components/app/RiskDisclosures';
import { DEFAULT_CHAIN } from '../contracts/config';
import { beginStep, emit } from '../lib/journeyLog';
import { decodeContractError, extractRevertSelector } from '@vaipakam/lib/decodeContractError';
import { useLogIndex } from '../hooks/useLogIndex';
import { useOnchainActiveOfferIds } from '../hooks/useOnchainActiveOfferIds';
import { useIndexedActiveOffers } from '../hooks/useIndexedActiveOffers';
import { useActiveOffersByAssetPairRanked } from '../hooks/useActiveOffersByAssetPairRanked';
import { OFFER_BOOK_PAGE_SIZE } from '../lib/offerBookConfig';
import { OFFER_DURATION_BUCKETS_DAYS } from '../lib/offerSchema';
import { useRescanCooldown } from '../hooks/useRescanCooldown';
import { RescanButton } from '../components/app/RescanButton';
import { DataSyncStatus } from '../components/app/DataSyncStatus';
import { indexedToRawOffer } from '../lib/indexerClient';
import { useProtocolConfig, type ProtocolConfig } from '../hooks/useProtocolConfig';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { AssetLink } from '../components/app/AssetLink';
import { AssetPicker } from '../components/app/AssetPicker';
import { MarketRateWidget } from '../components/app/MarketRateWidget';
import { TokenAmount } from '../components/app/TokenAmount';
import { PrincipalCell } from '../components/app/PrincipalCell';
import { bpsToPercent } from '../lib/format';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import { AddressDisplay } from '../components/app/AddressDisplay';
import { CardInfo } from '../components/CardInfo';
import { InfoTip } from '@vaipakam/ui/InfoTip';
import {
  matchesFilter as matchesFilterPure,
  rankLenderSide as rankLenderSidePure,
  rankBorrowerSide as rankBorrowerSidePure,
  rankByDistanceToAnchor as rankByDistanceToAnchorPure,
  rankByRecency as rankByRecencyPure,
  type LiquidityFilter as LibLiquidityFilter,
} from '../lib/offerBookRanking';
import './OfferBook.css';

export const OFFER_TYPE_LABELS = ['Lender', 'Borrower'] as const;
export const LIQUIDITY_LABELS = ['Liquid', 'Illiquid'] as const;
export const ASSET_TYPE_LABELS = ['ERC-20', 'ERC-721', 'ERC-1155'] as const;
// Page-size cap for `fetchBatch` hydration. Tuned via the
// VITE_OFFER_BOOK_PAGE_SIZE env var (default 200, clamped [50, 1000]).
// Pre-Phase 7d this was a hard-coded 200; the env knob lets operators
// dial up bandwidth on chains with deep pair buckets without a code
// change. The skinny ranking call is independent of this cap — sort
// across the entire (lending, collateral) bucket stays free.
const WINDOW_SIZE = OFFER_BOOK_PAGE_SIZE;

/**
 * Recency-desc comparator over `OfferRanking` rows for the pair-filtered
 * lender / borrower views — newest `createdAt` first, id-descending
 * tiebreaker so the order is stable across pair-bucket re-fetches. (This
 * used to be a user-selectable `SortChoice` dropdown — removed: the
 * OfferBook's open view already has a sensible default ordering and the
 * closed view's natural order is recency, so a manual sort was a
 * redundant power feature. The `both` tab keeps its own
 * closest-to-anchor ranking elsewhere.)
 */
function compareOfferRankingByRecencyDesc(
  a: import('../hooks/useActiveOffersByAssetPairRanked').OfferRanking,
  b: import('../hooks/useActiveOffersByAssetPairRanked').OfferRanking,
): number {
  if (a.createdAt > b.createdAt) return -1;
  if (a.createdAt < b.createdAt) return 1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
/** Upper bound on the per-side row count the user can dial in, scoped to the
 *  active tab. `both` sees two columns so each side caps at 50 rows; on a
 *  single-side tab all vertical space is one list, so the cap rises to 100. */
const MAX_PER_SIDE_BOTH = 50;
const MAX_PER_SIDE_SINGLE = 100;
const DEFAULT_PER_SIDE = 20;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export interface OfferData {
  id: bigint;
  creator: string;
  offerType: number;
  lendingAsset: string;
  amount: bigint;
  interestRateBps: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  durationDays: bigint;
  principalLiquidity: number;
  collateralLiquidity: number;
  accepted: boolean;
  assetType: number;
  tokenId: bigint;
  /** Creator-set opt-in for borrower-initiated partial repay on the
   *  resulting loan. The acceptor's act of accepting IS their consent;
   *  there's no acceptor-side override. Snapshotted to
   *  `Loan.allowsPartialRepay` at init and gates `RepayFacet.repayPartial`. */
  allowsPartialRepay: boolean;
  /** T-034 — lender-set Periodic Interest Payment cadence
   *  (0 = None ... 4 = Annual). Snapshotted onto the loan at acceptance.
   *  Acceptors must explicitly acknowledge non-`None` cadences before
   *  the accept button enables. */
  periodicInterestCadence: number;
  // Phase 6: per-keeper per-offer enable flags live in
  // `s.offerKeeperEnabled[offerId][keeper]`. No single flag on the offer
  // struct. Per-offer keeper selection is surfaced on the offer card
  // only for the creator — see OfferKeeperPicker.
}

type TabFilter = 'both' | 'lender' | 'borrower';
type LiquidityFilter = LibLiquidityFilter;
// Orthogonal to the side tab above: swaps the id source between the live
// open book and the historical (filled) offers. "Closed" intentionally omits
// canceled offers because `cancelOffer` deletes the storage slot, so there's
// no data left to render — only accepted offers retain full details.
export type StatusView = 'open' | 'closed';

// Populated when the review modal opens for an ERC20 + liquid Lender offer
// (acceptor becomes the borrower). Drives the Loan Initiation Fee row in the
// modal so the user sees whether the VPFI discount path will fire.
interface DiscountPreview {
  consentEnabled: boolean;
  eligible: boolean;
  vpfiRequired: bigint;
  escrowVpfi: bigint;
  willFire: boolean;
  tier: number;
}

// Tier → effective initiation-fee percent after the tiered discount, per
// docs/TokenomicsTechSpec.md §6. Tier 0 means no discount (0.1% flat).
// Phase 5 removed the inline "tierFeeLabel" render helper since the
// flow now always charges the full 0.1% LIF in VPFI up-front and pays
// a time-weighted rebate later — the per-tier effective-fee label no
// longer applies at quote time. Rebate percentage is shown directly.

function tierDiscountPct(tier: number, config: ProtocolConfig | null): string {
  if (tier < 1 || tier > 4) return '0%';
  const bps = config?.tierDiscountBps[tier - 1] ?? 0;
  return formatBpsPct(bps);
}

/** BPS → "0.1%" / "10%" — min of 3 sig figs to avoid rendering "0.08%" as "0.1%".
 *  Locale-aware: emits "5,00 %" in fr-FR / "5.00%" in en-US / "٥٫٠٠٪" in ar etc.
 *  via Intl.NumberFormat with `style: 'percent'`. */
function formatBpsPct(bps: number): string {
  const pct = bps / 100;
  const lng = i18n.resolvedLanguage ?? 'en';
  // Pick fraction-digit count: integers display as integers, others
  // render up to 3 fractional digits with trailing zeros trimmed
  // (Intl handles the trim via maximumFractionDigits).
  const digits = Number.isInteger(pct) ? 0 : 3;
  return new Intl.NumberFormat(lng, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(pct / 100);
}

export type RawOffer = {
  id: bigint;
  creator: string;
  offerType: bigint | number;
  lendingAsset: string;
  amount: bigint;
  interestRateBps: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  durationDays: bigint;
  principalLiquidity: bigint | number;
  collateralLiquidity: bigint | number;
  accepted: boolean;
  assetType: bigint | number;
  tokenId: bigint;
  allowsPartialRepay?: boolean;
  periodicInterestCadence?: bigint | number;
};

export function toOfferData(r: RawOffer): OfferData {
  return {
    id: r.id,
    creator: r.creator,
    offerType: Number(r.offerType),
    lendingAsset: r.lendingAsset,
    amount: r.amount,
    interestRateBps: r.interestRateBps,
    collateralAsset: r.collateralAsset,
    collateralAmount: r.collateralAmount,
    durationDays: r.durationDays,
    principalLiquidity: Number(r.principalLiquidity),
    collateralLiquidity: Number(r.collateralLiquidity),
    accepted: r.accepted,
    assetType: Number(r.assetType),
    tokenId: r.tokenId,
    allowsPartialRepay: r.allowsPartialRepay ?? false,
    periodicInterestCadence: Number(r.periodicInterestCadence ?? 0),
  };
}

export default function OfferBook() {
  const { t } = useTranslation();
  const { address, chainId } = useWallet();
  const diamond = useDiamondContract();
  const diamondRead = useDiamondRead();
  const { data: walletClient } = useWalletClient();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
  // The wallet's active chain (or DEFAULT_CHAIN fallback when disconnected).
  // Used to target multicalls and build explorer links at the Diamond the
  // user's reads are actually hitting, instead of hard-coding DEFAULT_CHAIN.
  const activeReadChain = useReadChain();
  const { openOfferIds, closedOfferIds, recentAcceptedOfferIds, events: indexEvents, loading: indexLoading, reload: reloadIndex } = useLogIndex();
  // T-041 Phase 1+2 — try the worker-cached active-offers list first.
  // When `source === 'indexer'`, the OPEN view consumes the indexer's
  // pre-fetched rows directly via the effect below, skipping the per-
  // id `getOfferDetails` pagination. When `source === 'fallback'`
  // (worker down / 5xx / VITE_AGENT_ORIGIN unset) the existing
  // log-scan path runs unchanged. The Closed view always takes the
  // on-chain path — closed-offer rendering isn't a Phase 1 priority.
  const {
    offers: indexedOffers,
    source: indexedSource,
    refetch: refetchIndexedOffers,
  } = useIndexedActiveOffers();
  // When the central indexer (D1) is confirmed down (`source ===
  // 'fallback'`), pull the authoritative active-offer-id list straight
  // from the Diamond (`getActiveOffersPaginated`) instead of relying on
  // `useLogIndex`'s `eth_getLogs`-scanned `openOfferIds`. `legacyOpenIds`
  // prefers the on-chain getter when it's resolved, otherwise falls to
  // the log scan (which is also the path for a stale-but-up indexer that
  // returns 0). When the indexer is healthy this hook is disabled and
  // `legacyOpenIds === openOfferIds`, so nothing changes.
  const { ids: onchainActiveOfferIds } = useOnchainActiveOfferIds(
    indexedSource === 'fallback',
  );
  const legacyOpenIds = onchainActiveOfferIds ?? openOfferIds;
  const rescanCooldown = useRescanCooldown({ loading: indexLoading });
  // Map<offerId, loanId> derived from `OfferAccepted` events in the
  // log-index. Each accepted offer's event carries its resulting loanId,
  // so we can render an inline `Loan #N →` link next to the Filled pill
  // in the Closed view without any extra RPC. Cancelled offers are
  // absent from this map (only OfferAccepted populates it), so the link
  // never appears for cancelled rows.
  const offerToLoan = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of indexEvents) {
      if (ev.kind !== 'OfferAccepted') continue;
      if (typeof ev.args.offerId !== 'string') continue;
      if (typeof ev.args.loanId !== 'string') continue;
      m.set(ev.args.offerId, ev.args.loanId);
    }
    return m;
  }, [indexEvents]);
  const { config: protocolConfig } = useProtocolConfig();

  const [statusView, setStatusView] = useState<StatusView>('open');

  // `sortedIds` definition is hoisted further down — past the filter
  // state declarations — because the pair-path branch reads
  // `lendingAssetFilter` / `collateralAssetFilter`. The closed-tab
  // path still ranks by id descending; the open-tab pair path ranks
  // by createdAt descending and is fed by the skinny-ranking hook.

  const [offers, setOffers] = useState<OfferData[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<TabFilter>('both');
  // User-selectable per-side cap with a tab-scoped upper bound: both-sides
  // view caps at 50/side (2-column layout budget), single-side tabs rise to
  // 100. Default 20; the input below clamps to [MIN_PER_SIDE, maxPerSide].
  const [perSide, setPerSide] = useState<number>(DEFAULT_PER_SIDE);
  const maxPerSide = tab === 'both' ? MAX_PER_SIDE_BOTH : MAX_PER_SIDE_SINGLE;
  useEffect(() => {
    if (perSide > maxPerSide) setPerSide(maxPerSide);
  }, [maxPerSide, perSide]);
  const [acceptingId, setAcceptingId] = useState<bigint | null>(null);
  const [pendingOffer, setPendingOffer] = useState<OfferData | null>(null);
  const [riskAndTermsConsent, setRiskAndTermsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [discountPreview, setDiscountPreview] = useState<DiscountPreview | null>(null);

  // Market filters. Initialised from the chain's per-chain default
  // pair (predominant stablecoin × wrapped-native) so the OfferBook
  // lands on the most-relevant market without user input. Both legs
  // are required — the AssetPicker's clear button resets to the
  // chain default rather than a free-text empty (see the wrapper
  // setters below).
  const defaultLendingAsset = activeReadChain.predominantStableAddress ?? '';
  // Per the 2026-05-14 WETH chain-safety audit: prefer the canonical
  // bridged-WETH9 ERC-20 over the chain's wrapped-native for the
  // OfferBook default collateral. On ETH-native chains the two are
  // identical so the fallback to `wrappedNativeAddress` is a no-op.
  // On BNB Chain mainnet (and Polygon PoS if/when added),
  // `wrappedNativeAddress` is WBNB / WPOL — wrong asset for an
  // ETH-collateral-by-default OfferBook landing experience.
  const defaultCollateralAsset =
    activeReadChain.bridgedWethAddress ??
    activeReadChain.wrappedNativeAddress ??
    '';
  const [lendingAssetFilter, setLendingAssetFilterRaw] = useState<string>(defaultLendingAsset);
  const [collateralAssetFilter, setCollateralAssetFilterRaw] = useState<string>(defaultCollateralAsset);
  // Wrap the setters so AssetPicker's "clear" (passes empty string)
  // resets to the chain default — keeps the required-pair invariant
  // without changing AssetPicker itself. Updates also flow when the
  // user picks a different non-empty asset.
  const setLendingAssetFilter = useCallback(
    (next: string) => {
      setLendingAssetFilterRaw(next === '' ? defaultLendingAsset : next);
    },
    [defaultLendingAsset],
  );
  const setCollateralAssetFilter = useCallback(
    (next: string) => {
      setCollateralAssetFilterRaw(next === '' ? defaultCollateralAsset : next);
    },
    [defaultCollateralAsset],
  );
  // Re-pre-fill on chain switch — defaults differ across chains
  // (e.g. USDT/WBNB on BNB, USDC/WETH on Base), so a chain change
  // resets both filters to the new chain's pair.
  useEffect(() => {
    setLendingAssetFilterRaw(defaultLendingAsset);
    setCollateralAssetFilterRaw(defaultCollateralAsset);
  }, [defaultLendingAsset, defaultCollateralAsset]);
  // Single-select duration bucket filter — `''` = any, otherwise a
  // day-count string from `OFFER_DURATION_BUCKETS_DAYS` (matching the
  // CreateOffer duration picker). Replaced the prior min/max numeric
  // inputs: every UI-created offer carries a bucketed duration, so an
  // exact-match-on-bucket filter fits the data.
  const [durationFilter, setDurationFilter] = useState('');
  const [liquidityFilter, setLiquidityFilter] = useState<LiquidityFilter>('any');

  // Anchor for the currently-filtered market. We pull the last N accepted
  // offers from the log index and pick the freshest one that passes the
  // current `matchesFilter` — so narrowing the filter (e.g. flipping to
  // "Liquid only", or specifying a collateral asset) doesn't blow away the
  // anchor when an even-fresher match exists on the OTHER side of that
  // dimension. Each entry carries the same shape `matchesFilter` reads on
  // visible offers so the predicate is identical for both.
  const [recentMatchedRates, setRecentMatchedRates] = useState<
    Array<{ rate: bigint; lendingAsset: string; collateralAsset: string; durationDays: bigint; principalLiquidity: number }>
  >([]);

  const publicClient = useDiamondPublicClient();
  const loadedIdsRef = useRef<Set<string>>(new Set());

  // ── 2-filter pair path ───────────────────────────────────────────
  //
  // Active on the OPEN tab whenever both filters resolve to a
  // non-empty address — which is the default state on every chain
  // that has its wrappedNativeAddress + predominantStableAddress
  // populated in ChainConfig. On chains without those defaults the
  // hook arguments fold to null, the call doesn't fire, and the
  // OfferBook falls back to the legacy log-index / worker-indexer
  // path that ranks by id.
  //
  // The skinny-ranking hook fetches the entire (lending, collateral)
  // bucket in one round trip — sort across the full bucket happens
  // in JS without re-hitting the chain. The page-N hydration that
  // populates the actually-rendered rows still goes through the
  // existing `fetchBatch` multicall below, which means the
  // `offers` / `cursor` state machine, "Load more" UI, and
  // anchor-driven ranking all keep working with no further changes.
  const usePairPath =
    statusView === 'open' &&
    lendingAssetFilter !== '' &&
    collateralAssetFilter !== '';
  const {
    rankings: pairRankings,
    refresh: refreshPairRankings,
  } = useActiveOffersByAssetPairRanked(
    usePairPath ? (lendingAssetFilter as Address) : null,
    usePairPath ? (collateralAssetFilter as Address) : null,
  );

  // Sort ids descending so we fetch the newest offers first. The cursor
  // then walks backward in id space when the user expands the window.
  //
  // Pair path: derive ids from the skinny ranking rows, recency-DESC.
  // This is also what the both-tab needs — the downstream
  // `rankByDistance` step picks closest-to-anchor offers from the loaded
  // slice, so a representative recent slice is what makes the anchor
  // calculation meaningful for the depth-chart layout. (Pre-this-change
  // the lender/borrower tabs ran a user-chosen `sortChoice` here; the
  // sort dropdown was removed, so all tabs use recency-DESC now.)
  const sortedIds = useMemo(() => {
    if (usePairPath) {
      return [...pairRankings]
        .sort(compareOfferRankingByRecencyDesc)
        .map((r) => r.id);
    }
    const src = statusView === 'open' ? legacyOpenIds : closedOfferIds;
    return [...src].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  }, [usePairPath, pairRankings, legacyOpenIds, closedOfferIds, statusView]);

  // True when the worker indexer returned a fresh OPEN-tab page. The
  // OfferBook then renders directly from `indexedOffers` and skips
  // the legacy on-chain log-scan pagination below. Hoisted up here
  // so the reset-on-`sortedIds` effect can guard on it (see comment
  // on that effect).
  // The legacy worker-indexer path is suppressed on the pair-keyed
  // OPEN view: the new skinny-ranking call already covers the full
  // (lending, collateral) bucket and routes the ids through the same
  // `loadWindow` → `fetchBatch` pipeline below. Letting both paths
  // run would double-write `offers` from two sources with diverging
  // ranking semantics.
  //
  // Stale-indexer reconciliation (2026-05-11): the indexer can return
  // an EMPTY array when its cursor has jumped past on-chain events
  // (e.g. after a `deploy-testnet.sh --fresh` auto-reseed-at-safe-head,
  // or after any other path that wrote `indexer_cursor` ahead of the
  // canonical Diamond's actual deploy block — see the
  // ReleaseNotes-2026-05-11.md "Auto-reseed-at-safe-head" entry for
  // the full root cause). When that happens, `indexedOffers === []`
  // BUT `useLogIndex` has scraped the on-chain `OfferCreated` events
  // and `sortedIds` is non-empty. The original gate treated the
  // indexer's empty response as authoritative, so the page rendered
  // 0 offers + showed a Load More button (because hasMore = cursor <
  // sortedIds.length). User clicks Load More → legacy path fetches
  // the 8 on-chain offers → they finally show up. That's a UX bug
  // — the user shouldn't need a manual click to recover from indexer
  // staleness. Fall through to the legacy log-scan path when the
  // indexer disagrees with the on-chain log index.
  const indexerServingOpen =
    statusView === 'open' &&
    !usePairPath &&
    indexedSource === 'indexer' &&
    indexedOffers !== null &&
    !(indexedOffers.length === 0 && sortedIds.length > 0);

  // Near-real-time updates on the pair path: when the global log
  // index sees an OfferCreated / OfferAccepted / OfferCanceled event
  // for the current (lending, collateral) pair, invalidate the
  // skinny-ranking cache so the next render reflects it. The legacy
  // path doesn't need this — `useLogIndex` already updates
  // `openOfferIds` directly. Without this wire, new offers would
  // appear within the hook's 30 s staleness window; with it, they
  // appear within seconds of the event landing at the user's RPC.
  useEffect(() => {
    if (!usePairPath) return;
    if (indexEvents.length === 0) return;
    const lendingLower = lendingAssetFilter.toLowerCase();
    const collateralLower = collateralAssetFilter.toLowerCase();
    const matchesPair = indexEvents.some((ev) => {
      if (
        ev.kind !== 'OfferCreated' &&
        ev.kind !== 'OfferAccepted' &&
        ev.kind !== 'OfferCanceled'
      ) {
        return false;
      }
      const lending = (ev.args.lendingAsset ?? '').toString().toLowerCase();
      const collateral = (ev.args.collateralAsset ?? '').toString().toLowerCase();
      return lending === lendingLower && collateral === collateralLower;
    });
    if (matchesPair) void refreshPairRankings();
    // We deliberately depend on `indexEvents` (the array reference) —
    // useLogIndex re-creates it on every batch flush, so this fires
    // once per flush rather than once per event.
  }, [indexEvents, usePairPath, lendingAssetFilter, collateralAssetFilter, refreshPairRankings]);

  // Reset cumulative state whenever the open set changes so we don't
  // carry stale rows across reloads.
  //
  // Skipped while the indexer path is serving — that path owns the
  // `offers` array through its own effect (the `indexerServingOpen`
  // block further below) and re-populates from `indexedOffers`, NOT
  // from `sortedIds`. Wiping here on a `sortedIds` reference change
  // (which fires every time the legacy log scan returns, even with
  // an identical-or-empty result) would blank the indexer-served
  // list and leave the page empty until the user manually clicked
  // "Load more" — exactly the symptom that triggered this fix. The
  // indexer effect itself triggers on `indexedOffers` change, which
  // is the correct reset axis for indexer-served data.
  useEffect(() => {
    if (indexerServingOpen) return;
    setOffers([]);
    setCursor(0);
    loadedIdsRef.current = new Set();
  }, [sortedIds, indexerServingOpen]);

  const fetchBatch = useCallback(async (ids: bigint[]): Promise<OfferData[]> => {
    if (ids.length === 0) return [];
    const target = (activeReadChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
    let decoded: (RawOffer | null)[] = [];
    try {
      const calls = encodeBatchCalls(
        target,
        DIAMOND_ABI,
        'getOffer',
        ids.map((id) => [id] as const),
      );
      decoded = await batchCalls<RawOffer>(publicClient, DIAMOND_ABI, 'getOffer', calls);
      if (decoded.every((d) => d === null)) throw new Error('multicall empty');
    } catch {
      decoded = [];
      for (const id of ids) {
        try {
          decoded.push((await diamondRead.getOffer(id)) as RawOffer);
        } catch {
          decoded.push(null);
        }
      }
    }
    const out: OfferData[] = [];
    // Diagnostic counters — one bucket per drop reason so a "Scanned 1
    // of 1 but 0 displayed" state is self-explanatory in DevTools.
    const dropReasons = { nullDecode: 0, zeroCreator: 0, accepted: 0, notAccepted: 0 };
    for (const raw of decoded) {
      if (!raw) {
        dropReasons.nullDecode++;
        continue;
      }
      // Canceled offers are impossible to display — `cancelOffer` deletes the
      // storage slot, so `creator` comes back as the zero address. Skip in
      // both views; the Closed view intentionally surfaces only filled
      // (accepted) offers, which retain their full struct.
      if (!raw.creator || raw.creator.toLowerCase() === ZERO_ADDR) {
        dropReasons.zeroCreator++;
        continue;
      }
      if (statusView === 'open' && raw.accepted) {
        dropReasons.accepted++;
        continue;
      }
      if (statusView === 'closed' && !raw.accepted) {
        dropReasons.notAccepted++;
        continue;
      }
      out.push(toOfferData(raw));
    }
    if (ids.length > 0 && out.length === 0) {
      console.debug(
        `[OfferBook] fetchBatch: requested ${ids.length} id(s), decoded ${decoded.length}, filtered to 0. Drops:`,
        dropReasons,
        `statusView=${statusView} ids=${ids.map(String).join(',')}`,
        'decoded[0]:',
        decoded[0],
      );
    }
    return out;
  }, [diamondRead, publicClient, activeReadChain.diamondAddress, statusView]);

  const loadWindow = useCallback(async (from: number, size: number) => {
    const slice = sortedIds.slice(from, from + size).filter((id: bigint) => !loadedIdsRef.current.has(id.toString()));
    if (slice.length === 0) {
      setCursor(from + size);
      return;
    }
    setLoading(true);
    const step = beginStep({
      area: 'offer-book',
      flow: 'loadWindow',
      step: 'scan-offers',
      note: `${slice.length} ids [${from}..${from + size})`,
    });
    try {
      const fresh = await fetchBatch(slice);
      for (const id of slice) loadedIdsRef.current.add(id.toString());
      setOffers((prev) => [...prev, ...fresh]);
      setCursor(from + size);
      step.success({ note: `${fresh.length} open` });
    } catch (err) {
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [sortedIds, fetchBatch]);

  // T-041 Phase 1+2 — indexer-served path for the OPEN view. When the
  // worker returned a fresh page, populate `offers` directly from the
  // pre-fetched rows and skip the on-chain pagination effect below.
  // Each indexer row is mapped through the same `toOfferData` mapper
  // used for direct on-chain reads so downstream rendering is shape-
  // identical regardless of source. Filters that drop a row from the
  // RPC path (zero-creator from canceled offers; accepted-status
  // mismatch) don't apply here because the indexer already filtered
  // by `status = 'active'` server-side.
  // (`indexerServingOpen` is declared higher up so the reset-on-
  // `sortedIds` effect can guard on it; see that effect's comment.)
  useEffect(() => {
    if (!indexerServingOpen) return;
    const mapped = (indexedOffers ?? []).map((o) => toOfferData(indexedToRawOffer(o)));
    setOffers(mapped);
    setCursor(mapped.length);
    for (const o of mapped) loadedIdsRef.current.add(o.id.toString());
  }, [indexerServingOpen, indexedOffers]);

  // Initial bounded fetch + refetch when the open set changes. Skipped
  // when the indexer path above is serving — but still runs for the
  // CLOSED view and for the OPEN view in fallback mode.
  useEffect(() => {
    if (indexerServingOpen) return;
    if (indexLoading) return;
    if (sortedIds.length === 0) {
      setOffers([]);
      return;
    }
    loadWindow(0, WINDOW_SIZE);
  }, [indexerServingOpen, indexLoading, sortedIds, loadWindow]);


  // Fetch the rolling list of recent accepted offers in NEWEST-FIRST order
  // so `anchorRateBps` can pick the freshest one matching the current
  // filter. Single multicall (already wired on this page) keeps the cost
  // at one RPC round-trip regardless of list size.
  useEffect(() => {
    if (recentAcceptedOfferIds.length === 0) { setRecentMatchedRates([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const target = (activeReadChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
        const calls = encodeBatchCalls(
          target,
          DIAMOND_ABI,
          'getOffer',
          recentAcceptedOfferIds.map((id) => [id] as const),
        );
        let decoded: Array<RawOffer | null>;
        try {
          decoded = await batchCalls<RawOffer>(publicClient, DIAMOND_ABI, 'getOffer', calls);
          if (decoded.every((d) => d === null)) throw new Error('multicall empty');
        } catch {
          // Per-call fallback on multicall failure — same pattern as fetchBatch.
          decoded = [];
          for (const id of recentAcceptedOfferIds) {
            try { decoded.push((await diamondRead.getOffer(id)) as RawOffer); }
            catch { decoded.push(null); }
          }
        }
        if (cancelled) return;
        setRecentMatchedRates(
          decoded
            .filter((raw): raw is RawOffer => raw !== null)
            .map((raw) => ({
              rate: raw.interestRateBps,
              lendingAsset: raw.lendingAsset,
              collateralAsset: raw.collateralAsset,
              durationDays: raw.durationDays,
              principalLiquidity: Number(raw.principalLiquidity),
            })),
        );
      } catch {
        if (!cancelled) setRecentMatchedRates([]);
      }
    })();
    return () => { cancelled = true; };
  }, [diamondRead, publicClient, activeReadChain.diamondAddress, recentAcceptedOfferIds]);

  // Illiquid legs require mutual consent — the review modal exposes the
  // consent checkbox so the acceptor explicitly opts into "full collateral
  // transfer on default" before we submit acceptorIlliquidConsent=true.
  const isIlliquidOffer = (o: OfferData) =>
    o.principalLiquidity === 1 || o.collateralLiquidity === 1;

  /// Approve the diamond to pull `needed` of `token` from the
  /// connected wallet, but only if the existing allowance is
  /// insufficient. Returns immediately when the user already has
  /// enough (covers the common Permit2-fell-through-to-classic case
  /// where the Permit2 spender pre-approval is intact).
  const ensureAllowance = async (token: Address, needed: bigint) => {
    if (!address || needed === 0n) return;
    const diamondAddr = (activeReadChain.diamondAddress ??
      DEFAULT_CHAIN.diamondAddress) as Address;
    if (!publicClient) return;
    const currentRaw = await publicClient.readContract({
      address: token,
      abi: [
        {
          name: 'allowance',
          type: 'function',
          stateMutability: 'view',
          inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
          ],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'allowance',
      args: [address as Address, diamondAddr],
    });
    const current = currentRaw as bigint;
    if (current >= needed) return;
    if (!walletClient) {
      throw new Error('Wallet client unavailable — cannot send approve tx.');
    }
    const erc20 = buildErc20Proxy(token, publicClient as never, walletClient as never);
    const tx = await erc20.approve(diamondAddr, needed);
    await tx.wait();
  };

  const submitAccept = async (offerId: bigint, acceptorConsent: boolean) => {
    if (!address) {
      emit({ area: 'offer-accept', flow: 'acceptOffer', step: 'precheck', status: 'failure', errorType: 'validation', errorMessage: 'Wallet not connected', offerId });
      return;
    }
    setAcceptingId(offerId);
    setError(null);
    setTxHash(null);
    const step = beginStep({ area: 'offer-accept', flow: 'acceptOffer', step: 'submit-tx', wallet: address, chainId, offerId });

    // Phase 8b.1 — attempt the Permit2 path for borrower-side ERC-20
    // accepts of lender offers. Saves the user the separate `approve`
    // tx when they already have Permit2 pre-approved (common on
    // wallets that use aggregators / have touched Uniswap v4). Any
    // failure — wallet refuses EIP-712, no Permit2 allowance, user
    // cancels signature, unexpected revert — silently falls through
    // to the classic `acceptOffer` path below, which handles the
    // approve+accept sequence itself. The user sees one extra
    // wallet popup in the fallback case; acceptable.
    const offer = offers.find((o) => o.id === offerId);
    const permit2Eligible =
      !!offer &&
      offer.offerType === 0 && // Lender offer (acceptor = borrower)
      offer.assetType === 0 && // ERC-20 principal → ERC-20 collateral pull
      !!permit2CanSign;
    if (permit2Eligible) {
      try {
        const diamondAddr = (activeReadChain.diamondAddress ??
          DEFAULT_CHAIN.diamondAddress) as Address;
        const { permit, signature } = await permit2Sign({
          token: offer.collateralAsset as Address,
          amount: offer.collateralAmount,
          spender: diamondAddr,
        });
        const tx = await (
          diamond as unknown as {
            acceptOfferWithPermit: (
              id: bigint,
              consent: boolean,
              permit: unknown,
              signature: Hex,
            ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
          }
        ).acceptOfferWithPermit(offerId, acceptorConsent, permit, signature);
        setTxHash(tx.hash);
        await tx.wait();
        setOffers((prev) => prev.filter((o) => o.id !== offerId));
        step.success({ note: `tx ${tx.hash} via Permit2` });
        setAcceptingId(null);
        return;
      } catch (permitErr) {
        console.debug('[OfferBook] Permit2 accept failed, falling back to classic:', permitErr);
        // fall through to classic path
      }
    }

    try {
      // Classic path needs an explicit ERC-20 approval to the diamond
      // before `acceptOffer` can pull the acceptor-side asset. Without
      // this gate, MetaMask's eth_estimateGas hits an
      // `ERC20InsufficientAllowance` revert; MetaMask falls back to
      // a default ceiling (often 30M) which exceeds Base Sepolia's
      // per-tx gas cap → confusing "exceeds max transaction gas
      // limit" error surfaces instead of the real allowance issue.
      //
      // Per `feedback_token_approvals.md`: approve the EXACT amount
      // needed for this action, never MaxUint256.
      //
      // For lender offers (offerType==0) the acceptor (borrower)
      // pulls collateralAmount of collateralAsset. For borrower
      // offers (offerType==1) the acceptor (lender) pulls `amount`
      // of lendingAsset (range-amount upper-bound `amountMax` isn't
      // surfaced on the local OfferData yet — Range Orders Phase 1
      // borrower-side range support is a follow-up; the lower-bound
      // approve covers single-amount offers which is the common case
      // hitting this error in production today). NFT collateral
      // offers (assetType != 0) use a different approval surface
      // (`setApprovalForAll`) handled by the NFT-aware path; we only
      // gate ERC-20 transfers here.
      if (offer && offer.assetType === 0) {
        const isLenderOffer = offer.offerType === 0;
        const tokenToApprove = (
          isLenderOffer ? offer.collateralAsset : offer.lendingAsset
        ) as Address;
        const amountToApprove = isLenderOffer
          ? offer.collateralAmount
          : offer.amount;
        await ensureAllowance(tokenToApprove, amountToApprove);
      }

      const tx = await diamond.acceptOffer(offerId, acceptorConsent);
      setTxHash(tx.hash);
      await tx.wait();
      // Drop the accepted row locally; the log index will catch up on reload.
      setOffers((prev) => prev.filter((o) => o.id !== offerId));
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      // If the on-chain state says the offer is gone (canceled or never
      // existed at this id), evict it from the local list so the user
      // can't keep clicking the same dead row. The log-index cache may
      // still surface it briefly until the OfferCanceled event lands;
      // this catches the racy gap.
      const sel = extractRevertSelector(err);
      if (sel === '0x2ee39802' /* InvalidOffer() */) {
        setOffers((prev) => prev.filter((o) => o.id !== offerId));
        setPendingOffer(null);
      }
      setError(decodeContractError(err, 'Transaction failed'));
      step.failure(err);
    } finally {
      setAcceptingId(null);
    }
  };

  // Every accept goes through the review modal so the risk disclosures
  // (black-swan fallback for liquid legs, full-collateral transfer for
  // illiquid legs) are surfaced before the tx is sent.
  const handleAcceptOffer = (offerId: bigint) => {
    const offer = offers.find((o) => o.id === offerId);
    if (!offer) return;
    setRiskAndTermsConsent(false);
    setDiscountPreview(null);
    setPendingOffer(offer);
  };

  // Phase 6: per-keeper per-offer enable toggles moved off the offer-card
  // row. The creator-only "Manage keepers" deep-link below sends users to
  // the KeeperSettings page where per-keeper per-offer enable
  // (setOfferKeeperEnabled) is done centrally. Keeps the offer-list row
  // compact and avoids duplicating the picker UI here.

  // Load VPFI-discount preview when the modal opens against a Lender offer
  // (acceptor becomes the borrower — they control the platform consent flag
  // and must hold the required VPFI in their escrow). Silent on any error so
  // the modal still renders with the default fee row.
  useEffect(() => {
    if (!pendingOffer || !address) return;
    if (pendingOffer.offerType !== 0) return; // only when acceptor is borrower
    if (pendingOffer.assetType !== 0) return; // ERC20 only
    if (pendingOffer.principalLiquidity !== 0) return; // liquid only
    let cancelled = false;
    (async () => {
      const d = diamondRead as unknown as {
        getVPFIDiscountConsent: (user: string) => Promise<boolean>;
        quoteVPFIDiscountFor: (
          id: bigint,
          borrower: string,
        ) => Promise<[boolean, bigint, bigint, bigint]>;
        getUserEscrow: { staticCall: (user: string) => Promise<string> };
        getVPFIToken: () => Promise<string>;
        getVPFIBalanceOf: (a: string) => Promise<bigint>;
      };
      try {
        const [consentEnabled, quote, escrow, token] = await Promise.all([
          d.getVPFIDiscountConsent(address),
          d.quoteVPFIDiscountFor(pendingOffer.id, address),
          d.getUserEscrow.staticCall(address),
          d.getVPFIToken(),
        ]);
        const [eligible, vpfiRequired, escrowFromQuote, tierBig] = quote;
        const tier = Number(tierBig);
        let escrowVpfi = escrowFromQuote;
        if (
          escrow &&
          escrow !== ZERO_ADDR &&
          token &&
          token !== ZERO_ADDR
        ) {
          try {
            escrowVpfi = await d.getVPFIBalanceOf(escrow);
          } catch {
            // fall back to quote-side balance on read failure
          }
        }
        const willFire =
          consentEnabled && eligible && escrowVpfi >= vpfiRequired && vpfiRequired > 0n;
        if (!cancelled) {
          setDiscountPreview({
            consentEnabled,
            eligible,
            vpfiRequired,
            escrowVpfi,
            willFire,
            tier,
          });
        }
      } catch {
        if (!cancelled) setDiscountPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingOffer, address, diamondRead]);

  const confirmAccept = () => {
    if (!pendingOffer) return;
    if (!riskAndTermsConsent) return;
    const id = pendingOffer.id;
    setPendingOffer(null);
    setRiskAndTermsConsent(false);
    setDiscountPreview(null);
    // acceptOffer(id, acceptorRiskAndTermsConsent) — fallback consent is
    // mandatory on every offer (liquid or illiquid). When the caller has
    // platform VPFI-discount consent enabled AND holds sufficient VPFI in
    // escrow (see DiscountPreview), the contract swaps the 0.1%
    // lending-asset fee for a tiered VPFI deduction (0.09% / 0.085% /
    // 0.08% / 0.076% by tier) — no extra arg.
    void submitAccept(id, true);
  };

  const cancelAccept = () => {
    setPendingOffer(null);
    setRiskAndTermsConsent(false);
    setDiscountPreview(null);
  };

  // Market filter predicate — applied to both the live offers and the
  // last-accepted anchor lookup.
  const matchesFilter = useCallback((o: { lendingAsset: string; collateralAsset: string; durationDays: bigint; principalLiquidity: number }) =>
    matchesFilterPure(o, {
      lendingAsset: lendingAssetFilter,
      collateralAsset: collateralAssetFilter,
      duration: durationFilter,
      liquidity: liquidityFilter,
    }),
  [lendingAssetFilter, collateralAssetFilter, durationFilter, liquidityFilter]);

  // Defensive dedup-by-id pass. The `offers` state can transiently
  // hold duplicates during the indexer-serving ↔ legacy-log-scan race
  // (the indexer-serving effect calls `setOffers(mapped)` which
  // replaces, while the RPC `loadWindow` effect calls
  // `setOffers((prev) => [...prev, ...fresh])` which appends; if
  // `indexerServingOpen` flips between those two writes, both can
  // land before React reconciles, leaving the same offerId in the
  // array twice). The race resolves itself on the next refresh, but
  // the visible flash is jarring. Deduping here keeps the rendered
  // list unique regardless of state-mutation order.
  const dedupedOffers = useMemo(() => {
    const seen = new Set<string>();
    const out: OfferData[] = [];
    for (const o of offers) {
      const key = o.id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    }
    return out;
  }, [offers]);

  // Market-criteria filter (asset / collateral / duration / liquidity).
  // Note: the user's own offers are NOT hidden — the prior "Hide my
  // offers" toggle was removed; "My Offers" (wallet menu) is where you
  // see your own listings.
  const filtered = useMemo(
    () => dedupedOffers.filter((o) => matchesFilter(o)),
    [dedupedOffers, matchesFilter],
  );

  // Market-scoped anchor: walk the rolling recent-accepted list (newest
  // first) and pick the freshest entry that passes the current filter.
  // This survives narrowing on any one filter axis (liquidity, lending
  // asset, collateral, duration range) as long as a recent match still
  // exists somewhere in the trailing window — no more vanishing on a
  // "Liquid only" flip when the global last-accept happened to be illiquid.
  const anchorRateBps = useMemo<bigint | null>(() => {
    const hit = recentMatchedRates.find(matchesFilter);
    return hit ? hit.rate : null;
  }, [recentMatchedRates, matchesFilter]);

  // Side-of-anchor ranking (pure helpers in `lib/offerBookRanking`).
  const rankLenderSide = useCallback(
    (list: OfferData[]) => rankLenderSidePure(list, anchorRateBps),
    [anchorRateBps],
  );
  const rankBorrowerSide = useCallback(
    (list: OfferData[]) => rankBorrowerSidePure(list, anchorRateBps),
    [anchorRateBps],
  );
  // Selection-step ranker. The per-side cap below uses this list (closest
  // to anchor first) so the cap retains the most economically relevant
  // rows. The within-card display order is then re-applied by
  // `rankLenderSide` / `rankBorrowerSide` after the slice — closest entries
  // get through the gate, then they're laid out top-to-bottom by rate
  // direction (DESC for lender, ASC for borrower) so the depth-chart
  // anchor-in-the-middle visualisation is preserved.
  const rankByDistance = useCallback(
    (list: OfferData[]) => rankByDistanceToAnchorPure(list, anchorRateBps),
    [anchorRateBps],
  );

  // Full filtered list per side. Source the per-side cap slices from and
  // the pagination total counts. Open view ranks by closest-to-anchor
  // (most economically relevant first); Closed view ranks by recency
  // (most recently filled / canceled first) since the market anchor has
  // no meaning for historical fills.
  const lenderAll = useMemo(() => {
    const lenders = filtered.filter((o: OfferData) => o.offerType === 0);
    return statusView === 'closed' ? rankByRecencyPure(lenders) : rankByDistance(lenders);
  }, [filtered, rankByDistance, statusView]);
  const borrowerAll = useMemo(() => {
    const borrowers = filtered.filter((o: OfferData) => o.offerType === 1);
    return statusView === 'closed' ? rankByRecencyPure(borrowers) : rankByDistance(borrowers);
  }, [filtered, rankByDistance, statusView]);

  // Single-side tabs get true pagination (page 1..N of perSide rows each);
  // the 'both' tab keeps the existing top-N-of-each-side layout so the
  // two columns stay aligned without a separate paginator per column.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab, lendingAssetFilter, collateralAssetFilter, durationFilter, liquidityFilter, perSide, statusView]);
  const activeSideList = tab === 'lender' ? lenderAll : tab === 'borrower' ? borrowerAll : null;
  const totalPages = activeSideList ? Math.max(1, Math.ceil(activeSideList.length / perSide)) : 1;
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * perSide;
  // Two-step pipeline per side:
  //   1. slice from the side list (Open: closest-to-anchor first; Closed:
  //      most recently filled first) so the per-side cap keeps the most
  //      relevant rows.
  //   2. Open view applies the rate-direction display sort (lender DESC /
  //      borrower ASC) so the depth-chart anchor-in-the-middle layout
  //      holds within each card. Closed view keeps the recency order
  //      throughout — there's no market anchor for historical fills, so
  //      the rate-direction sort would just shuffle them away from the
  //      "newest first" expectation.
  const lenderOffers = useMemo(() => {
    const slice = tab === 'lender'
      ? lenderAll.slice(pageStart, pageStart + perSide)
      : lenderAll.slice(0, perSide);
    return statusView === 'closed' ? slice : rankLenderSide(slice);
  }, [lenderAll, tab, pageStart, perSide, rankLenderSide, statusView]);
  const borrowerOffers = useMemo(() => {
    const slice = tab === 'borrower'
      ? borrowerAll.slice(pageStart, pageStart + perSide)
      : borrowerAll.slice(0, perSide);
    return statusView === 'closed' ? slice : rankBorrowerSide(slice);
  }, [borrowerAll, tab, pageStart, perSide, rankBorrowerSide, statusView]);

  // The connected wallet's own active offers used to render here as a
  // separate card above the filters, but as of the Dashboard "your
  // stuff" consolidation the `<OfferTable>` for the user's own offers
  // is rendered on the Dashboard page via `useMyActiveOffers`. The
  // OfferBook page now stays focused on the market view — anyone
  // browsing here can still see their own listings inline within the
  // Lender / Borrower side cards (the table renders a "Your Offer"
  // badge in the action column, same as before).

  const totalLender = lenderAll.length;
  const totalBorrower = borrowerAll.length;

  const showLender = tab !== 'borrower';
  const showBorrower = tab !== 'lender';

  const hasMore = cursor < sortedIds.length;
  // "Scanned X of Y" total — cheap counts only (no per-offer on-chain
  // validation pass): when the worker serves the OPEN view, the count
  // of the indexer's page; otherwise the length of the active-offer-id
  // list (the on-chain `getActiveOffersPaginated` set, or the
  // log-scanned set). Closed view = the log-scanned closed-id list
  // length. These can be a touch optimistic (an id may have flipped
  // status since the scan), but the `(N hidden)` suffix below explains
  // any gap between this and what actually renders.
  const validatedTotal =
    statusView === 'open'
      ? indexerServingOpen
        ? indexedOffers?.length ?? sortedIds.length
        : legacyOpenIds.length
      : closedOfferIds.length;
  // `shown` is the count AFTER the full render pipeline: dedup +
  // matchesFilter (asset / collateral / duration / liquidity). Status
  // bar used to read pre-dedup `offers.length`, which made the X of Y
  // look aligned even when the filter pipeline was hiding rows — the
  // user saw "Scanned 3 of 3 open" while only 2 rows rendered (one
  // filtered out). Pinning to `filtered` keeps the X tied to "what's
  // visible right now"; the gap is explicitly named via the `hidden`
  // suffix below so users can attribute the missing rows to their
  // active filters instead of suspecting a bug.
  const shown = filtered.length;
  // Capped at zero so the brief render where `validatedTotal` resolves
  // before `filtered` does (the validation pass hits before the first
  // batch decode) doesn't flash a negative count.
  const hiddenByFilters = Math.max(0, validatedTotal - shown);

  const anchorLabel = useMemo(() => {
    if (anchorRateBps === null) return 'No prior matched rate yet';
    return 'Last matched in this market';
  }, [anchorRateBps]);

  // Phase 4 polish — every page inside `<AppLayout>` now requires a
  // connected wallet. OfferBook used to render the full table read-only
  // pre-connect (since offer state is public on-chain), but the
  // post-batch UX direction is "all in-app pages are wallet-gated; the
  // public Analytics page is the read-only surface". This avoids two
  // sources of truth for chain selection (read chain vs wallet chain)
  // inside /* and matches the rest of the in-app empty-state
  // pattern (Dashboard, ClaimCenter, etc.).
  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>{t('offerBookPage.connectTitle')}</h3>
        <p>{t('offerBookPage.connectBody')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{t('appNav.offerBook')}</h1>
          <p className="page-subtitle">
            {statusView === 'open' ? (
              <>
                {t('offerBookPage.subtitleOpenPrefix')}
                {anchorRateBps !== null && (
                  <>
                    {t('offerBookPage.subtitleOpenAnchorPrefix')}
                    <strong>{bpsToPercent(anchorRateBps)}</strong>
                  </>
                )}
                {t('offerBookPage.subtitleOpenSuffix')}
              </>
            ) : (
              <>{t('offerBookPage.subtitleClosed')}</>
            )}
          </p>
        </div>
        <Link to="/create-offer" className="btn btn-primary btn-sm">
          <PlusCircle size={16} /> {t('appNav.createOffer')}
        </Link>
      </div>

      {/* No row counts in the tab labels — the "Closed" bucket count
          needs an on-chain validation pass over every offer (doesn't
          scale on mainnet), and even the "Open" count is only ever an
          approximation. The "Scanned X of Y" line below carries the
          (cheap) totals. */}
      <div className="tabs" style={{ marginTop: 12 }}>
        {(['open', 'closed'] as StatusView[]).map((v) => (
          <button
            key={v}
            className={`tab ${statusView === v ? 'active' : ''}`}
            onClick={() => setStatusView(v)}
          >
            {v === 'open' ? t('offerBook.tabOpen') : t('offerBook.tabClosed')}
          </button>
        ))}
      </div>

      {error && (
        <ErrorAlert message={error} />
      )}

      {txHash && (
        <div className="alert alert-success">
          {t('offerBook.txSubmitted')}{' '}
          <a href={`${activeReadChain.blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
            {txHash.slice(0, 16)}...
          </a>
        </div>
      )}

      {/* Connected wallet's own offers card moved to the Dashboard
          page (Your Active Offers) so all "your stuff" sits in one
          place. The user's own listings are still visible inline in
          the Lender / Borrower side cards below — the table renders
          a "Your Offer" badge in the action column for them. */}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">
          {t('offerBookPage.filtersHeader')}
          <CardInfo id="offer-book.filters" />
        </div>
        <div className="offer-book-filter-grid">
          <div className="offer-book-filter-cell">
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={lendingAssetFilter}
              onChange={setLendingAssetFilter}
              label={t('common.lendingAsset')}
              placeholder={t('offerBookPage.addressPlaceholder')}
            />
          </div>
          <div className="offer-book-filter-cell">
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={collateralAssetFilter}
              onChange={setCollateralAssetFilter}
              label={t('common.collateralAsset')}
              placeholder={t('offerBookPage.addressPlaceholder')}
            />
          </div>
          <div className="offer-book-filter-cell">
            <span className="form-label">{t('offerBookPage.durationLabel')}</span>
            {/* Single-select bucket picker over OFFER_DURATION_BUCKETS_DAYS
                — same set the CreateOffer duration picker uses. `''` =
                "Any duration" (no filter); otherwise an exact match on
                the chosen bucket (see `matchesFilter` in
                offerBookRanking.ts). */}
            <Picker
              items={[
                { value: '', label: t('offerBookPage.durationAny') },
                ...OFFER_DURATION_BUCKETS_DAYS.map((d) => ({
                  value: String(d),
                  label: t('createOffer.durationBucket', { count: d }),
                })),
              ]}
              value={durationFilter}
              onSelect={setDurationFilter}
              ariaLabel={t('offerBookPage.durationFilterAria')}
              minWidth={150}
            />
          </div>
          <div className="offer-book-filter-cell">
            {/* Real "Liquidity" label-row above the pill — mirrors the
                "Lending asset" / "Collateral asset" / duration cells
                so the row reads as a uniform label-on-top grid. The
                `triggerPrefix` was dropped from the Picker because
                the label here already carries that context; the pill
                now shows just the bare value (Any / Liquid only /
                Illiquid only). */}
            <span className="form-label">{t('offerBookPage.liquidity')}</span>
            <Picker<LiquidityFilter>
              icon={<Droplet size={14} />}
              ariaLabel={t('offerBookPage.filterByLiquidity')}
              value={liquidityFilter}
              onSelect={setLiquidityFilter}
              minWidth={170}
              items={[
                { value: 'any', label: t('offerBookPage.liquidityAny') },
                { value: 'liquid', label: t('offerBookPage.liquidityLiquid') },
                { value: 'illiquid', label: t('offerBookPage.liquidityIlliquid') },
              ]}
            />
          </div>
        </div>
      </div>

      {/* "Lend / Borrow at market rate" shortcut — shown for the pair the
          filters select (both asset filters set + valid). Pure prefilled
          deep-link to Create Offer; never disabled. Sits between the
          filter card and the Market anchor / side tabs. */}
      {/^0x[0-9a-fA-F]{40}$/.test(lendingAssetFilter) &&
        /^0x[0-9a-fA-F]{40}$/.test(collateralAssetFilter) && (
          <MarketRateWidget
            lendingAsset={lendingAssetFilter}
            collateralAsset={collateralAssetFilter}
            durationDays={durationFilter}
            anchorRateBps={anchorRateBps}
          />
        )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
        <div className="tabs">
          {(['both', 'lender', 'borrower'] as TabFilter[]).map((tabKey) => (
            <button key={tabKey} className={`tab ${tab === tabKey ? 'active' : ''}`} onClick={() => setTab(tabKey)}>
              {tabKey === 'both'
                ? t('offerBookPage.bothSides')
                : tabKey === 'lender'
                  ? t('offerBookPage.lenderOffers')
                  : t('offerBookPage.borrowerOffers')}
            </button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Picker<number>
            icon={<ListOrdered size={14} />}
            ariaLabel={t('offerBookPage.perSide')}
            triggerPrefix={t('offerBookPage.perSide')}
            value={perSide}
            onSelect={setPerSide}
            minWidth={140}
            menuAlign="right"
            items={[10, 20, 50, 100]
              .filter((n) => n <= maxPerSide)
              .map((n) => ({
                value: n,
                label: String(n),
                pill: n === DEFAULT_PER_SIDE ? 'default' : undefined,
              }))}
          />
        </div>
      </div>

      {indexLoading || (loading && offers.length === 0) ? (
        <div className="card"><div className="empty-state"><p>{t('offerBook.loadingOffers')}</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><BookOpen size={28} /></div>
            <h3>{statusView === 'open' ? t('offerBook.noOpenOffers') : t('offerBook.noClosedOffers')}</h3>
            <p>
              {statusView === 'open'
                ? offers.length === 0
                  ? t('offerBookPage.noOpenBody')
                  : t('offerBookPage.noOpenFiltered')
                : offers.length === 0
                  ? t('offerBook.noClosedBody')
                  : t('offerBookPage.noClosedFiltered')}
            </p>
            {statusView === 'open' && (
              <Link to="/create-offer" className="btn btn-primary btn-sm">{t('appNav.createOffer')}</Link>
            )}
          </div>
        </div>
      ) : (
        <>
          {showLender && (
            <>
              <OfferTable
                title={statusView === 'open' ? t('offerBookPage.lenderOffers') : t('offerBookPage.filledLenderOffers')}
                subtitle={
                  tab === 'lender' && totalLender > perSide
                    ? t('offerBookPage.pageOfTotal', { current: safePage, pages: totalPages, shown: lenderOffers.length, total: totalLender })
                    : t('offerBookPage.showing', { shown: lenderOffers.length, total: totalLender })
                }
                offers={lenderOffers}
                anchorRateBps={anchorRateBps}
                address={address}
                acceptingId={acceptingId}
                onAccept={handleAcceptOffer}
                statusView={statusView}
                chainId={activeReadChain.chainId}
                offerToLoan={offerToLoan}
                cardHelpId="offer-book.lender-offers"
              />
              {tab === 'lender' && totalLender > perSide && (
                <Pagination page={safePage} totalPages={totalPages} onPage={setPage} />
              )}
            </>
          )}
          {statusView === 'open' && (
            <div className="card" style={{ marginTop: 12, borderLeft: '4px solid var(--brand)', background: 'var(--bg-muted, rgba(0,0,0,0.03))' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>{t('offerBookPage.marketAnchor')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                    {anchorRateBps !== null ? bpsToPercent(anchorRateBps) : '—'}
                  </div>
                  {anchorLabel && <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{anchorLabel}</div>}
                </div>
                <div style={{ fontSize: '0.8rem', opacity: 0.7, textAlign: 'right' }}>
                  {t('offerBookPage.lendersAboveBorrowersBelow')}
                </div>
              </div>
            </div>
          )}
          {showBorrower && (
            <>
              <OfferTable
                title={statusView === 'open' ? t('offerBookPage.borrowerOffers') : t('offerBookPage.filledBorrowerOffers')}
                subtitle={
                  tab === 'borrower' && totalBorrower > perSide
                    ? t('offerBookPage.pageOfTotal', { current: safePage, pages: totalPages, shown: borrowerOffers.length, total: totalBorrower })
                    : t('offerBookPage.showing', { shown: borrowerOffers.length, total: totalBorrower })
                }
                offers={borrowerOffers}
                anchorRateBps={anchorRateBps}
                address={address}
                acceptingId={acceptingId}
                onAccept={handleAcceptOffer}
                statusView={statusView}
                chainId={activeReadChain.chainId}
                offerToLoan={offerToLoan}
                cardHelpId="offer-book.borrower-offers"
              />
              {tab === 'borrower' && totalBorrower > perSide && (
                <Pagination page={safePage} totalPages={totalPages} onPage={setPage} />
              )}
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          {statusView === 'open'
            ? t('offerBookPage.scannedOffersOpen', { scanned: shown, total: validatedTotal })
            : t('offerBookPage.scannedOffersFilled', { scanned: shown, total: validatedTotal })}
          {hiddenByFilters > 0 && (
            <>
              {' '}
              <span style={{ opacity: 0.85 }}>
                {t('offerBookPage.hiddenByFilters', {
                  defaultValue: '({{count}} hidden by filters)',
                  count: hiddenByFilters,
                })}
              </span>
            </>
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DataSyncStatus />
          <RescanButton
            cooldown={rescanCooldown}
            disabled={loading}
            tooltip={t('offerBookPage.rescanTooltip')}
            onRescan={() => {
              // Two-target refresh:
              //   1. `refetchIndexedOffers()` re-pulls the worker's
              //      indexer page + RPC catch-up over the indexer-tail
              //      → safe-head gap (the same flow the auto-tail uses,
              //      just triggered explicitly) — drives the list when
              //      the indexer is reachable.
              //   2. `reloadIndex()` re-runs the legacy local log scan
              //      (per-row events stream + the RPC-pagination
              //      fallback when the indexer is unreachable).
              // Cumulative state (`offers`/`cursor`/`loadedIdsRef`) is
              // wiped only when the indexer ISN'T serving — the
              // indexer-served path owns its own `offers` array via the
              // `indexerServingOpen` effect, so a manual wipe there
              // would blank the page until the next refetch lands.
              if (!indexerServingOpen) {
                loadedIdsRef.current = new Set();
                setOffers([]);
                setCursor(0);
              }
              void refetchIndexedOffers();
              void reloadIndex();
            }}
          />
          {hasMore && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={loading}
              onClick={() => loadWindow(cursor, WINDOW_SIZE)}
            >
              {loading ? 'Loading...' : `Load ${Math.min(WINDOW_SIZE, sortedIds.length - cursor)} more`}
            </button>
          )}
        </div>
      </div>

      {pendingOffer && (
        <AcceptReviewModal
          offer={pendingOffer}
          illiquid={isIlliquidOffer(pendingOffer)}
          consent={riskAndTermsConsent}
          onConsentChange={setRiskAndTermsConsent}
          submitting={acceptingId === pendingOffer.id}
          onConfirm={confirmAccept}
          onCancel={cancelAccept}
          discountPreview={discountPreview}
          protocolConfig={protocolConfig}
          permit2Eligible={
            // Mirror the predicate used inside `submitAccept` so the
            // preview encodes the same path the wallet will sign.
            // Borrower-side ERC-20 accept of a lender ERC-20 offer
            // takes the Permit2 path when the wallet supports it.
            pendingOffer.offerType === 0 &&
            pendingOffer.assetType === 0 &&
            !!permit2CanSign
          }
        />
      )}
    </div>
  );
}

interface AcceptReviewModalProps {
  offer: OfferData;
  illiquid: boolean;
  consent: boolean;
  onConsentChange: (v: boolean) => void;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  discountPreview: DiscountPreview | null;
  protocolConfig: ProtocolConfig | null;
  /** True when {submitAccept} will pick the Permit2 single-sig path
   *  for this offer. Drives the inline transaction-scan preview so
   *  the scanned calldata matches what the user is about to sign. */
  permit2Eligible: boolean;
}

function AcceptReviewModal({ offer, illiquid, consent, onConsentChange, submitting, onConfirm, onCancel, discountPreview, protocolConfig, permit2Eligible }: AcceptReviewModalProps) {
  const { t } = useTranslation();
  const { address: viewerAddress } = useWallet();
  const principalIlliquid = offer.principalLiquidity === 1;
  const collateralIlliquid = offer.collateralLiquidity === 1;
  // Live `checkLiquidity` on the ERC-20 collateral (only when this is
  // an ERC-20-collateralised loan, `offer.assetType === 0` — for NFT
  // collateral "illiquid" is expected and the mutual-consent
  // disclosures already cover it). Drives the cross-chain "thin here"
  // warning below.
  const collateralChainLiquidity = useAssetLiquidity(
    offer.assetType === 0 ? offer.collateralAsset : null,
  );
  const illiquidLegs = principalIlliquid && collateralIlliquid
    ? 'Both the principal and collateral legs'
    : principalIlliquid
      ? 'The principal leg'
      : collateralIlliquid
        ? 'The collateral leg'
        : '';
  const isERC20 = offer.assetType === 0;
  // APR interest in whole units. For NFT rental offers the `amount` is a
  // daily fee rather than a principal, so we skip the projection there.
  const projectedInterest = isERC20
    ? (offer.amount * offer.interestRateBps * offer.durationDays) / (10000n * 365n)
    : null;
  const projectedRepayment = projectedInterest !== null ? offer.amount + projectedInterest : null;
  const sideLabel = offer.offerType === 0 ? 'Lender posts principal' : 'Borrower posts collateral';

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ maxWidth: 560, width: '100%', margin: 0, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Review offer #{offer.id.toString()}
        </div>

        {/* Phase 4.3 — sanctions pre-flight. Both sides of the match
            are checked: if the acceptor OR the offer creator is
            flagged, the on-chain `acceptOffer` would revert, so we
            warn up-front rather than letting the user sign and eat
            gas on a doomed tx. Renders nothing when no oracle is
            configured or when both sides are clean. */}
        {viewerAddress && (
          <SanctionsBanner
            address={viewerAddress as Address}
            label={t('banners.sanctionsLabelWallet')}
          />
        )}
        <SanctionsBanner
          address={offer.creator as Address}
          label={t('banners.sanctionsLabelOfferCreator')}
        />

        {/* Cross-chain "thin here" warning — the ERC-20 collateral on
            this offer is `Illiquid` on the current chain (may be much
            deeper on another). Accepting it here means a liquidation
            swap may be costly or fail. */}
        {collateralChainLiquidity === 'illiquid' && (
          <div className="alert alert-warning" role="alert">
            <AlertTriangle size={18} />
            <span>{t('liquidityNotice.thinCollateralOnChain')}</span>
          </div>
        )}

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', rowGap: 6, columnGap: 16, fontSize: '0.9rem', margin: '8px 0 12px 0' }}>
          <dt style={{ opacity: 0.7 }}>Side</dt>
          <dd style={{ margin: 0 }}>{OFFER_TYPE_LABELS[offer.offerType]} · {sideLabel}</dd>

          <dt style={{ opacity: 0.7 }}>Counterparty</dt>
          <dd style={{ margin: 0 }}><AddressDisplay address={offer.creator} withTooltip copyable /></dd>

          <dt style={{ opacity: 0.7 }}>{isERC20 ? 'Principal' : 'Daily rental fee'}</dt>
          <dd style={{ margin: 0 }}>
            <span className="mono"><TokenAmount amount={offer.amount} address={offer.lendingAsset} compact /></span>{' '}
            <AssetSymbol address={offer.lendingAsset} />
            {' '}<span style={{ opacity: 0.6 }}>({ASSET_TYPE_LABELS[offer.assetType]})</span>
          </dd>

          <dt style={{ opacity: 0.7 }}>Rate (APR)</dt>
          <dd style={{ margin: 0 }}>{bpsToPercent(offer.interestRateBps)}</dd>

          <dt style={{ opacity: 0.7 }}>Duration</dt>
          <dd style={{ margin: 0 }}>{offer.durationDays.toString()} days</dd>

          <dt style={{ opacity: 0.7 }}>Collateral</dt>
          <dd style={{ margin: 0 }}>
            <span className="mono"><TokenAmount amount={offer.collateralAmount} address={offer.collateralAsset} compact /></span>{' '}
            <AssetSymbol address={offer.collateralAsset} />
          </dd>

          {projectedRepayment !== null && (
            <>
              <dt style={{ opacity: 0.7 }}>Projected repayment</dt>
              <dd style={{ margin: 0 }}>
                <span className="mono"><TokenAmount amount={projectedRepayment} address={offer.lendingAsset} compact /></span>{' '}
                <AssetSymbol address={offer.lendingAsset} />
                <span style={{ opacity: 0.6 }}> (principal + {bpsToPercent(offer.interestRateBps)} APR × {offer.durationDays.toString()}d)</span>
              </dd>
            </>
          )}

          {isERC20 && (() => {
            const discountFires = !!discountPreview?.willFire;
            const baseFeeBps = BigInt(protocolConfig?.loanInitiationFeeBps ?? 10);
            const normalFee = (offer.amount * baseFeeBps) / 10000n;
            const netToBorrower = discountFires ? offer.amount : offer.amount - normalFee;
            const tier = discountPreview?.tier ?? 0;
            const baseFeePctLabel = formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10);
            return (
              <>
                <dt style={{ opacity: 0.7 }}>Loan Initiation Fee</dt>
                <dd style={{ margin: 0 }}>
                  {discountFires ? (
                    <>
                      <span className="mono">{Number(discountPreview!.vpfiRequired) / 1e18}</span>{' '}
                      VPFI{' '}
                      <span style={{ opacity: 0.6 }}>
                        (full {baseFeePctLabel} equivalent paid from your escrow into protocol custody — tier-{tier} rebate up to {tierDiscountPct(tier, protocolConfig)} earned time-weighted, claimable at proper loan close)
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mono"><TokenAmount amount={normalFee} address={offer.lendingAsset} compact /></span>{' '}
                      <AssetSymbol address={offer.lendingAsset} />
                      <span style={{ opacity: 0.6 }}> ({baseFeePctLabel} — routed to treasury at loan start)</span>
                    </>
                  )}
                </dd>

                <dt style={{ opacity: 0.7 }}>Net proceeds to borrower</dt>
                <dd style={{ margin: 0 }}>
                  <span className="mono"><TokenAmount amount={netToBorrower} address={offer.lendingAsset} compact /></span>{' '}
                  <AssetSymbol address={offer.lendingAsset} />
                  <span style={{ opacity: 0.6 }}>
                    {discountFires
                      ? ' (full principal — fee paid separately in VPFI; borrower still owes full principal back)'
                      : ' (borrower still owes full principal back)'}
                  </span>
                </dd>
              </>
            );
          })()}

          <dt style={{ opacity: 0.7 }}>Liquidity</dt>
          <dd style={{ margin: 0 }}>
            <span className={`status-badge ${offer.principalLiquidity === 0 ? 'active' : 'defaulted'}`} style={{ marginRight: 6 }}>
              Principal: {LIQUIDITY_LABELS[offer.principalLiquidity]}
            </span>
            <span className={`status-badge ${offer.collateralLiquidity === 0 ? 'active' : 'defaulted'}`}>
              Collateral: {LIQUIDITY_LABELS[offer.collateralLiquidity]}
            </span>
          </dd>

          {/* Borrower-initiated partial repay is gated by the offer
              creator at create-time. Show the resulting loan's posture
              so the acceptor sees what they're agreeing to — accepting
              the offer is itself the consent. */}
          <dt style={{ opacity: 0.7 }}>{t('acceptReview.partialRepayLabel')}</dt>
          <dd style={{ margin: 0 }}>
            {offer.allowsPartialRepay
              ? t('acceptReview.partialRepayAllowed')
              : t('acceptReview.partialRepayNotAllowed')}
          </dd>
        </dl>

        {/* VPFI discount preview — only when the acceptor becomes the borrower
            (Lender offer) on an ERC-20 + liquid loan, since the platform
            consent + VPFI-in-escrow check that governs the tiered discount
            (0.09% / 0.085% / 0.08% / 0.076% by escrow tier) is driven by the
            borrower side. */}
        {isERC20 && offer.offerType === 0 && offer.principalLiquidity === 0 && discountPreview && (
          <div
            className="alert"
            style={{
              marginTop: 0,
              borderColor: discountPreview.willFire ? 'var(--accent-green, #10b981)' : undefined,
              background: discountPreview.willFire ? 'rgba(16, 185, 129, 0.08)' : undefined,
            }}
          >
            <ShieldCheck
              size={18}
              style={{ color: discountPreview.willFire ? 'var(--accent-green, #10b981)' : undefined }}
            />
            <div style={{ fontSize: '0.88rem' }}>
              {discountPreview.willFire ? (
                <>
                  <strong>Tier-{discountPreview.tier} VPFI path will apply (up to {tierDiscountPct(discountPreview.tier, protocolConfig)} rebate at proper close).</strong>{' '}
                  Platform consent is enabled and your vault holds the required{' '}
                  <span className="mono">{Number(discountPreview.vpfiRequired) / 1e18}</span> VPFI.
                  You pay the full {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI; the discount is earned time-weighted
                  over the loan's lifetime and paid back as a VPFI rebate when you repay, preclose, or refinance properly. Default or
                  liquidation forfeits the rebate.
                </>
              ) : !discountPreview.consentEnabled ? (
                <>
                  <strong>Borrower VPFI rebate available.</strong>{' '}
                  Enable platform consent on your{' '}
                  <Link to="" style={{ textDecoration: 'underline' }}>
                    Dashboard
                  </Link>{' '}
                  to pay the {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI and earn a tier-based rebate (up to {protocolConfig ? protocolConfig.tierDiscountBps.map((b) => formatBpsPct(b)).join(' / ') : '10% / 15% / 20% / 24%'} by vault balance held across the loan). Without consent this acceptance uses
                  the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} lending-asset fee path (no rebate).
                </>
              ) : !discountPreview.eligible ? (
                <>
                  <strong>Borrower VPFI rebate unavailable.</strong>{' '}
                  No oracle route, rate unset, or vault balance below the tier-1 threshold — this acceptance uses the
                  normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} lending-asset fee path (no rebate).
                </>
              ) : (
                <>
                  <strong>Tier-{discountPreview.tier} VPFI path pending vault balance.</strong>{' '}
                  Consent is enabled but your vault holds{' '}
                  <span className="mono">{Number(discountPreview.escrowVpfi) / 1e18}</span> VPFI —
                  paying the {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI (up to {tierDiscountPct(discountPreview.tier, protocolConfig)} rebate at proper close) needs{' '}
                  <span className="mono">{Number(discountPreview.vpfiRequired) / 1e18}</span> VPFI.
                  Top up on{' '}
                  <a
                    href="/buy-vpfi"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: 'underline' }}
                  >
                    Buy VPFI
                  </a>{' '}
                  or proceed with the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} path (no rebate).
                </>
              )}
            </div>
          </div>
        )}

        {illiquid && (
          <div className="alert alert-warning" style={{ marginTop: 0 }}>
            <AlertTriangle size={18} />
            <div style={{ fontSize: '0.88rem' }}>
              <strong>Illiquid leg on this offer.</strong>{' '}
              {illiquidLegs} of this offer {principalIlliquid && collateralIlliquid ? 'are' : 'is'}{' '}
              illiquid — on default the entire collateral is transferred
              directly to the lender (no LTV-based liquidation, no DEX swap).
              The fallback terms below cover this case.
            </div>
          </div>
        )}

        <RiskDisclosures />

        {/* Phase 7b.1 — UX guard: 0x preflight against the
            collateral → principal pair at the actual offer size.
            Banner only renders for ERC-20 collateral with non-zero
            collateralAmount; NFT-rental and ERC-1155 collateral
            offers skip the check (no DEX swap path applies). */}
        <AcceptLiquidityPreflight offer={offer} />

        {/* ET-001 — pre-sign eth_call preflight. Encodes the SAME
            calldata the confirmation flow will submit
            (`acceptOfferWithPermit` on the Permit2 path, classic
            `acceptOffer` otherwise) so the preflight reflects the
            on-chain action 1:1. */}
        <AcceptSimulationPreview
          offer={offer}
          permit2Eligible={permit2Eligible}
        />

        {/* T-034 — when the offer carries a Periodic Interest Payment
            cadence other than None, surface a callout above the consent
            checkbox so the acceptor reads the cadence + missed-payment
            consequence before signing. The single consent below covers
            BOTH the abnormal-market fallback AND this cadence — kept as
            one checkbox per the project's "single mandatory risk
            consent" policy. */}
        {offer.periodicInterestCadence !== 0 && (
          <div
            style={{
              border: '1px solid rgba(245,158,11,0.45)',
              background: 'rgba(245,158,11,0.08)',
              padding: '10px 14px',
              borderRadius: 4,
              fontSize: '0.9rem',
              marginTop: 12,
              lineHeight: 1.5,
            }}
            role="note"
          >
            <strong>
              {t(
                `periodicInterest.cadence.${
                  ['none', 'monthly', 'quarterly', 'semiAnnual', 'annual'][
                    offer.periodicInterestCadence
                  ]
                }`,
              )}{' '}
              {t('acceptOffer.periodicInterest.calloutPrefix')}
            </strong>
            <div style={{ marginTop: 4 }}>
              {t('acceptOffer.periodicInterest.calloutBody')}
            </div>
          </div>
        )}

        <label className="checkbox-row" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => onConsentChange(e.target.checked)}
          />
          <span><RiskConsentLabel /></span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onConfirm}
            disabled={submitting || !consent}
            data-tooltip={
              !submitting && !consent
                ? t('riskDisclosures.consentRequiredHint')
                : undefined
            }
          >
            {submitting ? t('offerTable.acceptingDots') : t('offerTable.confirmAndAccept')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}

/**
 * Phase 8b.2 — encodes the pending accept call and hands it to the
 * shared SimulationPreview component.
 *
 * #00013 fix: when the parent has decided to take the Permit2
 * single-sig path (mirroring the predicate inside `submitAccept`),
 * encode `acceptOfferWithPermit(offerId, true, permit, signature)`
 * with placeholder permit fields so the preflight sees the SAME
 * Diamond entry point the wallet will sign. The signature isn't
 * cryptographically valid yet — so the `eth_call` reverts at the
 * Permit2 signature check; `useTxSimulation` recognises a
 * signature-revert as a preview artefact and downgrades it to
 * "preview unavailable" rather than a false "would revert" alarm.
 *
 * On the classic path we keep encoding `acceptOffer(offerId, true)`.
 */
function AcceptSimulationPreview({
  offer,
  permit2Eligible,
}: {
  offer: OfferData;
  permit2Eligible: boolean;
}) {
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  const data: Hex = permit2Eligible
    ? (encodeFunctionData({
        abi: DIAMOND_ABI,
        functionName: 'acceptOfferWithPermit',
        args: [
          offer.id,
          true,
          // Placeholder permit — token / amount match the real pull;
          // nonce + deadline use safe defaults. Permit2 will reject
          // this signature on-chain (zeroed); the eth_call preflight
          // reverts at the Permit2 check, which useTxSimulation maps
          // to "preview unavailable" (not a false revert alarm).
          {
            permitted: {
              token: offer.collateralAsset as Address,
              amount: offer.collateralAmount,
            },
            nonce: 0n,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
          },
          // 65-byte zero signature (r=0, s=0, v=0). Same shape Permit2
          // expects; the scanner sees a Permit2 pull was requested.
          ('0x' + '00'.repeat(65)) as Hex,
        ],
      }) as Hex)
    : (encodeFunctionData({
        abi: DIAMOND_ABI,
        functionName: 'acceptOffer',
        args: [offer.id, true],
      }) as Hex);

  return (
    <SimulationPreview
      tx={{
        to: diamondAddress,
        data,
        value: 0n,
        // Permit2 path encodes a placeholder (zeroed) signature, so
        // the eth_call reverts at the signature check — an artefact,
        // not a real failure. Tell the preflight to treat that one
        // revert class as "unavailable" rather than "would revert".
        allowSignatureRevert: permit2Eligible,
      }}
    />
  );
}

const PREFLIGHT_WORKER_ORIGIN_OB =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_AGENT_ORIGIN ?? null;

/**
 * Phase 7b.1 — wraps {useLiquidityPreflight} for OfferBook's accept
 * review modal. Gated on `offer.assetType === 0` (ERC-20 principal,
 * which in practice always pairs with ERC-20 collateral on the
 * happy path) and a non-zero `collateralAmount`. Skipped offers
 * silently render nothing — the rest of the modal layout is
 * unaffected.
 *
 * `collateralAssetType` isn't surfaced on the local `OfferData`
 * shape; ERC-20-loans-with-NFT-collateral offers therefore get a
 * false-negative banner here (the hook will see the NFT contract
 * address, 0x will return no route, banner says "no route"). Banner
 * is informational, never blocks submit, so the false negative is
 * acceptable for v1. Future: thread `collateralAssetType` through
 * the offer cache and pass it explicitly.
 */
function AcceptLiquidityPreflight({ offer }: { offer: OfferData }) {
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const enabled = offer.assetType === 0 && offer.collateralAmount > 0n;
  const result = useLiquidityPreflight({
    collateralAsset: enabled ? (offer.collateralAsset as Address) : null,
    principalAsset: enabled ? (offer.lendingAsset as Address) : null,
    collateralAmount: enabled ? offer.collateralAmount : 0n,
    collateralAssetType: enabled ? 'erc20' : undefined,
    chainId: chain.chainId,
    diamond: diamondAddress,
    workerOrigin: PREFLIGHT_WORKER_ORIGIN_OB,
  });
  return <LiquidityPreflightBanner result={result} compact />;
}

function Pagination({ page, totalPages, onPage }: PaginationProps) {
  const canPrev = page > 1;
  const canNext = page < totalPages;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 8 }}>
      <button
        className="btn btn-secondary btn-sm"
        disabled={!canPrev}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>
        Page {page} of {totalPages}
      </span>
      <button
        className="btn btn-secondary btn-sm"
        disabled={!canNext}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}

interface OfferTableProps {
  title: string;
  subtitle: string;
  offers: OfferData[];
  anchorRateBps: bigint | null;
  address: string | null;
  acceptingId: bigint | null;
  onAccept: (id: bigint) => void;
  statusView: StatusView;
  /** Chain id this table's offers live on. Threaded into
   *  `<PrincipalCell>` so each row's "open externally" link routes
   *  to the right destination per asset type and chain. */
  chainId: number;
  /** Map of `offerId → loanId` (both decimal strings) derived from the
   *  log-index `OfferAccepted` events. When the Closed view renders a
   *  filled offer, it looks up the resulting loan id here and renders
   *  an inline `Loan #N` link next to the Filled pill. Absent / undefined
   *  → no loan link, just the pill (graceful degradation while the log-
   *  index is still backfilling). */
  offerToLoan?: Map<string, string>;
  /** Optional registry id (`offer-book.lender-offers` etc.) — when
   *  provided, an inline `<CardInfo>` (i) icon renders next to the
   *  title with the matching summary + Learn-more link. */
  cardHelpId?: string;
  /** Optional element rendered on the right side of the card-title
   *  row (e.g. a "+ New Offer" button). Used by the Dashboard's
   *  Your Active Offers placement so the action sits with the card
   *  it conceptually belongs to. */
  headerAction?: ReactNode;
}

export function OfferTable({ title, subtitle, offers, anchorRateBps, address, acceptingId, onAccept, statusView, chainId, offerToLoan, cardHelpId, headerAction }: OfferTableProps) {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {title}
          {cardHelpId && <CardInfo id={cardHelpId} />}
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{subtitle}</span>
          {headerAction}
        </div>
      </div>
      {offers.length === 0 ? (
        <div className="empty-state"><p>{t('offerTable.noOffers')}</p></div>
      ) : (
        <div className="loans-table-wrap">
          <table className="loans-table">
            <thead>
              <tr>
                <th>{t('offerTable.colId')}</th>
                <th>{t('offerTable.colType')}</th>
                {/* Asset + Amount merged into a single Principal column
                    via `<PrincipalCell>` so the row reads consistently
                    with Your Loans (which already uses this layout for
                    its principal column). NFT rows render as
                    `NFT #42` + collection symbol with an inline link to
                    the explorer's NFT-page viewer. */}
                <th>{t('offerTable.colPrincipal')}</th>
                <th>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {t('offerTable.colRate')}
                    <InfoTip ariaLabel={t('offerTable.rateDeltaTipAria')}>
                      {t('offerTable.rateDeltaTipBody')}
                    </InfoTip>
                  </span>
                </th>
                <th>{t('offerTable.colDuration')}</th>
                <th>{t('offerTable.colCollateral')}</th>
                <th>{t('offerTable.colLiquidity')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => {
                const isOwn = address?.toLowerCase() === offer.creator.toLowerCase();
                // Signed delta: positive => offer rate is above the market
                // anchor (more expensive borrow / more lucrative lend);
                // negative => below market. Direction matters for browsing,
                // so the column shows `+0.50%` or `-0.50%` rather than the
                // direction-stripped `±0.50%` we used to render via absDelta.
                const signedDelta = anchorRateBps !== null
                  ? offer.interestRateBps - anchorRateBps
                  : null;
                return (
                  <tr key={offer.id.toString()}>
                    <td>
                      <Link to={`/offers/${offer.id.toString()}`}>
                        #{offer.id.toString()}
                      </Link>
                    </td>
                    <td>
                      <span className={`status-badge ${offer.offerType === 0 ? 'lender' : 'borrower'}`}>
                        {OFFER_TYPE_LABELS[offer.offerType]}
                      </span>
                    </td>
                    <td>
                      <PrincipalCell
                        assetType={offer.assetType}
                        asset={offer.lendingAsset}
                        amount={offer.amount}
                        tokenId={offer.tokenId}
                        chainId={chainId}
                        compact
                      />
                    </td>
                    <td>
                      {bpsToPercent(offer.interestRateBps)}
                      {signedDelta !== null && signedDelta !== 0n && (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            opacity: 0.6,
                            marginLeft: 4,
                            color: signedDelta > 0n ? 'var(--accent-red)' : 'var(--accent-green, #10b981)',
                          }}
                        >
                          ({signedDelta > 0n ? '+' : '−'}{bpsToPercent(signedDelta > 0n ? signedDelta : -signedDelta)})
                        </span>
                      )}
                    </td>
                    <td>{offer.durationDays.toString()} {t('loanDetails.daysSuffix')}</td>
                    <td>
                      {/* Collateral cell — same shape as the
                          principal `<PrincipalCell>` two-row layout
                          (compact amount on top, symbol + external
                          link below) but inlined here because
                          `OfferData` doesn't currently carry the
                          collateral asset type, and `<PrincipalCell>`
                          would mis-render an NFT collateral as
                          ERC-20. The inline `<AssetLink>` gives the
                          external-link icon next to the symbol and
                          the address tooltip, fixing the earlier
                          `<AssetSymbol>`-only render that dropped the
                          link affordance. */}
                      <div>
                        <span className="mono">
                          <TokenAmount
                            amount={offer.collateralAmount}
                            address={offer.collateralAsset}
                            compact
                          />
                        </span>
                        <div className="asset-addr">
                          <AssetLink
                            kind="erc20"
                            chainId={chainId}
                            address={offer.collateralAsset}
                          />
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${offer.principalLiquidity === 0 ? 'active' : 'defaulted'}`}>
                        {LIQUIDITY_LABELS[offer.principalLiquidity]}
                      </span>
                    </td>
                    <td>
                      {statusView === 'closed' ? (
                        // Filled offers show the resulting loan id inline
                        // next to the pill so the user can jump straight
                        // to the loan that this offer became. Loan id
                        // comes from the `OfferAccepted` event in the
                        // log-index; if the index hasn't yet seen the
                        // event the link is omitted gracefully.
                        (() => {
                          const loanIdStr = offerToLoan?.get(offer.id.toString());
                          return (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <span className="status-badge settled">{t('offerTable.filled')}</span>
                              {loanIdStr && (
                                <Link
                                  to={`/loans/${loanIdStr}`}
                                  style={{ fontSize: '0.78rem', color: 'var(--brand)' }}
                                >
                                  {t('offerTable.linkedLoan', { id: loanIdStr })}
                                </Link>
                              )}
                            </div>
                          );
                        })()
                      ) : isOwn ? (
                        // Offer creator sees the Your-Offer badge only.
                        // The per-offer keeper toggles live on the offer
                        // details page (KeeperSettings card) — surfacing
                        // a deep-link from the list row added clutter to
                        // a column that scans far better as a single
                        // vertical baseline of Accept buttons.
                        <span className="status-badge settled">{t('offerTable.yourOffer')}</span>
                      ) : address ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => onAccept(offer.id)}
                          disabled={acceptingId === offer.id}
                        >
                          {acceptingId === offer.id ? t('offerTable.accepting') : t('offerTable.accept')}
                        </button>
                      ) : (
                        <span className="status-badge pending">{t('common.connectWallet')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
