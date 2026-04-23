import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
} from 'lucide-react';
import { DEFAULT_CHAIN } from '../contracts/config';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { bpsToPercent } from '../lib/format';
import { HealthFactorGauge, LTVBar } from '../components/app/RiskGauge';
import VPFIDiscountConsentCard from '../components/app/VPFIDiscountConsentCard';
import { Pager } from '../components/app/Pager';
import './Dashboard.css';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LOANS_PAGE_SIZE = 15;

export default function Dashboard() {
  const { address, activeChain, chainId } = useWallet();
  const diamond = useDiamondRead();
  const { loans, loading } = useUserLoans(address);
  const { snapshot: vpfi } = useVPFIToken();
  const { snapshot: userVpfi } = useUserVPFI(address);
  const { balance: escrowVpfiWei } = useEscrowVPFIBalance(address);
  const [escrow, setEscrow] = useState<string | null>(null);
  const [loansPage, setLoansPage] = useState(0);

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

  const pagedLoans = useMemo(
    () =>
      loans.slice(
        loansPage * LOANS_PAGE_SIZE,
        (loansPage + 1) * LOANS_PAGE_SIZE,
      ),
    [loans, loansPage],
  );

  // Batch LTV + HF for every visible row in two multicalls instead of firing
  // one pair of RPCs per row. The risks map is keyed by loanId string so the
  // cells can look up O(1) without running their own effect.
  const pagedLoanIds = useMemo(() => pagedLoans.map((l) => l.id), [pagedLoans]);
  const { risks } = useLoanRisks(pagedLoanIds);

  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>Connect Your Wallet</h3>
        <p>Connect your wallet to view your dashboard, active loans, and positions.</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Overview of your lending and borrowing positions</p>
      </div>

      {/* Stats row */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(79, 70, 229, 0.1)', color: 'var(--brand)' }}>
            <LayoutDashboard size={20} />
          </div>
          <div>
            <div className="stat-value">{activeLoans.length}</div>
            <div className="stat-label">Active Loans</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent-green)' }}>
            <TrendingUp size={20} />
          </div>
          <div>
            <div className="stat-value">{lentCount}</div>
            <div className="stat-label">As Lender</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--accent-orange)' }}>
            <TrendingDown size={20} />
          </div>
          <div>
            <div className="stat-value">{borrowedCount}</div>
            <div className="stat-label">As Borrower</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(148, 163, 184, 0.1)', color: 'var(--text-tertiary)' }}>
            <Clock size={20} />
          </div>
          <div>
            <div className="stat-value">{loans.length}</div>
            <div className="stat-label">Total Loans</div>
          </div>
        </div>
      </div>

      {/* Platform-level VPFI fee-discount consent (per-user) */}
      <VPFIDiscountConsentCard />

      {/* Escrow info */}
      {currentEscrow && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Your Escrow</div>
          <div className="data-row">
            <span className="data-label">Escrow Address</span>
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
      />

      {/* Active loans */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Your Loans</div>
          <Link to="/app/create-offer" className="btn btn-primary btn-sm">
            <PlusCircle size={16} /> New Offer
          </Link>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>Loading your positions...</p>
          </div>
        ) : loans.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <LayoutDashboard size={28} />
            </div>
            <h3>No Loans Yet</h3>
            <p>Create an offer or browse the offer book to get started.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Link to="/app/create-offer" className="btn btn-primary btn-sm">
                Create Offer
              </Link>
              <Link to="/app/offers" className="btn btn-secondary btn-sm">
                Browse Offers
              </Link>
            </div>
          </div>
        ) : (
          <div className="loans-table-wrap">
            <table className="loans-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Role</th>
                  <th>Position NFT</th>
                  <th>Principal</th>
                  <th>Rate (APR)</th>
                  <th>Duration</th>
                  <th>LTV</th>
                  <th>HF</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagedLoans.map((loan) => (
                  <tr key={loan.id.toString()}>
                    <td>#{loan.id.toString()}</td>
                    <td>
                      <span className={`status-badge ${loan.role}`}>
                        {loan.role === 'lender' ? 'Lender' : 'Borrower'}
                      </span>
                    </td>
                    <td className="mono">
                      <Link
                        to={`/app/nft-verifier?id=${(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}`}
                        data-tooltip="Verify on-chain metadata"
                        style={{ color: 'var(--brand)' }}
                      >
                        #{(loan.role === 'lender' ? loan.lenderTokenId : loan.borrowerTokenId).toString()}
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
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              total={loans.length}
              pageSize={LOANS_PAGE_SIZE}
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
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
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
}: VPFIPanelProps) {
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
          <div className="card-title" style={{ marginBottom: 0 }}>VPFI Token (this chain)</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span
            className="status-badge"
            style={{ background: 'rgba(148, 163, 184, 0.12)', color: 'var(--text-tertiary)' }}
          >
            {networkName} · chainId {networkChainId}
          </span>
          <span
            className="status-badge"
            data-tooltip={
              isCanonicalVPFI
                ? 'Canonical chain — VPFIToken + OFT Adapter live here (lock/release on bridge).'
                : 'Mirror chain — VPFI supply here is minted/burned by the OFT on bridge.'
            }
            style={{
              background: isCanonicalVPFI
                ? 'rgba(79, 70, 229, 0.12)'
                : 'rgba(16, 185, 129, 0.12)',
              color: isCanonicalVPFI ? 'var(--brand)' : 'var(--accent-green)',
            }}
          >
            {isCanonicalVPFI ? 'Canonical' : 'Mirror'}
          </span>
        </div>
      </div>

      {!registered ? (
        <div className="empty-state" style={{ padding: '16px 0' }}>
          <p style={{ margin: 0 }}>
            VPFI is not yet registered with the Diamond on {networkName}. Once
            the admin calls <span className="mono">setVPFIToken</span>, balances
            and activity will appear here.
          </p>
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
              <div className="stat-label">Wallet VPFI balance</div>
            </div>
            <div>
              <div
                className="stat-value"
                data-tooltip="VPFI currently staked in your per-user escrow on this chain. Counts toward the borrower fee discount tier."
                data-tooltip-placement="below-start"
              >
                {escrowVpfiWei == null
                  ? '—'
                  : formatVpfi(formatVpfiUnits(escrowVpfiWei))}
              </div>
              <div className="stat-label">Escrow VPFI balance</div>
            </div>
            <div>
              <div className="stat-value">{(shareOfCirculating * 100).toFixed(2)}%</div>
              <div className="stat-label">Share of circulating</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.totalSupply) : '—'}</div>
              <div className="stat-label">Circulating (this chain)</div>
            </div>
            <div>
              <div className="stat-value">{vpfi ? formatVpfi(vpfi.capHeadroom) : '—'}</div>
              <div className="stat-label">Remaining mintable</div>
            </div>
          </div>

          <div className="data-row">
            <span className="data-label">Token</span>
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
            <span className="data-label">Authorized minter</span>
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
              <span className="data-label">Treasury (mint destination)</span>
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
              Your VPFI activity
            </div>
            {recentTransfers.length === 0 ? (
              <p className="stat-label" style={{ margin: 0 }}>
                No VPFI transfers touch this wallet on {networkName} yet.
                User-facing distributions (rewards, staking) arrive in a later
                rollout phase.
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
