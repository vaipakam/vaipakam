import type { ReactNode } from 'react';
import { useCopy } from '../copy/useCopy';
import { useMode } from '../../app/ModeContext';
import { useOwnRead } from '../reads/useOwnRead';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';
import { intentMatching, intentRequestBlock, readLenderIntents, standingReady, type IntentRequestTerms } from './intents';

type Hex = `0x${string}`;

/**
 * #3319 — the lenders standing ready for the pair, beside the way to set your
 * own rate: how many, the most one of them can lend, and the lowest rate any
 * of them accepts, read from the protocol's list of active lender intents.
 * It always says that a matching service fills a request against them only
 * when its terms fit a lender's limits, so a fill is likely but neither
 * instant nor guaranteed (RB-FUNDS). That claim needs the network's
 * matching switch and standing-intent switch on: with either off it says no
 * request is filled against them, and with either unread it says that is not
 * known. A failed re-read keeps the last answer and says it may have changed.
 * The reader's own intents are never counted, since the protocol refuses a
 * match with oneself. Before a request is typed it states the terms every
 * intent fill requires (the full term's interest, no partial repayment); in
 * the request form, terms that rule every intent out say so instead of the
 * likely fill.
 */
export function StandingLenders({
  diamond,
  lending,
  collateral,
  meta,
  account,
  request,
}: {
  diamond: Hex;
  lending: Hex;
  collateral: Hex;
  meta: TokenMetaMap | null;
  account: Hex | null;
  /** The request's terms as typed, in the request form; absent beside the way. */
  request?: IntentRequestTerms;
}) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const read = useOwnRead(['borrow', 'intents', diamond.toLowerCase()], (c) => readLenderIntents(c, diamond));
  const partial = read.data !== null && BigInt(read.data.scanned) < read.data.total;
  const ready = read.data ? standingReady(read.data.intents, lending, collateral, account) : null;
  const matching = read.data ? intentMatching(read.data.switches) : 'unknown';
  const stale = read.data !== null && read.error !== null;
  const blocked = request ? intentRequestBlock(request) : null;

  let body: ReactNode;
  if (read.data === null) {
    body =
      read.state === 'failed' ? (
        <p className="tier-b">{format('borrow.standingFailed', { reason: read.error ?? 'no answer' })}</p>
      ) : (
        <p className="tier-b">{text('borrow.standingReading')}</p>
      );
  } else if (matching === 'off') {
    body = <p className="tier-a">{text('borrow.standingOff')}</p>;
  } else if (ready === null) {
    body = (
      <p className="tier-b">
        {partial ? format('borrow.standingNonePart', { shown: String(read.data.scanned), total: read.data.total.toString() }) : text('borrow.standingNone')}
      </p>
    );
  } else {
    body = (
      <>
        <p className="tier-b" data-testid="standing-ready">
          {format(ready.lenders === 1 ? 'borrow.standingOne' : 'borrow.standingMany', {
            count: String(ready.lenders),
            amount: tokenAmount(ready.largest, lending, meta, format),
            rate: formatBps(ready.minRateBps),
          })}
        </p>
        {blocked !== null ? (
          <p className="tier-a" data-testid="standing-blocked">
            {text(blocked === 'pro-rata' ? 'borrow.standingBlockedProRata' : 'borrow.standingBlockedPartial')}
          </p>
        ) : matching === 'on' ? (
          <p className="tier-b">{text('borrow.standingFill')}</p>
        ) : (
          <p className="tier-a">{text('borrow.standingFillUnknown')}</p>
        )}
        {request === undefined && <p className="tier-b">{text('borrow.standingTerms')}</p>}
        {isAdvanced && <p className="tier-b">{format('borrow.standingLimits', { days: String(ready.maxDays), ltv: formatBps(BigInt(ready.maxLtvBps)) })}</p>}
        {partial && <p className="tier-b">{format('borrow.standingPart', { shown: String(read.data.scanned), total: read.data.total.toString() })}</p>}
      </>
    );
  }
  return (
    <div className="standing-lenders" data-testid="standing-lenders">
      {body}
      {stale && <p className="tier-a">{format('borrow.standingStale', { reason: read.error ?? 'no answer' })}</p>}
    </div>
  );
}
