import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { Address, Hex } from 'viem';
import { encodeFunctionData } from 'viem';
import { SimulationPreview } from '../components/app/SimulationPreview';
import { LiquidityPreflightBanner } from '../components/app/LiquidityPreflightBanner';
import { useLiquidityPreflight } from '../hooks/useLiquidityPreflight';
import { usePermit2Signing } from '../hooks/usePermit2Signing';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useDiamondRead, useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { Link } from 'react-router-dom';
import { BookOpen, PlusCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { SanctionsBanner } from '../components/app/SanctionsBanner';
import { RiskDisclosures } from '../components/app/RiskDisclosures';
import { DEFAULT_CHAIN } from '../contracts/config';
import { beginStep, emit } from '../lib/journeyLog';
import { decodeContractError, extractRevertSelector } from '../lib/decodeContractError';
import {
  FALLBACK_CONSENT_CHECKBOX_LABEL,
} from '../lib/fallbackTerms';
import { useLogIndex } from '../hooks/useLogIndex';
import { useProtocolConfig, type ProtocolConfig } from '../hooks/useProtocolConfig';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { AssetPicker } from '../components/app/AssetPicker';
import { TokenAmount } from '../components/app/TokenAmount';
import { ThemedSelect } from '../components/app/ThemedSelect';
import { bpsToPercent } from '../lib/format';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { AddressDisplay } from '../components/app/AddressDisplay';
import {
  absDelta,
  matchesFilter as matchesFilterPure,
  rankLenderSide as rankLenderSidePure,
  rankBorrowerSide as rankBorrowerSidePure,
  type LiquidityFilter as LibLiquidityFilter,
} from '../lib/offerBookRanking';
import './OfferBook.css';

const OFFER_TYPE_LABELS = ['Lender', 'Borrower'] as const;
const LIQUIDITY_LABELS = ['Liquid', 'Illiquid'] as const;
const ASSET_TYPE_LABELS = ['ERC-20', 'ERC-721', 'ERC-1155'] as const;
const WINDOW_SIZE = 200;
/** Upper bound on the per-side row count the user can dial in, scoped to the
 *  active tab. `both` sees two columns so each side caps at 50 rows; on a
 *  single-side tab all vertical space is one list, so the cap rises to 100. */
const MAX_PER_SIDE_BOTH = 50;
const MAX_PER_SIDE_SINGLE = 100;
const MIN_PER_SIDE = 1;
const DEFAULT_PER_SIDE = 20;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

interface OfferData {
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
type StatusView = 'open' | 'closed';

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

/** BPS → "0.1%" / "10%" — min of 3 sig figs to avoid rendering "0.08%" as "0.1%". */
function formatBpsPct(bps: number): string {
  const pct = bps / 100;
  const rounded = Number.isInteger(pct) ? pct.toString() : pct.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${rounded}%`;
}

type RawOffer = {
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
};

function toOfferData(r: RawOffer): OfferData {
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
  };
}

export default function OfferBook() {
  const { address, chainId } = useWallet();
  const diamond = useDiamondContract();
  const diamondRead = useDiamondRead();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
  // The wallet's active chain (or DEFAULT_CHAIN fallback when disconnected).
  // Used to target multicalls and build explorer links at the Diamond the
  // user's reads are actually hitting, instead of hard-coding DEFAULT_CHAIN.
  const activeReadChain = useReadChain();
  const { openOfferIds, closedOfferIds, lastAcceptedOfferId, loading: indexLoading, reload: reloadIndex } = useLogIndex();
  const { config: protocolConfig } = useProtocolConfig();

  const [statusView, setStatusView] = useState<StatusView>('open');

  // Sort ids descending so we fetch the newest offers first. The cursor
  // then walks backward in id space when the user expands the window.
  const sortedIds = useMemo(() => {
    const src = statusView === 'open' ? openOfferIds : closedOfferIds;
    return [...src].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  }, [openOfferIds, closedOfferIds, statusView]);

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
  const [fallbackConsent, setFallbackConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [discountPreview, setDiscountPreview] = useState<DiscountPreview | null>(null);

  // Market filters.
  const [lendingAssetFilter, setLendingAssetFilter] = useState('');
  const [collateralAssetFilter, setCollateralAssetFilter] = useState('');
  const [minDuration, setMinDuration] = useState('');
  const [maxDuration, setMaxDuration] = useState('');
  const [liquidityFilter, setLiquidityFilter] = useState<LiquidityFilter>('any');

  // Anchor for the currently-filtered market. We fetch the last accepted
  // offer once and let it flow through the filter just like any other row —
  // if it doesn't match the filter we fall back to the median of what's
  // loaded under the current filter.
  const [lastAcceptedRate, setLastAcceptedRate] = useState<{ rate: bigint; lendingAsset: string; collateralAsset: string; durationDays: bigint; principalLiquidity: number } | null>(null);

  const publicClient = useDiamondPublicClient();
  const loadedIdsRef = useRef<Set<string>>(new Set());

  // Verified tab counts — the log index lists IDs by event (OfferCreated
  // minus OfferAccepted/Canceled), but RPC lag or missed events can leave
  // canceled/accepted IDs in the wrong bucket. We validate by reading each
  // offer on-chain and filtering the same way fetchBatch does below, so the
  // tab header matches what users actually see after clicking through.
  const [countByStatus, setCountByStatus] = useState<{
    open: number | null;
    closed: number | null;
  }>({ open: null, closed: null });

  // Reset cumulative state whenever the open set changes so we don't carry
  // stale rows across reloads.
  useEffect(() => {
    setOffers([]);
    setCursor(0);
    loadedIdsRef.current = new Set();
  }, [sortedIds]);

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

  // Initial bounded fetch + refetch when the open set changes.
  useEffect(() => {
    if (indexLoading) return;
    if (sortedIds.length === 0) {
      setOffers([]);
      return;
    }
    loadWindow(0, WINDOW_SIZE);
  }, [indexLoading, sortedIds, loadWindow]);

  // Count-only validator: multicall `getOffer` across the given ID set and
  // apply the same filters as `fetchBatch` (skip zero-creator / accepted-
  // status mismatch). Returns the raw ID length on multicall failure so
  // the tab label never goes blank.
  const fetchValidCount = useCallback(
    async (ids: bigint[], status: StatusView): Promise<number> => {
      if (ids.length === 0) return 0;
      const target = (activeReadChain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
      try {
        const calls = encodeBatchCalls(
          target,
          DIAMOND_ABI,
          'getOffer',
          ids.map((id) => [id] as const),
        );
        const decoded = await batchCalls<RawOffer>(publicClient, DIAMOND_ABI, 'getOffer', calls);
        let count = 0;
        for (const raw of decoded) {
          if (!raw) continue;
          if (raw.creator === ZERO_ADDR) continue;
          if (status === 'open' && raw.accepted) continue;
          if (status === 'closed' && !raw.accepted) continue;
          count++;
        }
        return count;
      } catch {
        return ids.length;
      }
    },
    [publicClient, activeReadChain.diamondAddress],
  );

  // Validate both tabs' counts in parallel whenever the log index updates.
  // Runs alongside (not instead of) the active-view load so users see an
  // accurate number on the tab they're NOT viewing as well.
  useEffect(() => {
    if (indexLoading) return;
    let cancelled = false;
    setCountByStatus({ open: null, closed: null });
    (async () => {
      const [openCount, closedCount] = await Promise.all([
        fetchValidCount([...openOfferIds], 'open'),
        fetchValidCount([...closedOfferIds], 'closed'),
      ]);
      if (!cancelled) setCountByStatus({ open: openCount, closed: closedCount });
    })();
    return () => {
      cancelled = true;
    };
  }, [indexLoading, openOfferIds, closedOfferIds, fetchValidCount]);

  // Fetch the last accepted offer once so we know the true market rate.
  useEffect(() => {
    if (lastAcceptedOfferId === null) { setLastAcceptedRate(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const raw = (await diamondRead.getOffer(lastAcceptedOfferId)) as RawOffer;
        if (cancelled) return;
        setLastAcceptedRate({
          rate: raw.interestRateBps,
          lendingAsset: raw.lendingAsset,
          collateralAsset: raw.collateralAsset,
          durationDays: raw.durationDays,
          principalLiquidity: Number(raw.principalLiquidity),
        });
      } catch {
        if (!cancelled) setLastAcceptedRate(null);
      }
    })();
    return () => { cancelled = true; };
  }, [diamondRead, lastAcceptedOfferId]);

  // Illiquid legs require mutual consent — the review modal exposes the
  // consent checkbox so the acceptor explicitly opts into "full collateral
  // transfer on default" before we submit acceptorIlliquidConsent=true.
  const isIlliquidOffer = (o: OfferData) =>
    o.principalLiquidity === 1 || o.collateralLiquidity === 1;

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
    setFallbackConsent(false);
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
    if (!fallbackConsent) return;
    const id = pendingOffer.id;
    setPendingOffer(null);
    setFallbackConsent(false);
    setDiscountPreview(null);
    // acceptOffer(id, acceptorFallbackConsent) — fallback consent is
    // mandatory on every offer (liquid or illiquid). When the caller has
    // platform VPFI-discount consent enabled AND holds sufficient VPFI in
    // escrow (see DiscountPreview), the contract swaps the 0.1%
    // lending-asset fee for a tiered VPFI deduction (0.09% / 0.085% /
    // 0.08% / 0.076% by tier) — no extra arg.
    void submitAccept(id, true);
  };

  const cancelAccept = () => {
    setPendingOffer(null);
    setFallbackConsent(false);
    setDiscountPreview(null);
  };

  // Market filter predicate — applied to both the live offers and the
  // last-accepted anchor lookup.
  const matchesFilter = useCallback((o: { lendingAsset: string; collateralAsset: string; durationDays: bigint; principalLiquidity: number }) =>
    matchesFilterPure(o, {
      lendingAsset: lendingAssetFilter,
      collateralAsset: collateralAssetFilter,
      minDuration,
      maxDuration,
      liquidity: liquidityFilter,
    }),
  [lendingAssetFilter, collateralAssetFilter, minDuration, maxDuration, liquidityFilter]);

  const filtered = useMemo(() => offers.filter(matchesFilter), [offers, matchesFilter]);

  // Market-scoped anchor: only the last-matched rate in the current filter's
  // market qualifies. Per WebsiteReadme §offer-book, when no prior match
  // exists for the active context, the UI must surface an explicit fallback
  // state instead of synthesising one from the loaded window.
  const anchorRateBps = useMemo<bigint | null>(() => {
    if (lastAcceptedRate && matchesFilter(lastAcceptedRate)) return lastAcceptedRate.rate;
    return null;
  }, [lastAcceptedRate, matchesFilter]);

  // Side-of-anchor ranking (pure helpers in `lib/offerBookRanking`).
  const rankLenderSide = useCallback(
    (list: OfferData[]) => rankLenderSidePure(list, anchorRateBps),
    [anchorRateBps],
  );
  const rankBorrowerSide = useCallback(
    (list: OfferData[]) => rankBorrowerSidePure(list, anchorRateBps),
    [anchorRateBps],
  );

  const lenderAll = useMemo(() => rankLenderSide(filtered.filter((o: OfferData) => o.offerType === 0)), [filtered, rankLenderSide]);
  const borrowerAll = useMemo(() => rankBorrowerSide(filtered.filter((o: OfferData) => o.offerType === 1)), [filtered, rankBorrowerSide]);

  // Single-side tabs get true pagination (page 1..N of perSide rows each);
  // the 'both' tab keeps the existing top-N-of-each-side layout so the
  // two columns stay aligned without a separate paginator per column.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab, lendingAssetFilter, collateralAssetFilter, minDuration, maxDuration, liquidityFilter, perSide, statusView]);
  const activeSideList = tab === 'lender' ? lenderAll : tab === 'borrower' ? borrowerAll : null;
  const totalPages = activeSideList ? Math.max(1, Math.ceil(activeSideList.length / perSide)) : 1;
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * perSide;
  const lenderOffers = useMemo(
    () =>
      tab === 'lender'
        ? lenderAll.slice(pageStart, pageStart + perSide)
        : lenderAll.slice(0, perSide),
    [lenderAll, tab, pageStart, perSide],
  );
  const borrowerOffers = useMemo(
    () =>
      tab === 'borrower'
        ? borrowerAll.slice(pageStart, pageStart + perSide)
        : borrowerAll.slice(0, perSide),
    [borrowerAll, tab, pageStart, perSide],
  );

  // The connected wallet's own open offers — derived BEFORE market filters
  // so a user who narrowed the view can still see their own listings. The
  // underlying `offers` array already excludes accepted rows at load time
  // (see fetchBatch's `raw.accepted` skip), so everything here is active.
  const myActiveOffers = useMemo(() => {
    if (!address) return [] as OfferData[];
    const lower = address.toLowerCase();
    return offers.filter((o) => o.creator.toLowerCase() === lower);
  }, [offers, address]);

  const totalLender = lenderAll.length;
  const totalBorrower = borrowerAll.length;

  const showLender = tab !== 'borrower';
  const showBorrower = tab !== 'lender';

  const hasMore = cursor < sortedIds.length;
  // Prefer the validated count (same source the tab headers use) so
  // the bottom status bar reflects reality after stale log-index
  // entries are filtered. Falls back to raw log-index length while
  // the validation pass is still running.
  const validatedTotal =
    statusView === 'open'
      ? (countByStatus.open ?? openOfferIds.length)
      : (countByStatus.closed ?? closedOfferIds.length);
  const scanned = Math.min(offers.length, validatedTotal);

  const anchorLabel = useMemo(() => {
    if (anchorRateBps === null) return 'No prior matched rate yet';
    return 'Last matched in this market';
  }, [anchorRateBps]);

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Offer Book</h1>
          <p className="page-subtitle">
            {statusView === 'open' ? (
              <>
                Ranked outward from the market anchor
                {anchorRateBps !== null && (<> — currently <strong>{bpsToPercent(anchorRateBps)}</strong></>)}.
              </>
            ) : (
              <>
                Historical view of filled offers — accepted liquidity that's
                already been matched to a loan. Use this to see past market rates
                even after the live book clears.
              </>
            )}
          </p>
        </div>
        <Link to="/app/create-offer" className="btn btn-primary btn-sm">
          <PlusCircle size={16} /> Create Offer
        </Link>
      </div>

      <div className="tabs" style={{ marginTop: 12 }}>
        {(['open', 'closed'] as StatusView[]).map((v) => (
          <button
            key={v}
            className={`tab ${statusView === v ? 'active' : ''}`}
            onClick={() => setStatusView(v)}
          >
            {v === 'open'
              ? `Open (${countByStatus.open ?? openOfferIds.length})`
              : `Closed / Filled (${countByStatus.closed ?? closedOfferIds.length})`}
          </button>
        ))}
      </div>

      {error && (
        <ErrorAlert message={error} />
      )}

      {txHash && (
        <div className="alert alert-success">
          Transaction submitted:{' '}
          <a href={`${activeReadChain.blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
            {txHash.slice(0, 16)}...
          </a>
        </div>
      )}

      {/* Connected wallet's own open offers, surfaced above the market
          filters so a creator can always find their listings without
          having to remember what filter combination matches them.
          Rendered only when the user is connected AND has at least one
          open offer; otherwise we skip the section entirely to avoid
          pushing the filters card down with an empty placeholder. */}
      {statusView === 'open' && address && myActiveOffers.length > 0 && (
        <OfferTable
          title="Your Active Offers"
          subtitle={`${myActiveOffers.length} open`}
          offers={myActiveOffers}
          anchorRateBps={anchorRateBps}
          address={address}
          acceptingId={acceptingId}
          onAccept={handleAcceptOffer}
          statusView={statusView}
        />
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">Filters</div>
        <div className="offer-book-filter-grid">
          <div className="offer-book-filter-cell">
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={lendingAssetFilter}
              onChange={setLendingAssetFilter}
              label="Lending asset"
              placeholder="0x... (any)"
            />
          </div>
          <div className="offer-book-filter-cell">
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={collateralAssetFilter}
              onChange={setCollateralAssetFilter}
              label="Collateral asset"
              placeholder="0x... (any)"
            />
          </div>
          <div className="offer-book-filter-cell">
            <label className="form-label" htmlFor="offer-book-min-duration">
              Min duration (days)
            </label>
            <input
              id="offer-book-min-duration"
              type="number"
              min="0"
              value={minDuration}
              onChange={(e) => setMinDuration(e.target.value)}
              className="form-input"
            />
          </div>
          <div className="offer-book-filter-cell">
            <label className="form-label" htmlFor="offer-book-max-duration">
              Max duration (days)
            </label>
            <input
              id="offer-book-max-duration"
              type="number"
              min="0"
              value={maxDuration}
              onChange={(e) => setMaxDuration(e.target.value)}
              className="form-input"
            />
          </div>
          <div className="offer-book-filter-cell">
            <span className="form-label">Liquidity</span>
            <ThemedSelect<LiquidityFilter>
              value={liquidityFilter}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'liquid', label: 'Liquid only' },
                { value: 'illiquid', label: 'Illiquid only' },
              ]}
              onChange={setLiquidityFilter}
              ariaLabel="Filter by liquidity"
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
        <div className="tabs">
          {(['both', 'lender', 'borrower'] as TabFilter[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'both' ? 'Both Sides' : t === 'lender' ? 'Lender Offers' : 'Borrower Offers'}
            </button>
          ))}
        </div>
        <label style={{ fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Per side ({MIN_PER_SIDE}-{maxPerSide})
          <input
            type="number"
            min={MIN_PER_SIDE}
            max={maxPerSide}
            value={perSide}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isNaN(n)) return;
              setPerSide(Math.max(MIN_PER_SIDE, Math.min(maxPerSide, n)));
            }}
            className="form-input"
            style={{ width: 80, padding: '6px 10px' }}
          />
        </label>
      </div>

      {indexLoading || (loading && offers.length === 0) ? (
        <div className="card"><div className="empty-state"><p>Loading offers from chain...</p></div></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon"><BookOpen size={28} /></div>
            <h3>{statusView === 'open' ? 'No Open Offers' : 'No Filled Offers Yet'}</h3>
            <p>
              {statusView === 'open'
                ? offers.length === 0
                  ? 'There are no open offers on the book. Be the first to create one!'
                  : 'No offers match your filters. Try widening them or loading more.'
                : offers.length === 0
                  ? "No offers have been filled on this chain yet — once someone accepts an offer, it'll appear here."
                  : 'No filled offers match your filters. Try widening them or loading more.'}
            </p>
            {statusView === 'open' && (
              <Link to="/app/create-offer" className="btn btn-primary btn-sm">Create Offer</Link>
            )}
          </div>
        </div>
      ) : (
        <>
          {showLender && (
            <>
              <OfferTable
                title={statusView === 'open' ? 'Lender Offers' : 'Filled Lender Offers'}
                subtitle={
                  tab === 'lender' && totalLender > perSide
                    ? `Page ${safePage} of ${totalPages} · ${lenderOffers.length} of ${totalLender}`
                    : `Showing ${lenderOffers.length} of ${totalLender}`
                }
                offers={lenderOffers}
                anchorRateBps={anchorRateBps}
                address={address}
                acceptingId={acceptingId}
                onAccept={handleAcceptOffer}
                statusView={statusView}
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
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>Market Anchor</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                    {anchorRateBps !== null ? bpsToPercent(anchorRateBps) : '—'}
                  </div>
                  {anchorLabel && <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{anchorLabel}</div>}
                </div>
                <div style={{ fontSize: '0.8rem', opacity: 0.7, textAlign: 'right' }}>
                  Lenders ↑ above · Borrowers ↓ below
                </div>
              </div>
            </div>
          )}
          {showBorrower && (
            <>
              <OfferTable
                title={statusView === 'open' ? 'Borrower Offers' : 'Filled Borrower Offers'}
                subtitle={
                  tab === 'borrower' && totalBorrower > perSide
                    ? `Page ${safePage} of ${totalPages} · ${borrowerOffers.length} of ${totalBorrower}`
                    : `Showing ${borrowerOffers.length} of ${totalBorrower}`
                }
                offers={borrowerOffers}
                anchorRateBps={anchorRateBps}
                address={address}
                acceptingId={acceptingId}
                onAccept={handleAcceptOffer}
                statusView={statusView}
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
          Scanned {scanned} of {validatedTotal} {statusView === 'open' ? 'open' : 'filled'} offers
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            disabled={loading || indexLoading}
            onClick={() => {
              // Busts the event-indexed id cache and re-scans from
              // chain. Fixes the case where OfferCreated /
              // OfferCanceled / OfferAccepted events were missed and
              // the id set diverges from on-chain state.
              loadedIdsRef.current = new Set();
              setOffers([]);
              setCursor(0);
              void reloadIndex();
            }}
            title="Rescan the chain for offers if the list looks stale."
          >
            {indexLoading ? 'Rescanning…' : 'Rescan chain'}
          </button>
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
          consent={fallbackConsent}
          onConsentChange={setFallbackConsent}
          submitting={acceptingId === pendingOffer.id}
          onConfirm={confirmAccept}
          onCancel={cancelAccept}
          discountPreview={discountPreview}
          protocolConfig={protocolConfig}
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
}

function AcceptReviewModal({ offer, illiquid, consent, onConsentChange, submitting, onConfirm, onCancel, discountPreview, protocolConfig }: AcceptReviewModalProps) {
  const { address: viewerAddress } = useWallet();
  const principalIlliquid = offer.principalLiquidity === 1;
  const collateralIlliquid = offer.collateralLiquidity === 1;
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
            label="Your wallet"
          />
        )}
        <SanctionsBanner
          address={offer.creator as Address}
          label="Offer creator"
        />

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', rowGap: 6, columnGap: 16, fontSize: '0.9rem', margin: '8px 0 12px 0' }}>
          <dt style={{ opacity: 0.7 }}>Side</dt>
          <dd style={{ margin: 0 }}>{OFFER_TYPE_LABELS[offer.offerType]} · {sideLabel}</dd>

          <dt style={{ opacity: 0.7 }}>Counterparty</dt>
          <dd style={{ margin: 0 }}><AddressDisplay address={offer.creator} withTooltip /></dd>

          <dt style={{ opacity: 0.7 }}>{isERC20 ? 'Principal' : 'Daily rental fee'}</dt>
          <dd style={{ margin: 0 }}>
            <span className="mono"><TokenAmount amount={offer.amount} address={offer.lendingAsset} /></span>{' '}
            <AssetSymbol address={offer.lendingAsset} />
            {' '}<span style={{ opacity: 0.6 }}>({ASSET_TYPE_LABELS[offer.assetType]})</span>
          </dd>

          <dt style={{ opacity: 0.7 }}>Rate (APR)</dt>
          <dd style={{ margin: 0 }}>{bpsToPercent(offer.interestRateBps)}</dd>

          <dt style={{ opacity: 0.7 }}>Duration</dt>
          <dd style={{ margin: 0 }}>{offer.durationDays.toString()} days</dd>

          <dt style={{ opacity: 0.7 }}>Collateral</dt>
          <dd style={{ margin: 0 }}>
            <span className="mono"><TokenAmount amount={offer.collateralAmount} address={offer.collateralAsset} /></span>{' '}
            <AssetSymbol address={offer.collateralAsset} />
          </dd>

          {projectedRepayment !== null && (
            <>
              <dt style={{ opacity: 0.7 }}>Projected repayment</dt>
              <dd style={{ margin: 0 }}>
                <span className="mono"><TokenAmount amount={projectedRepayment} address={offer.lendingAsset} /></span>{' '}
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
                      <span className="mono"><TokenAmount amount={normalFee} address={offer.lendingAsset} /></span>{' '}
                      <AssetSymbol address={offer.lendingAsset} />
                      <span style={{ opacity: 0.6 }}> ({baseFeePctLabel} — routed to treasury at loan start)</span>
                    </>
                  )}
                </dd>

                <dt style={{ opacity: 0.7 }}>Net proceeds to borrower</dt>
                <dd style={{ margin: 0 }}>
                  <span className="mono"><TokenAmount amount={netToBorrower} address={offer.lendingAsset} /></span>{' '}
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
                  Platform consent is enabled and your escrow holds the required{' '}
                  <span className="mono">{Number(discountPreview.vpfiRequired) / 1e18}</span> VPFI.
                  You pay the full {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI; the discount is earned time-weighted
                  over the loan's lifetime and paid back as a VPFI rebate when you repay, preclose, or refinance properly. Default or
                  liquidation forfeits the rebate.
                </>
              ) : !discountPreview.consentEnabled ? (
                <>
                  <strong>Borrower VPFI rebate available.</strong>{' '}
                  Enable platform consent on your{' '}
                  <Link to="/app" style={{ textDecoration: 'underline' }}>
                    Dashboard
                  </Link>{' '}
                  to pay the {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI and earn a tier-based rebate (up to {protocolConfig ? protocolConfig.tierDiscountBps.map((b) => formatBpsPct(b)).join(' / ') : '10% / 15% / 20% / 24%'} by escrow balance held across the loan). Without consent this acceptance uses
                  the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} lending-asset fee path (no rebate).
                </>
              ) : !discountPreview.eligible ? (
                <>
                  <strong>Borrower VPFI rebate unavailable.</strong>{' '}
                  No oracle route, rate unset, or escrow balance below the tier-1 threshold — this acceptance uses the
                  normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} lending-asset fee path (no rebate).
                </>
              ) : (
                <>
                  <strong>Tier-{discountPreview.tier} VPFI path pending escrow balance.</strong>{' '}
                  Consent is enabled but your escrow holds{' '}
                  <span className="mono">{Number(discountPreview.escrowVpfi) / 1e18}</span> VPFI —
                  paying the {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} LIF up front in VPFI (up to {tierDiscountPct(discountPreview.tier, protocolConfig)} rebate at proper close) needs{' '}
                  <span className="mono">{Number(discountPreview.vpfiRequired) / 1e18}</span> VPFI.
                  Top up on{' '}
                  <a
                    href="/app/buy-vpfi"
                    target="_blank"
                    rel="noreferrer"
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

        {/* Phase 8b.2 — Blockaid preview. Uses the simulation of a
            classic acceptOffer(offerId, true) call since that's what
            the confirmation flow submits today. When the Permit2 UX
            wiring lands, the preview input can swap to
            acceptOfferWithPermit's calldata for the Permit2 path. */}
        <AcceptSimulationPreview offerId={offer.id} />

        <label className="checkbox-row" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => onConsentChange(e.target.checked)}
          />
          <span>{FALLBACK_CONSENT_CHECKBOX_LABEL}</span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onConfirm}
            disabled={submitting || !consent}
          >
            {submitting ? 'Accepting...' : 'Confirm & Accept'}
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
 * Phase 8b.2 — small wrapper that encodes the pending acceptOffer call
 * and hands it to the shared SimulationPreview component. Isolated
 * here so the Blockaid preview can be swapped in/out without touching
 * the review-modal body.
 */
function AcceptSimulationPreview({ offerId }: { offerId: bigint }) {
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const data = encodeFunctionData({
    abi: DIAMOND_ABI,
    functionName: 'acceptOffer',
    args: [offerId, true],
  }) as Hex;
  return (
    <SimulationPreview
      tx={{ to: diamondAddress, data, value: 0n }}
    />
  );
}

const PREFLIGHT_WORKER_ORIGIN_OB =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_HF_WATCHER_ORIGIN ?? null;

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
}

function OfferTable({ title, subtitle, offers, anchorRateBps, address, acceptingId, onAccept, statusView }: OfferTableProps) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>{title}</span>
        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{subtitle}</span>
      </div>
      {offers.length === 0 ? (
        <div className="empty-state"><p>No open offers on this side.</p></div>
      ) : (
        <div className="loans-table-wrap">
          <table className="loans-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Rate</th>
                <th>Duration</th>
                <th>Collateral</th>
                <th>Liquidity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => {
                const isOwn = address?.toLowerCase() === offer.creator.toLowerCase();
                const delta = anchorRateBps !== null ? absDelta(offer.interestRateBps, anchorRateBps) : null;
                return (
                  <tr key={offer.id.toString()}>
                    <td>#{offer.id.toString()}</td>
                    <td>
                      <span className={`status-badge ${offer.offerType === 0 ? 'lender' : 'borrower'}`}>
                        {OFFER_TYPE_LABELS[offer.offerType]}
                      </span>
                    </td>
                    <td>
                      <div>
                        <span className="mono">{ASSET_TYPE_LABELS[offer.assetType]}</span>
                        <div className="asset-addr"><AssetSymbol address={offer.lendingAsset} /></div>
                      </div>
                    </td>
                    <td className="mono"><TokenAmount amount={offer.amount} address={offer.lendingAsset} /></td>
                    <td>
                      {bpsToPercent(offer.interestRateBps)}
                      {delta !== null && delta !== 0n && (
                        <span style={{ fontSize: '0.75rem', opacity: 0.6, marginLeft: 4 }}>
                          (±{bpsToPercent(delta)})
                        </span>
                      )}
                    </td>
                    <td>{offer.durationDays.toString()} days</td>
                    <td>
                      <div>
                        <span className="mono"><TokenAmount amount={offer.collateralAmount} address={offer.collateralAsset} /></span>
                        <div className="asset-addr"><AssetSymbol address={offer.collateralAsset} /></div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${offer.principalLiquidity === 0 ? 'active' : 'defaulted'}`}>
                        {LIQUIDITY_LABELS[offer.principalLiquidity]}
                      </span>
                    </td>
                    <td>
                      {statusView === 'closed' ? (
                        <span className="status-badge settled">Filled</span>
                      ) : isOwn ? (
                        // Phase 6: Offer creator sees Your-Offer badge + a
                        // "Manage keepers" deep-link. Per-keeper enables for
                        // this specific offer happen on the Keeper Settings
                        // page pre-acceptance (setOfferKeeperEnabled), since
                        // that's where the user picks which of their
                        // whitelisted keepers to enable for which offer.
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                          <span className="status-badge settled">Your Offer</span>
                          <Link
                            to="/app/keepers"
                            data-tooltip="Enable specific keepers to drive this offer via the Keeper Settings page."
                            style={{ fontSize: '0.72rem', padding: '3px 8px', color: 'var(--brand)' }}
                          >
                            Manage keepers →
                          </Link>
                        </div>
                      ) : address ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => onAccept(offer.id)}
                          disabled={acceptingId === offer.id}
                        >
                          {acceptingId === offer.id ? 'Accepting...' : 'Accept'}
                        </button>
                      ) : (
                        <span className="status-badge pending">Connect Wallet</span>
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
