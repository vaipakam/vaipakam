import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useDiamondRead, useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { Link } from 'react-router-dom';
import { BookOpen, PlusCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { SanctionsBanner } from '../components/app/SanctionsBanner';
import { DEFAULT_CHAIN } from '../contracts/config';
import { beginStep, emit } from '../lib/journeyLog';
import { decodeContractError } from '../lib/decodeContractError';
import {
  FALLBACK_CONSENT_TITLE,
  FALLBACK_CONSENT_BODY,
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
import { shortenAddr } from '../lib/format';
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
  /** Mirrors the on-chain `offer.keeperAccessEnabled` flag. The offer
   *  creator can flip this any time via `setOfferKeeperAccess` while
   *  the offer is still open. Accepting an offer latches the flag into
   *  the resulting loan's per-side keeper state. */
  keeperAccessEnabled: boolean;
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
/**
 * Effective initiation-fee percentage after applying the tier discount.
 * Uses the live protocol config so admin overrides to either the base
 * initiation fee or the per-tier discount BPS flow through automatically.
 * `tier === 0` means "no tier applies" — full base fee.
 */
function tierFeeLabel(tier: number, config: ProtocolConfig | null): string {
  const baseBps = config?.loanInitiationFeeBps ?? 10;
  if (tier < 1 || tier > 4) return `${formatBpsPct(baseBps)}`;
  const discountBps = config?.tierDiscountBps[tier - 1] ?? 0;
  const effectiveBps = (baseBps * (BPS_DENOM - discountBps)) / BPS_DENOM;
  return formatBpsPct(effectiveBps);
}

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

const BPS_DENOM = 10_000;

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
  keeperAccessEnabled: boolean;
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
    keeperAccessEnabled: Boolean(r.keeperAccessEnabled),
  };
}

export default function OfferBook() {
  const { address, chainId } = useWallet();
  const diamond = useDiamondContract();
  const diamondRead = useDiamondRead();
  // The wallet's active chain (or DEFAULT_CHAIN fallback when disconnected).
  // Used to target multicalls and build explorer links at the Diamond the
  // user's reads are actually hitting, instead of hard-coding DEFAULT_CHAIN.
  const activeReadChain = useReadChain();
  const { openOfferIds, closedOfferIds, lastAcceptedOfferId, loading: indexLoading } = useLogIndex();
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
  const [togglingKeeperId, setTogglingKeeperId] = useState<bigint | null>(null);
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
    for (const raw of decoded) {
      if (!raw) continue;
      // Canceled offers are impossible to display — `cancelOffer` deletes the
      // storage slot, so `creator` comes back as the zero address. Skip in
      // both views; the Closed view intentionally surfaces only filled
      // (accepted) offers, which retain their full struct.
      if (raw.creator === ZERO_ADDR) continue;
      if (statusView === 'open' && raw.accepted) continue;
      if (statusView === 'closed' && !raw.accepted) continue;
      out.push(toOfferData(raw));
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
    try {
      const tx = await diamond.acceptOffer(offerId, acceptorConsent);
      setTxHash(tx.hash);
      await tx.wait();
      // Drop the accepted row locally; the log index will catch up on reload.
      setOffers((prev) => prev.filter((o) => o.id !== offerId));
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
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

  // Per-offer keeper toggle — callable by the offer creator at any point
  // before the offer is accepted. Mirrors `setLoanKeeperAccess` on the
  // post-acceptance side. The on-chain fn reverts if the caller isn't
  // the creator or if the offer has already been accepted, so UI-side
  // we just check the button visibility via `isOwn`.
  const handleToggleOfferKeeper = async (
    offerId: bigint,
    next: boolean,
  ) => {
    if (!diamond || togglingKeeperId !== null) return;
    const step = beginStep({
      area: 'keeper',
      flow: 'setOfferKeeperAccess',
      step: 'submit-tx',
      wallet: address ?? undefined,
      chainId: chainId ?? undefined,
      offerId: offerId.toString(),
    });
    setTogglingKeeperId(offerId);
    setError(null);
    try {
      const tx = await (
        diamond as unknown as {
          setOfferKeeperAccess: (
            id: bigint,
            enabled: boolean,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setOfferKeeperAccess(offerId, next);
      await tx.wait();
      step.success({ note: `enabled=${next}` });
      // Optimistic update in place — the row's keeper-badge flips right
      // away without waiting for a full offer-list re-scan.
      setOffers((prev) =>
        prev.map((o) =>
          o.id === offerId ? { ...o, keeperAccessEnabled: next } : o,
        ),
      );
    } catch (err) {
      setError(decodeContractError(err, 'Failed to toggle offer keeper flag'));
      step.failure(err);
    } finally {
      setTogglingKeeperId(null);
    }
  };

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
  const lenderOffers = useMemo(() => lenderAll.slice(0, perSide), [lenderAll, perSide]);
  const borrowerOffers = useMemo(() => borrowerAll.slice(0, perSide), [borrowerAll, perSide]);

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
  const scanned = Math.min(cursor, sortedIds.length);

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
              ? `Open (${openOfferIds.length})`
              : `Closed / Filled (${closedOfferIds.length})`}
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
          onToggleKeeper={handleToggleOfferKeeper}
          togglingKeeperId={togglingKeeperId}
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
            <OfferTable
              title={statusView === 'open' ? 'Lender Offers' : 'Filled Lender Offers'}
              subtitle={`Showing ${lenderOffers.length} of ${totalLender}`}
              offers={lenderOffers}
              anchorRateBps={anchorRateBps}
              address={address}
              acceptingId={acceptingId}
              onAccept={handleAcceptOffer}
          onToggleKeeper={handleToggleOfferKeeper}
          togglingKeeperId={togglingKeeperId}
              statusView={statusView}
            />
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
            <OfferTable
              title={statusView === 'open' ? 'Borrower Offers' : 'Filled Borrower Offers'}
              subtitle={`Showing ${borrowerOffers.length} of ${totalBorrower}`}
              offers={borrowerOffers}
              anchorRateBps={anchorRateBps}
              address={address}
              acceptingId={acceptingId}
              onAccept={handleAcceptOffer}
          onToggleKeeper={handleToggleOfferKeeper}
          togglingKeeperId={togglingKeeperId}
              statusView={statusView}
            />
          )}
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          Scanned {scanned} of {sortedIds.length} {statusView === 'open' ? 'open' : 'filled'} offers
        </span>
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
          <dd style={{ margin: 0 }} className="mono">{shortenAddr(offer.creator)}</dd>

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
                        ({tierFeeLabel(tier, protocolConfig)} via tier-{tier} VPFI discount ({tierDiscountPct(tier, protocolConfig)} off) — deducted from your escrow, routed to treasury)
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
                  <strong>Tier-{discountPreview.tier} VPFI discount will apply ({tierDiscountPct(discountPreview.tier, protocolConfig)} off).</strong>{' '}
                  Platform consent is enabled and your escrow holds the required{' '}
                  <span className="mono">{Number(discountPreview.vpfiRequired) / 1e18}</span> VPFI.
                  The {tierFeeLabel(discountPreview.tier, protocolConfig)} fee is paid in VPFI — the lender delivers the full
                  principal.
                </>
              ) : !discountPreview.consentEnabled ? (
                <>
                  <strong>Borrower VPFI discount available.</strong>{' '}
                  Enable platform consent on your{' '}
                  <Link to="/app" style={{ textDecoration: 'underline' }}>
                    Dashboard
                  </Link>{' '}
                  to pay a tiered VPFI fee ({protocolConfig ? protocolConfig.tierDiscountBps.map((b) => formatBpsPct(b)).join(' / ') : '10% / 15% / 20% / 24%'} off the {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)}
                  rate by escrow balance) instead of {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} in {' '}
                  <AssetSymbol address={offer.lendingAsset} />. This acceptance
                  will use the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} path.
                </>
              ) : !discountPreview.eligible ? (
                <>
                  <strong>Borrower VPFI discount unavailable.</strong>{' '}
                  This offer can't quote a discount right now (no oracle route,
                  rate unset, or escrow balance below the tier-1 threshold).
                  This acceptance will use the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} path.
                </>
              ) : (
                <>
                  <strong>Tier-{discountPreview.tier} VPFI discount pending escrow balance.</strong>{' '}
                  Consent is enabled but your escrow holds{' '}
                  <span className="mono">{Number(discountPreview.escrowVpfi) / 1e18}</span> VPFI —
                  tier {discountPreview.tier} ({tierDiscountPct(discountPreview.tier, protocolConfig)} off → {tierFeeLabel(discountPreview.tier, protocolConfig)}) needs{' '}
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
                  or proceed with the normal {formatBpsPct(protocolConfig?.loanInitiationFeeBps ?? 10)} path.
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

        <div className="alert alert-warning" style={{ marginTop: illiquid ? 8 : 0 }}>
          <AlertTriangle size={18} />
          <div style={{ fontSize: '0.88rem' }}>
            <strong>{FALLBACK_CONSENT_TITLE}.</strong>{' '}
            {FALLBACK_CONSENT_BODY}
          </div>
        </div>
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

interface OfferTableProps {
  title: string;
  subtitle: string;
  offers: OfferData[];
  anchorRateBps: bigint | null;
  address: string | null;
  acceptingId: bigint | null;
  onAccept: (id: bigint) => void;
  onToggleKeeper: (id: bigint, next: boolean) => void;
  togglingKeeperId: bigint | null;
  statusView: StatusView;
}

function OfferTable({ title, subtitle, offers, anchorRateBps, address, acceptingId, onAccept, onToggleKeeper, togglingKeeperId, statusView }: OfferTableProps) {
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
                        // Offer creator sees: Your-Offer badge + a keeper
                        // toggle. The toggle goes through setOfferKeeperAccess
                        // on-chain; it can flip freely at any point while the
                        // offer is still open, matching the per-loan keeper
                        // control available post-acceptance.
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                          <span className="status-badge settled">Your Offer</span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={togglingKeeperId === offer.id}
                            onClick={() => onToggleKeeper(offer.id, !offer.keeperAccessEnabled)}
                            data-tooltip="Toggle whether keepers whitelisted on your profile can drive this offer on your behalf. Change anytime before acceptance."
                            style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                          >
                            {togglingKeeperId === offer.id
                              ? '…'
                              : offer.keeperAccessEnabled
                                ? 'Keepers: on'
                                : 'Keepers: off'}
                          </button>
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
