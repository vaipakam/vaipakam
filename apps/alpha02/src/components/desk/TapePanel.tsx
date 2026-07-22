/**
 * Tape — recent executed fills for the (pair, tenor) market (#1129
 * §3). Server-scoped via `/loans/recent` with sale vehicles excluded
 * (a secondary position sale is not a fresh rate print). Sparse-
 * honest: an empty market says "no fills yet", never a fake ticker;
 * a failed load says "couldn't load", never "empty".
 */
import { LoaderCircle } from 'lucide-react';
import { copy } from '../../content/copy';
import { UnavailableState } from '../EmptyState';
import {
  formatBpsAsPercent,
  formatTimeAgo,
  formatTokenAmount,
} from '../../lib/format';
import type { IndexedLoan } from '../../data/indexer';

const MAX_ROWS = 20;

export function TapePanel({
  fills,
  loading,
  decimals,
  symbol,
}: {
  /** null = unavailable; [] = truly no fills. */
  fills: IndexedLoan[] | null | undefined;
  loading: boolean;
  decimals: number | undefined;
  symbol: string | undefined;
}) {
  return (
    <div className="card">
      <h2 className="card-title">{copy.desk.tapeTitle}</h2>
      {loading ? (
        <p className="muted cluster" style={{ alignItems: 'center', gap: 6 }}>
          <LoaderCircle size={14} className="spin" aria-hidden />{' '}
          {copy.desk.tapeLoading}
        </p>
      ) : fills === null || fills === undefined ? (
        <UnavailableState body={copy.desk.tapeUnavailable} />
      ) : fills.length === 0 ? (
        <p className="muted">{copy.desk.tapeEmpty}</p>
      ) : (
        <div className="desk-tape">
          {fills.slice(0, MAX_ROWS).map((f) => (
            <div
              key={f.loanId}
              className="desk-tape-row"
              title={copy.desk.tapeRowTitle(
                f.interestRateBps,
                f.loanId,
                copy.desk.loanStatus[f.status],
              )}
            >
              <span>{formatBpsAsPercent(f.interestRateBps)}</span>
              <span>
                {decimals !== undefined
                  ? formatTokenAmount(f.principal, decimals)
                  : '…'}
                {symbol ? ` ${symbol}` : ''}
              </span>
              <span className="muted">{formatTimeAgo(f.startAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
