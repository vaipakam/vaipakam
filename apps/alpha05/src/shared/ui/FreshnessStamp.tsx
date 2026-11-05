import { useCopy } from '../copy/useCopy';
import type { Freshness } from '../reads/world/ingestHealth';
import type { PushState } from '../reads/world/pushRail';
import { formatAge } from './format';
import { Notice } from './Notice';

/**
 * The world rail's stamp (RB-RAILS): every world figure carries its block
 * and age; a stale index is a tier-A notice, an unreadable one a degraded-
 * source warning that says figures are unavailable, not empty; a re-read
 * that failed after an earlier answer is a warning beside that last answer
 * (the figures shown are the last read, aged, never a fresh-looking stamp);
 * and the push rail's own state is named, so a quiet rail is told from a
 * stalled one.
 */
/** One line per rail state, so a quiet rail (live, nothing to announce) is
 *  told from one the indexer does not run for this chain and from one whose
 *  scan loop has stopped reporting. */
const PUSH_LINE: Record<PushState, 'rail.pushLive' | 'rail.pushOff' | 'rail.pushConnecting' | 'rail.pushInactive' | 'rail.pushStalled' | 'rail.pushUnavailable'> = {
  live: 'rail.pushLive',
  off: 'rail.pushOff',
  connecting: 'rail.pushConnecting',
  inactive: 'rail.pushInactive',
  stalled: 'rail.pushStalled',
  unavailable: 'rail.pushUnavailable',
  closed: 'rail.pushUnavailable',
};

export function FreshnessStamp({ freshness, push, onRefresh }: { freshness: Freshness; push: PushState; onRefresh: () => void }) {
  const { text, format } = useCopy();
  const pushLine = text(PUSH_LINE[push]);
  const refresh = (
    <button type="button" className="link" onClick={onRefresh}>
      {text('rail.refresh')}
    </button>
  );
  if (freshness.kind === 'unavailable') {
    return (
      <Notice tone="warn" tier="A">
        {format('rail.unavailable', { reason: freshness.reason })} {pushLine} {refresh}
      </Notice>
    );
  }
  if (freshness.kind === 'unknown') {
    return (
      <p className="tier-b stamp" role="status">
        {format('rail.unknown', { reason: freshness.reason })} {pushLine} {refresh}
      </p>
    );
  }
  const where = format('rail.at', { block: String(freshness.lastBlock), age: formatAge(freshness.ageSeconds) });
  if (freshness.refreshError !== null) {
    return (
      <Notice tone="warn" tier="A">
        {format('rail.refreshFailed', { reason: freshness.refreshError })} {where} {pushLine} {refresh}
      </Notice>
    );
  }
  if (freshness.kind === 'stale') {
    return (
      <Notice tone="warn" tier="A">
        {format('rail.stale', { age: formatAge(freshness.ageSeconds) })} {where} {pushLine} {refresh}
      </Notice>
    );
  }
  return (
    <p className="tier-b stamp" role="status">
      {where} {pushLine} {refresh}
    </p>
  );
}
