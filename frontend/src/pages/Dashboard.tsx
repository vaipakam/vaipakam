import { useCallback, useEffect, useMemo, useState } from 'react';
import { L as Link } from '../components/L';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useDiamondRead } from '../contracts/useDiamond';
import { useUserLoans } from '../hooks/useUserLoans';
import { useMyOffers, type MyOfferStatus } from '../hooks/useMyOffers';
import { useClaimables } from '../hooks/useClaimables';
import { useIndexedLoansForWallet } from '../hooks/useIndexedLoans';
import { indexedToLoanSummary } from '../lib/indexerClient';
import type { LoanSummary } from '../types/loan';
import { MyOffersTable } from '../components/app/MyOffersTable';
import { useLoanRisks, type LoanRisk } from '../hooks/useLoanRisks';
import { LoanStatus, LOAN_STATUS_LABELS } from '../types/loan';
import {
  LayoutDashboard,
  HandCoins,
  Coins,
  Clock,
  PlusCircle,
  ExternalLink,
  Wallet,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react';
import { DEFAULT_CHAIN } from '../contracts/config';
import { PrincipalCell } from '../components/app/PrincipalCell';
import { bpsToPercent } from '../lib/format';
import { HealthFactorChip, LTVChip } from '../components/app/RiskGauge';
import VPFIDiscountConsentCard from '../components/app/VPFIDiscountConsentCard';
import { RewardsSummaryCard } from '../components/app/RewardsSummaryCard';
import { SanctionsBanner } from '../components/app/SanctionsBanner';
import { Pager } from '../components/app/Pager';
import { CardInfo } from '../components/CardInfo';
import { HoverTip } from '../components/HoverTip';
import { Picker } from '../components/Picker';
import { Users, Activity as ActivityIcon, ListOrdered } from 'lucide-react';
import './Dashboard.css';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 10;

type SortKey =
  | 'id'
  | 'role'
  | 'positionNft'
  | 'principal'
  | 'rate'
  | 'duration'
  | 'ltv'
  | 'hf'
  | 'status';
type SortDir = 'asc' | 'desc';

function cmpBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { address, activeChain } = useWallet();
  const diamond = useDiamondRead();
  const diamondWrite = useDiamondContract();
  // T-041 — prefer the worker-cached "loans for this wallet" list. The
  // /loans/by-{lender,borrower} endpoints already live-filter via
  // multicall(ownerOf), so the indexer's view of "which loans this
  // wallet holds NFTs for" is equivalent to the on-chain truth at
  // query time. Fall through to the per-browser useUserLoans flow
  // when the worker is unreachable. Both produce LoanSummary[]; the
  // adapter `indexedToLoanSummary` shape-bridges the indexer JSON.
  const { loans: clientLoans, loading: clientLoading } = useUserLoans(address);
  const { loans: indexedLoans, source: indexedSource } = useIndexedLoansForWallet(address ?? undefined);
  const loans: LoanSummary[] =
    indexedSource === 'indexer' && indexedLoans
      ? (indexedLoans.map((l) => indexedToLoanSummary(l, l.role)) as LoanSummary[])
      : clientLoans;
  const loading = indexedSource === 'indexer' ? false : clientLoading;
  const [myOfferStatus, setMyOfferStatus] = useState<MyOfferStatus>('active');
  const { rows: myOfferRows } = useMyOffers(address, myOfferStatus);
  const { claims: unclaimed } = useClaimables(address);
  const [cancellingOfferId, setCancellingOfferId] = useState<bigint | null>(null);
  // Set of loanIds (decimal string) where the connected wallet has at least
  // one actionable claim (lender or borrower side). Drives the inline
  // "Claim" CTA rendered next to "View" on each terminal-status loan row.
  const unclaimedLoanIds = useMemo(
    () => new Set(unclaimed.map((c) => c.loanId.toString())),
    [unclaimed],
  );
  const [escrow, setEscrow] = useState<string | null>(null);
  const [loansPage, setLoansPage] = useState(0);
  const [roleFilter, setRoleFilter] = useState<'all' | 'lender' | 'borrower'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | LoanStatus>('all');
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [sortBy, setSortBy] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    // No address = disconnected; the `escrow` slot is derived as null below,
    // so skipping the effect (rather than setting state inside it) keeps this
    // out of the setState-in-effect footgun.
    if (!address) return;
    (async () => {
      try {
        // `getUserEscrow` is `nonpayable` (lazy-deploys a proxy when missing),
        // so a normal call would prompt the wallet on every page load. Running
        // it via `staticCall` uses `eth_call` — reverts to "no escrow" silently.
        const esc: string = await diamond.getUserEscrow.staticCall(address);
        if (esc && esc !== ZERO_ADDRESS) setEscrow(esc);
      } catch {
        // User has no escrow deployed yet — silent is correct here.
      }
    })();
  }, [address, diamond]);

  // Disconnected wallet always surfaces a null escrow, regardless of whatever
  // value was left in state from a previous session. Derivation keeps this in
  // sync without a setEscrow(null) inside the effect.
  const currentEscrow = address ? escrow : null;

  const activeLoans = loans.filter((l) => l.status === LoanStatus.Active);
  const lentCount = loans.filter((l) => l.role === 'lender').length;
  const borrowedCount = loans.filter((l) => l.role === 'borrower').length;

  // Filter pipeline: apply role + status filters BEFORE paginating, so the
  // page count and Pager total reflect the filtered set, not the raw set.
  const filteredLoans = useMemo(
    () =>
      loans.filter((l) =>
        (roleFilter === 'all' || l.role === roleFilter) &&
        (statusFilter === 'all' || l.status === statusFilter),
      ),
    [loans, roleFilter, statusFilter],
  );

  // Snap back to page 0 whenever a filter narrows the set past the current
  // cursor — otherwise the table renders blank with a paginator stuck on a
  // page that no longer exists. Same applies on a per-page bump that
  // shrinks the page count, or a sort change that reorders rows.
  useEffect(() => {
    setLoansPage(0);
  }, [roleFilter, statusFilter, pageSize, sortBy, sortDir]);

  // Risks for the FULL filtered set, not just the current page — sorting by
  // HF or LTV needs the values for every candidate row, not only the rows
  // currently on screen. Two multicalls regardless of list size, so the
  // perf impact is minimal for typical wallet loan counts.
  const filteredLoanIds = useMemo(
    () => filteredLoans.map((l) => l.id),
    [filteredLoans],
  );
  const { risks } = useLoanRisks(filteredLoanIds);

  const sortedLoans = useMemo(() => {
    const arr = [...filteredLoans];
    arr.sort((a, b) => {
      let c = 0;
      if (sortBy === 'id') c = cmpBigint(a.id, b.id);
      else if (sortBy === 'role') c = a.role.localeCompare(b.role);
      else if (sortBy === 'positionNft') {
        const aTok = a.role === 'lender' ? a.lenderTokenId : a.borrowerTokenId;
        const bTok = b.role === 'lender' ? b.lenderTokenId : b.borrowerTokenId;
        c = cmpBigint(aTok, bTok);
      }
      else if (sortBy === 'principal') c = cmpBigint(a.principal, b.principal);
      else if (sortBy === 'rate') c = cmpBigint(a.interestRateBps, b.interestRateBps);
      else if (sortBy === 'duration') c = cmpBigint(a.durationDays, b.durationDays);
      else if (sortBy === 'status') c = Number(a.status) - Number(b.status);
      else if (sortBy === 'ltv' || sortBy === 'hf') {
        // Nulls sink to the bottom regardless of direction — illiquid loans
        // don't have an HF/LTV reading and shouldn't bubble to the top of
        // either sort order.
        const aV = risks.get(a.id.toString())?.[sortBy] ?? null;
        const bV = risks.get(b.id.toString())?.[sortBy] ?? null;
        if (aV === null && bV === null) c = 0;
        else if (aV === null) return 1;
        else if (bV === null) return -1;
        else c = cmpBigint(aV, bV);
      }
      return sortDir === 'asc' ? c : -c;
    });
    return arr;
  }, [filteredLoans, sortBy, sortDir, risks]);

  const pagedLoans = useMemo(
    () =>
      sortedLoans.slice(
        loansPage * pageSize,
        (loansPage + 1) * pageSize,
      ),
    [sortedLoans, loansPage, pageSize],
  );

  const toggleSort = useCallback((key: SortKey) => {
    // Don't nest one state setter inside another — React 18 strict mode
    // invokes setSortBy's updater twice for invariant checking, which
    // would double-fire the nested setSortDir and cancel out the flip
    // (user-visible symptom: "first click sorts asc, second click stays
    // asc"). Both setters at the same level keeps the strict-mode
    // double-invoke safe.
    if (sortBy === key) {
      // Same column → flip direction.
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      // New column → start ascending so the first click reveals the
      // smallest values; second click flips to descending.
      setSortBy(key);
      setSortDir('asc');
    }
  }, [sortBy]);

  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>{t('dashboard.connectTitle')}</h3>
        <p>{t('dashboard.connectBody')}</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1 className="page-title">{t('appNav.dashboard')}</h1>
        <p className="page-subtitle">{t('dashboard.subtitle')}</p>
      </div>

      {address && (
        <SanctionsBanner
          address={address as `0x${string}`}
          label={t('banners.sanctionsLabelWallet')}
        />
      )}

      {/* Stats row */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(79, 70, 229, 0.1)', color: 'var(--brand)' }}>
            <LayoutDashboard size={20} />
          </div>
          <div>
            <div className="stat-value">{activeLoans.length}</div>
            <div className="stat-label">{t('dashboard.activeLoans')}</div>
          </div>
        </div>
        {/* Lender / borrower role tiles use neutral, role-symmetric
            icons + the same brand-tinted background. The previous
            TrendingUp (green) / TrendingDown (amber) pair carried an
            unintended emotional skew — "lender = good / borrowing =
            bad" — that's wrong on a peer-to-peer lending app where
            both sides are equally valid market participants. Coins
            (lender funds) / HandCoins (borrower receives) keeps the
            domain semantics without the colour bias. */}
        <div className="stat-card">
          <div
            className="stat-icon"
            style={{
              background: 'rgba(99, 102, 241, 0.1)',
              color: 'var(--brand)',
            }}
          >
            <Coins size={20} />
          </div>
          <div>
            <div className="stat-value">{lentCount}</div>
            <div className="stat-label">{t('dashboard.asLender')}</div>
          </div>
        </div>
        <div className="stat-card">
          <div
            className="stat-icon"
            style={{
              background: 'rgba(99, 102, 241, 0.1)',
              color: 'var(--brand)',
            }}
          >
            <HandCoins size={20} />
          </div>
          <div>
            <div className="stat-value">{borrowedCount}</div>
            <div className="stat-label">{t('dashboard.asBorrower')}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(148, 163, 184, 0.1)', color: 'var(--text-tertiary)' }}>
            <Clock size={20} />
          </div>
          <div>
            <div className="stat-value">{loans.length}</div>
            <div className="stat-label">{t('dashboard.totalLoans')}</div>
          </div>
        </div>
      </div>

      {/* Platform-level VPFI fee-discount consent (per-user). The
          read-only `<DiscountStatusCard>` that used to live here was
          moved to the Buy VPFI page — that's where buying decisions
          happen and the tier-thresholds reference is most relevant.
          Dashboard keeps the consent toggle (the actionable surface)
          and links into Buy VPFI via the rewards-summary chevron
          below for users who want to inspect their tier status. */}
      <VPFIDiscountConsentCard />

      {/* Aspirational rewards summary — combined view of pending +
          lifetime-claimed across both reward streams (staking yield
          on escrow VPFI; platform-interaction rebate). Each row deep-
          links to the full claim card on its native page so the user
          can act with one click. Replaces the old inline-variant
          StakingRewardsClaim mirror — that variant only ever lived
          here, the new card supersedes it with broader coverage. */}
      <RewardsSummaryCard address={address ?? null} />

      {/* Escrow info — redacted address (no copy / no full-reveal),
          links to block explorer in a new tab so users can verify
          on-chain holdings independently. The escrow is INTERNAL
          protocol storage, not a deposit destination — anyone who
          accidentally sends tokens directly to it may be unable to
          recover them. Caption + the dedicated `/app/escrow` page
          carry the full warning. The redacted display + non-
          selectable styling combat the trivial copy paths; DOM
          inspection bypass is intentionally out of scope. */}
      {currentEscrow && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            {t('dashboard.yourEscrow')}
            <CardInfo id="dashboard.your-escrow" />
          </div>
          <div className="data-row">
            <span className="data-label">{t('dashboard.escrowAddress')}</span>
            <a
              href={`${activeChain?.blockExplorer ?? DEFAULT_CHAIN.blockExplorer}/address/${currentEscrow}`}
              target="_blank"
              rel="noreferrer noopener"
              onCopy={(e) => e.preventDefault()}
              className="data-value"
              style={{
                color: 'var(--brand)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                userSelect: 'none',
                fontFamily: 'monospace',
              }}
              aria-label={t('escrowAssets.viewOnExplorer')}
            >
              {currentEscrow.slice(0, 6)}…{currentEscrow.slice(-4)}
              <ExternalLink size={14} />
            </a>
          </div>
          <p
            style={{
              marginTop: 8,
              marginBottom: 0,
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
            }}
          >
            {t('escrowAssets.addressCaption')}
          </p>
        </div>
      )}

      {/* Connected wallet's own currently-open offers. Lifted from the
          OfferBook page so Dashboard reads as a single "your stuff"
          surface (Your Loans + Your Active Offers + your VPFI). The
          card is rendered only when the user has at least one open
          offer; otherwise we skip it entirely to avoid an empty
          placeholder pushing the loans card down. The OfferTable
          component renders the user's own row with a "Your offer"
          badge + "Manage keepers" link instead of an Accept button,
          so no extra wiring is needed for the cancel / manage flows. */}
      {/* Your Offers — connected wallet's offers in three lifecycle
          states (active / filled / cancelled / all). Replaces the
          previous "Your Active Offers" card; the new chip filter
          surfaces cancelled offers (which previously had no UI home)
          and filled offers (with an inline `Loan #N` link to the loan
          they became). */}
      {address && (
        <div style={{ marginTop: 16 }}>
          <MyOffersTable
            rows={myOfferRows}
            onCancel={async (offerId) => {
              if (cancellingOfferId !== null) return;
              setCancellingOfferId(offerId);
              try {
                const tx = await diamondWrite.cancelOffer(offerId);
                await tx.wait();
              } catch (err) {
                // Surface failures via the global error toast surface
                // — `console.error` is a placeholder; the existing
                // `<ErrorAlert>` infra used in OfferBook is per-page
                // and not lifted to Dashboard yet. A user-visible
                // failure here is rare in practice (the only typed
                // revert is OfferAlreadyAccepted, which races a
                // concurrent acceptOffer — uncommon).
                // eslint-disable-next-line no-console
                console.error('cancelOffer failed:', err);
              } finally {
                setCancellingOfferId(null);
              }
            }}
            cancellingId={cancellingOfferId}
            chainId={activeChain?.chainId ?? DEFAULT_CHAIN.chainId}
            title={t('dashboard.yourOffers')}
            subtitle={t('myOffersTable.subtitle', { count: myOfferRows.length })}
            cardHelpId="offer-book.your-active-offers"
            headerAction={
              <>
                {/* Status filter sits inline with the New Offer button
                    (status chip first, action button after) so the
                    card title row reads "Your Offers · n offers
                    [Status: …] [+ New Offer]" left to right. The
                    filter previously rendered outside the card; moved
                    in per ToDo polish so the user doesn't lose track
                    of which filter is in effect when they scroll the
                    table. */}
                <Picker<MyOfferStatus>
                  icon={<ListOrdered size={14} />}
                  ariaLabel={t('myOffersTable.statusFilter')}
                  triggerPrefix={t('myOffersTable.statusFilter')}
                  value={myOfferStatus}
                  onSelect={setMyOfferStatus}
                  minWidth={170}
                  items={[
                    { value: 'active', label: t('myOffersTable.statusActive') },
                    { value: 'filled', label: t('myOffersTable.statusFilled') },
                    { value: 'cancelled', label: t('myOffersTable.statusCancelled') },
                    { value: 'all', label: t('common.all') },
                  ]}
                />
                <Link to="/app/create-offer" className="btn btn-primary btn-sm">
                  <PlusCircle size={16} /> {t('dashboard.newOffer')}
                </Link>
              </>
            }
          />
        </div>
      )}

      {/* Active loans */}
      <div className="card" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>
            {t('dashboard.yourLoans')}
            <CardInfo id="dashboard.your-loans" />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Picker<'all' | 'lender' | 'borrower'>
              icon={<Users size={14} />}
              ariaLabel={t('common.role')}
              triggerPrefix={t('common.role')}
              value={roleFilter}
              onSelect={setRoleFilter}
              minWidth={150}
              items={[
                { value: 'all', label: t('common.all') },
                { value: 'lender', label: t('common.lender') },
                { value: 'borrower', label: t('common.borrower') },
              ]}
            />
            <Picker<'all' | LoanStatus>
              icon={<ActivityIcon size={14} />}
              ariaLabel={t('common.status')}
              triggerPrefix={t('common.status')}
              value={statusFilter}
              onSelect={setStatusFilter}
              minWidth={180}
              items={[
                { value: 'all', label: t('common.all') },
                ...(Object.values(LoanStatus) as LoanStatus[]).map((s) => ({
                  value: s,
                  label: LOAN_STATUS_LABELS[s],
                })),
              ]}
            />
            <Picker<number>
              icon={<ListOrdered size={14} />}
              ariaLabel={t('common.perPage')}
              triggerPrefix={t('common.perPage')}
              value={pageSize}
              onSelect={setPageSize}
              minWidth={140}
              items={PAGE_SIZE_OPTIONS.map((n) => ({
                value: n,
                label: String(n),
                pill: n === DEFAULT_PAGE_SIZE ? 'default' : undefined,
              }))}
            />
            {/* The "New Offer" CTA on this row only renders for
                disconnected users — once connected the Your Offers
                card directly above always renders (with its own
                "+ New Offer" header action), so a duplicate here
                would just be visual noise. */}
            {!address && (
              <Link to="/app/create-offer" className="btn btn-primary btn-sm">
                <PlusCircle size={16} /> {t('dashboard.newOffer')}
              </Link>
            )}
          </div>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>{t('dashboard.loadingPositions')}</p>
          </div>
        ) : loans.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <LayoutDashboard size={28} />
            </div>
            <h3>{t('dashboard.noLoansYet')}</h3>
            <p>{t('dashboard.noLoansBody')}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Link to="/app/create-offer" className="btn btn-primary btn-sm">
                {t('appNav.createOffer')}
              </Link>
              <Link to="/app/offers" className="btn btn-secondary btn-sm">
                {t('dashboard.browseOffers')}
              </Link>
            </div>
          </div>
        ) : filteredLoans.length === 0 ? (
          <div className="empty-state">
            <p>{t('common.noMatches')}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setRoleFilter('all'); setStatusFilter('all'); }}
            >
              {t('common.clearFilters')}
            </button>
          </div>
        ) : (
          <div className="loans-table-wrap">
            <table className="loans-table">
              <thead>
                <tr>
                  <SortTh sortKey="id" label="ID" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="role" label="Role" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="positionNft" label="Position NFT" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="principal" label="Principal" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <th>Collateral</th>
                  <SortTh sortKey="rate" label="Rate (APR)" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="duration" label="Duration" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="ltv" label="LTV" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="hf" label="HF" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortTh sortKey="status" label="Status" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagedLoans.map((loan) => (
                  <tr key={loan.id.toString()}>
                    <td>
                      {/* Loan id doubles as a deep-link to the loan
                          details page. The "View" button still lives in
                          the last column for users who scroll, but on
                          a wide table the leftmost cell is what users
                          read first; making it the click target removes
                          the hidden-action problem on narrow viewports. */}
                      <Link
                        to={`/app/loans/${loan.id.toString()}`}
                        style={{ color: 'var(--brand)', textDecoration: 'none' }}
                      >
                        #{loan.id.toString()}
                      </Link>
                    </td>
                    <td>
                      <span className={`status-badge ${loan.role}`}>
                        {loan.role === 'lender' ? t('common.lender') : t('common.borrower')}
                      </span>
                    </td>
                    <td className="mono">
                      <HoverTip text="Verify on-chain metadata (opens in new tab)">
                        <Link
                          to={`/nft-verifier?id=${(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          #{(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}
                          <ExternalLink size={12} />
                        </Link>
                      </HoverTip>
                    </td>
                    <td>
                      {/* Unified principal renderer — handles ERC20
                          (amount + symbol), ERC721 (`NFT #N` + collection),
                          and ERC1155 (`Q × NFT #N`). For NFT principals
                          (rental loans) the explorer's NFT-page viewer
                          link surfaces inline. */}
                      <PrincipalCell
                        assetType={loan.assetType}
                        asset={loan.principalAsset}
                        amount={loan.principal}
                        tokenId={loan.principalTokenId}
                        chainId={activeChain?.chainId ?? DEFAULT_CHAIN.chainId}
                      />
                    </td>
                    <td>
                      {/* Collateral leg — same renderer as principal so
                          ERC-20 amount, ERC-721 `NFT #id`, and ERC-1155
                          `Q × NFT #id` all show consistently. Empty
                          asset address (rare — historical zero-address
                          mock loans) renders as a dash to avoid the
                          renderer flagging an "unknown" asset. */}
                      {loan.collateralAsset &&
                      loan.collateralAsset !== '0x0000000000000000000000000000000000000000' ? (
                        <PrincipalCell
                          assetType={loan.collateralAssetType}
                          asset={loan.collateralAsset}
                          amount={loan.collateralAmount}
                          tokenId={loan.collateralTokenId}
                          chainId={activeChain?.chainId ?? DEFAULT_CHAIN.chainId}
                        />
                      ) : (
                        <span style={{ opacity: 0.5 }}>—</span>
                      )}
                    </td>
                    <td>{bpsToPercent(loan.interestRateBps)}</td>
                    <td>{loan.durationDays.toString()} days</td>
                    <td><LoanLtvCell risk={risks.get(loan.id.toString())} /></td>
                    <td><LoanHfCell risk={risks.get(loan.id.toString())} /></td>
                    <td>
                      <span className={`status-badge ${LOAN_STATUS_LABELS[loan.status].toLowerCase()}`}>
                        {LOAN_STATUS_LABELS[loan.status]}
                      </span>
                    </td>
                    <td>
                      {/* The View button used to live here; it was
                          redundant with the loan-id link in the first
                          column (which deep-links to the same page).
                          The cell stays for the Claim CTA — only
                          rendered when this loan has terminal-state
                          claimables waiting on this wallet, otherwise
                          empty. Empty cells in this last column are
                          fine; the column header is intentionally
                          unlabelled (an "Actions" header would
                          mislead since most rows have no action). */}
                      {unclaimedLoanIds.has(loan.id.toString()) && (
                        <HoverTip text={t('dashboard.claimReadyTooltip')}>
                          <Link
                            to={`/app/loans/${loan.id.toString()}`}
                            className="btn btn-primary btn-sm"
                          >
                            {t('dashboard.claim')}
                          </Link>
                        </HoverTip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              total={filteredLoans.length}
              pageSize={pageSize}
              page={loansPage}
              onPageChange={setLoansPage}
              unit="loan"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SortTh({
  sortKey,
  label,
  sortBy,
  sortDir,
  onToggle,
}: {
  sortKey: SortKey;
  label: string;
  sortBy: SortKey;
  sortDir: SortDir;
  onToggle: (key: SortKey) => void;
}) {
  const isActive = sortBy === sortKey;
  return (
    <th>
      <button
        type="button"
        className="loan-sort-th"
        onClick={() => onToggle(sortKey)}
        aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <span>{label}</span>
        {isActive ? (
          sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        ) : (
          <ChevronsUpDown size={12} className="loan-sort-th-idle" />
        )}
      </button>
    </th>
  );
}

function LoanLtvCell({ risk }: { risk: LoanRisk | undefined }) {
  const ltv = risk?.ltv ?? null;
  return <LTVChip percent={ltv === null ? null : Number(ltv) / 1e16} />;
}

function LoanHfCell({ risk }: { risk: LoanRisk | undefined }) {
  const hf = risk?.hf ?? null;
  return <HealthFactorChip value={hf === null ? null : Number(hf) / 1e18} />;
}

