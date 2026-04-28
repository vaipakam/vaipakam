import { useCallback, useEffect, useMemo, useState } from 'react';
import { L as Link } from '../components/L';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useWallet } from '../context/WalletContext';
import { useDiamondRead } from '../contracts/useDiamond';
import { useUserLoans } from '../hooks/useUserLoans';
import { useLoanRisks, type LoanRisk } from '../hooks/useLoanRisks';
import { useVPFIToken } from '../hooks/useVPFIToken';
import { useUserVPFI } from '../hooks/useUserVPFI';
import { useEscrowVPFIBalance, formatVpfiUnits } from '../hooks/useVPFIDiscount';
import { LoanStatus, LOAN_STATUS_LABELS } from '../types/loan';
import {
  LayoutDashboard,
  TrendingUp,
  TrendingDown,
  Clock,
  PlusCircle,
  ExternalLink,
  Wallet,
  Coins,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react';
import { DEFAULT_CHAIN } from '../contracts/config';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { bpsToPercent } from '../lib/format';
import { HealthFactorGauge, LTVBar } from '../components/app/RiskGauge';
import VPFIDiscountConsentCard from '../components/app/VPFIDiscountConsentCard';
import { Pager } from '../components/app/Pager';
import { CardInfo } from '../components/CardInfo';
import { InfoTip } from '../components/InfoTip';
import { Picker } from '../components/Picker';
import { useMode } from '../context/ModeContext';
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
  const { address, activeChain, chainId } = useWallet();
  const { mode } = useMode();
  const isAdvanced = mode === 'advanced';
  const diamond = useDiamondRead();
  const { loans, loading } = useUserLoans(address);
  const { snapshot: vpfi } = useVPFIToken();
  const { snapshot: userVpfi } = useUserVPFI(address);
  const { balance: escrowVpfiWei } = useEscrowVPFIBalance(address);
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
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent-green)' }}>
            <TrendingUp size={20} />
          </div>
          <div>
            <div className="stat-value">{lentCount}</div>
            <div className="stat-label">{t('dashboard.asLender')}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--accent-orange)' }}>
            <TrendingDown size={20} />
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

      {/* Platform-level VPFI fee-discount consent (per-user) */}
      <VPFIDiscountConsentCard />

      {/* Escrow info */}
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
              rel="noreferrer"
              className="data-value"
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {currentEscrow.slice(0, 10)}...{currentEscrow.slice(-8)}
              <ExternalLink size={14} />
            </a>
          </div>
        </div>
      )}

      {/* VPFI transparency */}
      <VPFIPanel
        vpfi={vpfi}
        userVpfi={userVpfi}
        escrowVpfiWei={escrowVpfiWei}
        networkName={activeChain?.name ?? DEFAULT_CHAIN.name}
        networkChainId={chainId ?? DEFAULT_CHAIN.chainId}
        blockExplorer={activeChain?.blockExplorer ?? DEFAULT_CHAIN.blockExplorer}
        isCanonicalVPFI={activeChain?.isCanonicalVPFI ?? DEFAULT_CHAIN.isCanonicalVPFI}
        isAdvanced={isAdvanced}
      />

      {/* Active loans */}
      <div className="card">
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
            <Link to="/app/create-offer" className="btn btn-primary btn-sm">
              <PlusCircle size={16} /> {t('dashboard.newOffer')}
            </Link>
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
                    <td>#{loan.id.toString()}</td>
                    <td>
                      <span className={`status-badge ${loan.role}`}>
                        {loan.role === 'lender' ? t('common.lender') : t('common.borrower')}
                      </span>
                    </td>
                    <td className="mono">
                      <Link
                        to={`/nft-verifier?id=${(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-tooltip="Verify on-chain metadata (opens in new tab)"
                        style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        #{(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}
                        <ExternalLink size={12} />
                      </Link>
                    </td>
                    <td className="mono">
                      <TokenAmount amount={loan.principal} address={loan.principalAsset} />{' '}
                      <span className="asset-addr"><AssetSymbol address={loan.principalAsset} /></span>
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
                      <Link to={`/app/loans/${loan.id.toString()}`} className="btn btn-ghost btn-sm">
                        {t('common.view')}
                      </Link>
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
  return <LTVBar percent={ltv === null ? null : Number(ltv) / 1e16} />;
}

function LoanHfCell({ risk }: { risk: LoanRisk | undefined }) {
  const hf = risk?.hf ?? null;
  return <HealthFactorGauge value={hf === null ? null : Number(hf) / 1e18} />;
}

function shortenAddr(a: string | null | undefined): string {
  if (!a) return '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatVpfi(n: number): string {
  // Locale-aware grouping + decimal separator. Compact notation
  // (`1.2M`) for >= 1k matches the previous behaviour while letting
  // each locale render the suffix in its native script (`1,2 万` ja,
  // `1٫2 ألف` ar). Below 1k → 2-fraction-digit precise form.
  const lng = i18nResolved();
  if (n === 0) return new Intl.NumberFormat(lng).format(0);
  if (n >= 1000) {
    return new Intl.NumberFormat(lng, {
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(n);
  }
  return new Intl.NumberFormat(lng, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function i18nResolved(): string {
  return i18n.resolvedLanguage ?? 'en';
}

interface VPFIPanelProps {
  vpfi: ReturnType<typeof useVPFIToken>['snapshot'];
  userVpfi: ReturnType<typeof useUserVPFI>['snapshot'];
  /** 18-dec VPFI currently locked in the user's protocol escrow on the
   *  active chain. `null` when the escrow hasn't been deployed yet or
   *  the balance fetch is still in flight — rendered as "—". */
  escrowVpfiWei: bigint | null;
  networkName: string;
  networkChainId: number;
  blockExplorer: string;
  isCanonicalVPFI: boolean;
  /** Advanced-mode flag from `<ModeContext>`. When false, the two
   *  technical badges in the card header (chain-name+id and the
   *  Canonical/Mirror role pill) are hidden — they're protocol
   *  detail that beginners don't need to see. */
  isAdvanced: boolean;
}

const DIRECTION_LABEL: Record<'in' | 'out' | 'mint' | 'burn' | 'self', string> = {
  in: 'Received',
  out: 'Sent',
  mint: 'Minted to you',
  burn: 'Burned',
  self: 'Self-transfer',
};

export function VPFIPanel({
  vpfi,
  userVpfi,
  escrowVpfiWei,
  networkName,
  networkChainId,
  blockExplorer,
  isCanonicalVPFI,
  isAdvanced,
}: VPFIPanelProps) {
  const { t } = useTranslation();
  const registered = !!vpfi?.registered;
  const tokenAddr = vpfi?.token ?? null;
  const minterAddr = vpfi?.minter ?? null;
  const balance = userVpfi?.balance ?? 0;
  const escrowVpfiUnits = escrowVpfiWei == null ? 0 : formatVpfiUnits(escrowVpfiWei);
  // Effective ownership share = (wallet + escrow) / circulating. Escrow
  // VPFI is still user-controlled — it's locked by choice, not
  // transferred away — and counts toward their stake in the protocol.
  // `userVpfi.shareOfCirculating` from the hook only reflects wallet
  // balance; we recompute here so the Dashboard number matches the
  // intuitive meaning.
  const totalSupply = vpfi?.totalSupply ?? 0;
  const effectiveShareOfCirculating =
    totalSupply > 0 ? (balance + escrowVpfiUnits) / totalSupply : 0;
  const recentMints = userVpfi?.recentMints ?? [];
  const recentTransfers = userVpfi?.recentTransfers ?? [];
  const treasury = userVpfi?.treasury ?? null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Coins size={16} style={{ color: 'var(--brand)' }} />
          <div className="card-title" style={{ marginBottom: 0 }}>
            {t('vpfiTokenCard.title')}
            <CardInfo id="dashboard.vpfi-panel" />
          </div>
        </div>
        {/* Technical badges (chain-name+id, Canonical/Mirror role)
         *  are protocol-internals power-user info — hidden from
         *  Basic mode so first-time users aren't bombarded with
         *  cross-chain bridge terminology. The Canonical/Mirror
         *  pill's previously-truncated `data-tooltip` is now an
         *  inline InfoTip — click-only on every device, portal-
         *  rendered so the bubble can't get clipped, and the
         *  full explanation always wraps inside the viewport. */}
        {isAdvanced && (
          <div
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
          >
            <span
              className="status-badge"
              style={{ background: 'rgba(148, 163, 184, 0.12)', color: 'var(--text-tertiary)' }}
            >
              {t('vpfiTokenCard.chainBadge', { chain: networkName, chainId: networkChainId })}
            </span>
            <span
              className="status-badge"
              style={{
                background: isCanonicalVPFI
                  ? 'rgba(79, 70, 229, 0.12)'
                  : 'rgba(16, 185, 129, 0.12)',
                color: isCanonicalVPFI ? 'var(--brand)' : 'var(--accent-green)',
              }}
            >
              {isCanonicalVPFI ? t('vpfiTokenCard.canonical') : t('vpfiTokenCard.mirror')}
            </span>
            <InfoTip ariaLabel={isCanonicalVPFI ? t('vpfiTokenCard.canonicalAria') : t('vpfiTokenCard.mirrorAria')}>
              {isCanonicalVPFI ? t('vpfiTokenCard.canonicalTip') : t('vpfiTokenCard.mirrorTip')}
            </InfoTip>
          </div>
        )}
      </div>

      {!registered ? (
        <div className="empty-state" style={{ padding: '16px 0' }}>
          <p style={{ margin: 0 }}>{t('vpfiTokenCard.notRegistered', { chain: networkName })}</p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <div className="stat-value">{formatVpfi(balance)}</div>
              <div className="stat-label">{t('vpfiTokenCard.walletBalance')}</div>
            </div>
            <div>
              <div
                className="stat-value"
                data-tooltip={t('vpfiTokenCard.escrowTooltip')}
                data-tooltip-placement="below-start"
              >
                {escrowVpfiWei == null
                  ? '—'
                  : formatVpfi(formatVpfiUnits(escrowVpfiWei))}
              </div>
              <div className="stat-label">{t('vpfiTokenCard.escrowBalance')}</div>
            </div>
            <div>
              <div
                className="stat-value"
                data-tooltip={t('vpfiTokenCard.shareTooltip')}
                data-tooltip-placement="below-start"
              >
                {(effectiveShareOfCirculating * 100).toFixed(2)}%
              </div>
              <div className="stat-label">{t('vpfiTokenCard.shareCirculating')}</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.totalSupply) : '—'}</div>
              <div className="stat-label">{t('vpfiTokenCard.circulatingThisChain')}</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.capHeadroom) : '—'}</div>
              <div className="stat-label">{t('vpfiTokenCard.remainingMintable')}</div>
            </div>
          </div>

          <div className="data-row">
            <span className="data-label">{t('vpfiTokenCard.tokenLabel')}</span>
            <a
              href={`${blockExplorer}/address/${tokenAddr}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {shortenAddr(tokenAddr)}
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="data-row">
            <span className="data-label">{t('vpfiTokenCard.authorizedMinter')}</span>
            <a
              href={`${blockExplorer}/address/${minterAddr}`}
              target="_blank"
              rel="noreferrer"
              className="data-value mono"
              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {shortenAddr(minterAddr)}
              <ExternalLink size={14} />
            </a>
          </div>
          {treasury && (
            <div className="data-row">
              <span className="data-label">{t('vpfiTokenCard.treasuryMintDestination')}</span>
              <a
                href={`${blockExplorer}/address/${treasury}`}
                target="_blank"
                rel="noreferrer"
                className="data-value mono"
                style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {shortenAddr(treasury)}
                <ExternalLink size={14} />
              </a>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div className="data-label" style={{ marginBottom: 8 }}>
              {t('vpfiTokenCard.yourActivity')}
            </div>
            {recentTransfers.length === 0 ? (
              <p className="stat-label" style={{ margin: 0 }}>
                {t('vpfiTokenCard.noActivity', { chain: networkName })}
              </p>
            ) : (
              <div className="loans-table-wrap">
                <table className="loans-table">
                  <thead>
                    <tr>
                      <th>Direction</th>
                      <th>Amount (VPFI)</th>
                      <th>Counterparty</th>
                      <th>Block</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTransfers.map((t) => (
                      <tr key={`${t.txHash}:${t.logIndex}`}>
                        <td>
                          <span
                            className="status-badge"
                            style={{
                              background:
                                t.direction === 'in' || t.direction === 'mint'
                                  ? 'rgba(16, 185, 129, 0.12)'
                                  : t.direction === 'out' || t.direction === 'burn'
                                    ? 'rgba(239, 68, 68, 0.12)'
                                    : 'rgba(148, 163, 184, 0.12)',
                              color:
                                t.direction === 'in' || t.direction === 'mint'
                                  ? 'var(--accent-green)'
                                  : t.direction === 'out' || t.direction === 'burn'
                                    ? 'var(--accent-red, #ef4444)'
                                    : 'var(--text-tertiary)',
                            }}
                          >
                            {DIRECTION_LABEL[t.direction]}
                          </span>
                        </td>
                        <td className="mono">{formatVpfi(t.amount)}</td>
                        <td className="mono">
                          {t.direction === 'mint' || t.direction === 'burn' ? (
                            <span className="pd-subtle">{shortenAddr(t.counterparty)}</span>
                          ) : (
                            <a
                              href={`${blockExplorer}/address/${t.counterparty}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            >
                              {shortenAddr(t.counterparty)}
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </td>
                        <td className="mono">{t.blockNumber}</td>
                        <td>
                          <a
                            href={`${blockExplorer}/tx/${t.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {shortenAddr(t.txHash)}
                            <ExternalLink size={12} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {recentMints.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="data-label" style={{ marginBottom: 8 }}>
                Diamond → Treasury mint events
              </div>
              <div className="loans-table-wrap">
                <table className="loans-table">
                  <thead>
                    <tr>
                      <th>Block</th>
                      <th>Amount (VPFI)</th>
                      <th>To</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMints.map((m) => (
                      <tr key={m.txHash}>
                        <td className="mono">{m.blockNumber}</td>
                        <td className="mono">{formatVpfi(m.amount)}</td>
                        <td className="mono">
                          <a
                            href={`${blockExplorer}/address/${m.to}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {shortenAddr(m.to)}
                          </a>
                        </td>
                        <td>
                          <a
                            href={`${blockExplorer}/tx/${m.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {shortenAddr(m.txHash)}
                            <ExternalLink size={12} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
