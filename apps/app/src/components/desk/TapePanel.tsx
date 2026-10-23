/**
 * Tape — recent executed fills for the (pair, tenor) market (#1129
 * §3). Each row shows the terms the loan was agreed at, never its live
 * terms; a term the indexer cannot confirm reads "not recorded" (#1142). Server-scoped via `/loans/recent` with sale vehicles excluded
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
import type { DeskTape } from '../../data/desk';

const MAX_ROWS = 20;

export function TapePanel({
  tape,
  loading,
  decimals,
  symbol,
}: {
  /** null = unavailable; empty `fills` = no placed fills. Executed terms
   *  only, beside the pair's loans no tenor holds (#1142). */
  tape: DeskTape | null | undefined;
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
      ) : tape === null || tape === undefined ? (
        <UnavailableState body={copy.desk.tapeUnavailable} />
      ) : tape.fills.length === 0 ? (
        // #1142 — with loans on the pair whose tenor is unknown, only "none
        // confirmed at this duration" is claimable.
        <p className="muted">
          {tape.unplaced.count > 0 ? copy.desk.tapeEmptyUnplaced : copy.desk.tapeEmpty}
        </p>
      ) : (
        <div className="desk-tape">
          {tape.fills.slice(0, MAX_ROWS).map((f) => (
            <div
              key={f.loanId}
              className="desk-tape-row"
              title={
                f.rateBps === null
                  ? copy.desk.fillTermsNotRecordedTitle(f.loanId)
                  : copy.desk.tapeRowTitle(f.rateBps, f.loanId, copy.desk.loanStatus[f.status])
              }
            >
              <span>
                {f.rateBps === null ? copy.desk.fillTermsNotRecorded : formatBpsAsPercent(f.rateBps)}
              </span>
              <span>
                {f.principal === null
                  ? copy.desk.fillTermsNotRecorded
                  : decimals !== undefined
                    ? `${formatTokenAmount(f.principal, decimals)}${symbol ? ` ${symbol}` : ''}`
                    : `…${symbol ? ` ${symbol}` : ''}`}
              </span>
              <span className="muted">{formatTimeAgo(f.startAt)}</span>
            </div>
          ))}
        </div>
      )}
      {tape != null && tape.unplaced.count > 0 ? (
        <p className="muted desk-chart-sparse-note" data-testid="desk-tape-unplaced">
          {tape.unplaced.capped
            ? copy.desk.tapeUnplacedNoteCapped(tape.unplaced.count)
            : copy.desk.tapeUnplacedNote(tape.unplaced.count)}
        </p>
      ) : null}
    </div>
  );
}
