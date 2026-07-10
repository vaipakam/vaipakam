/**
 * History bottom tab (#1130 phase 2) — the wallet's PERMANENT desk
 * activity, from the indexer's historical-participant route
 * (`/loans/by-participant`).
 *
 * Deliberately different from the Positions tab on both axes:
 *  - ALL statuses, not just live — the whole point is that a lender
 *    whose loan was repaid + claimed (or whose position NFT moved on)
 *    drops out of every current-holder read but stays HERE.
 *  - Market-AGNOSTIC — this is the wallet's desk history, not the
 *    selected market's (the caption says so).
 */
import { History as HistoryIcon, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { useDeskHistory } from '../../data/desk';
import { useTokenMeta } from '../../contracts/erc20';
import { EmptyState, UnavailableState } from '../EmptyState';
import { loanStateView } from '../../lib/loanState';
import type { IndexedParticipantLoan } from '../../data/indexer';
import {
  formatBpsAsPercent,
  formatDate,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../../lib/format';

const text = copy.desk.history;

function HistoryRow({ loan }: { loan: IndexedParticipantLoan }) {
  const lendingMeta = useTokenMeta(loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);
  const state = loanStateView(loan);
  const pairLabel = `${lendingMeta.data?.symbol ?? shortAddress(loan.lendingAsset)} / ${
    collateralMeta.data?.symbol ?? shortAddress(loan.collateralAsset)
  }`;
  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {/* Position-id link convention — same target the Positions
              panel and alert deep links use. */}
          <Link to={`/positions/${loan.loanId}`}>Loan #{loan.loanId}</Link>{' '}
          · {pairLabel} · {formatDurationDays(loan.durationDays)} ·{' '}
          <span title={`${loan.interestRateBps} bps`}>
            {formatBpsAsPercent(loan.interestRateBps)}
          </span>
        </span>
        <br />
        <span className="row-sub">
          {lendingMeta.data
            ? `${formatTokenAmount(loan.principal, lendingMeta.data.decimals)} ${lendingMeta.data.symbol}`
            : '…'}{' '}
          · {text.started} {formatDate(loan.startAt)}
        </span>
      </span>
      <span className="cluster" style={{ gap: 6, alignItems: 'center' }}>
        {loan.roles.map((role) => (
          <span key={role} className="badge badge-info">
            {role === 'lender' ? text.roleLender : text.roleBorrower}
          </span>
        ))}
        <span className={`badge badge-${state.badge}`}>{state.label}</span>
      </span>
    </div>
  );
}

export function HistoryPanel() {
  const { address, isConnected } = useActiveChain();
  const history = useDeskHistory(address);

  if (!isConnected || address === undefined) {
    return <EmptyState icon={HistoryIcon} title={copy.wallet.connectFirst} />;
  }
  if (history.isLoading || history.rows === undefined) {
    return <EmptyState icon={LoaderCircle} title={text.loading} />;
  }
  if (history.rows === null) {
    return <UnavailableState body={text.unavailable} />;
  }
  return (
    <div>
      <p className="muted" style={{ marginBottom: 12 }}>
        {text.caption}
      </p>
      {history.rows.length === 0 ? (
        <EmptyState icon={HistoryIcon} title={text.empty} />
      ) : (
        <div className="row-list">
          {history.rows.map((l) => (
            <HistoryRow key={l.loanId} loan={l} />
          ))}
        </div>
      )}
      {history.hasMore ? (
        <p style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={history.isLoadingMore}
            onClick={history.loadMore}
          >
            {history.isLoadingMore ? text.loadingMore : text.loadMore}
          </button>
        </p>
      ) : null}
    </div>
  );
}
