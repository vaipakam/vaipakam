/**
 * Positions panel (#1129 §3) — the wallet's LIVE loan positions with
 * a health-factor badge, deep-linking into the existing manage flows
 * for repay / partial repay (phase 1 never rebuilds those here).
 *
 * Data source is `useMyLoansFull` — CURRENT-HOLDER based by design:
 * its chain leg enumerates the position NFTs the wallet holds right
 * now (`getUserPositionLoansPaginated`), so a bought or transferred
 * position follows its new holder; the indexer's by-* routes (the
 * fallback leg) are current-owner filtered too. Exactly the read the
 * design requires — never the historical-party dashboard walk.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, LoaderCircle } from 'lucide-react';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useMyLoansFull, type PositionLoan } from '../../data/hooks';
import { healthView, useLoanRisk } from '../../data/risk';
import { useTokenMeta } from '../../contracts/erc20';
import { EmptyState, UnavailableState } from '../EmptyState';
import { WindowedRowList } from '../../lib/visibleWindow';
import { AssetType } from '../../lib/types';
import {
  daysRemaining,
  formatBpsAsPercent,
  formatTokenAmount,
} from '../../lib/format';

const text = copy.desk.positions;

function HealthBadge({ loan }: { loan: PositionLoan }) {
  const risk = useLoanRisk(loan.loanId, loan.status === 'active');
  if (risk.data === undefined) {
    return (
      <span className="badge badge-neutral" title={text.health}>
        …
      </span>
    );
  }
  if (!risk.data.priced) {
    return (
      <span className="badge badge-neutral" title={copy.risk.notPriced}>
        {text.notPriced}
      </span>
    );
  }
  const view = healthView(risk.data);
  return (
    <span
      className={`badge badge-${view.badge}`}
      title={`Health factor ${view.ratio} · LTV ${view.ltvPct}`}
    >
      {view.label} · {view.ratio}
    </span>
  );
}

function PositionRow({ loan }: { loan: PositionLoan }) {
  const meta = useTokenMeta(loan.lendingAsset);
  const remaining = daysRemaining(loan.startTime, loan.durationDays);
  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {loan.role === 'borrower'
            ? copy.positions.roleBorrower
            : copy.positions.roleLender}{' '}
          {meta.data ? formatTokenAmount(loan.principal, meta.data.decimals) : '…'}{' '}
          {meta.data?.symbol ?? ''} ·{' '}
          <span title={`${loan.interestRateBps} bps`}>
            {formatBpsAsPercent(loan.interestRateBps)}
          </span>
        </span>
        <br />
        <span className="row-sub">
          Loan #{loan.loanId} ·{' '}
          {remaining >= 0 ? `${remaining}d left` : `${-remaining}d overdue`}
          {loan.allowsPartialRepay ? ' · partial repay OK' : ''}
        </span>
      </span>
      <span className="cluster" style={{ gap: 8, alignItems: 'center' }}>
        <HealthBadge loan={loan} />
        <Link to={`/positions/${loan.loanId}`} className="btn btn-secondary btn-sm">
          {text.manage}
        </Link>
      </span>
    </div>
  );
}

export function PositionsPanel() {
  const loans = useMyLoansFull();
  const { isConnected } = useActiveChain();

  // Desk scope: live ERC-20 loans (rentals and settled history stay
  // on My positions, linked below).
  const rows = useMemo(
    () =>
      loans.data?.rows.filter(
        (l) => l.status === 'active' && l.assetType === AssetType.ERC20,
      ) ?? null,
    [loans.data],
  );

  if (!isConnected) {
    return <EmptyState icon={ListChecks} title={copy.wallet.connectFirst} />;
  }
  if (loans.isLoading) {
    return <EmptyState icon={LoaderCircle} title="Loading your positions…" />;
  }
  if (loans.data == null || rows === null) {
    return <UnavailableState body={text.unavailable} />;
  }
  return (
    <div>
      {rows.length === 0 ? (
        <EmptyState icon={ListChecks} title={text.empty} />
      ) : (
        // #1247 PAG-008 — windowed: each row mounts token meta AND a
        // per-loan HF read (useLoanRisk); the reads must scale with
        // the page the user asked for, not the 500–2000 data caps.
        <WindowedRowList
          rows={rows}
          render={(l) => <PositionRow key={`${l.loanId}-${l.role}`} loan={l} />}
        />
      )}
      <p style={{ marginTop: 8 }}>
        <Link to="/positions" className="muted">
          {text.allPositions}
        </Link>
      </p>
    </div>
  );
}
