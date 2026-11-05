import { useCopy } from '../copy/useCopy';
import type { Freshness } from '../reads/world/ingestHealth';
import type { PushState } from '../reads/world/pushRail';
import { formatAge } from './format';
import { Notice } from './Notice';

/**
 * The world rail's stamp (RB-RAILS): every world figure carries its block
 * and age; a stale index is a tier-A notice, an unreadable one a degraded-
 * source warning that says figures are unavailable, not empty; and the
 * push rail's own state is named, so a quiet rail is told from a stalled
 * one.
 */
export function FreshnessStamp({ freshness, push, onRefresh }: { freshness: Freshness; push: PushState; onRefresh: () => void }) {
  const { text, format } = useCopy();
  const pushLine =
    push === 'live' ? text('rail.pushLive') : push === 'off' ? text('rail.pushOff') : push === 'connecting' ? text('rail.pushConnecting') : text('rail.pushUnavailable');
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
