import type { ReactNode } from 'react';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { useMode } from '../../app/ModeContext';
import { useOwnRead } from '../reads/useOwnRead';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';
import {
  intentMatching,
  intentRequestBlock,
  readLenderIntents,
  standingReady,
  type IntentRequestBlock,
  type IntentRequestTerms,
  type StandingReady,
} from './intents';

type Hex = `0x${string}`;

const BLOCK_COPY: Readonly<Record<IntentRequestBlock, CopyKey>> = {
  'pro-rata': 'borrow.standingBlockedProRata',
  'partial-repay': 'borrow.standingBlockedPartial',
  'prepay-listing': 'borrow.standingBlockedListing',
  cadence: 'borrow.standingBlockedCadence',
};

/**
 * #3319 — the lenders standing ready for the pair, beside the way to set your
 * own rate: how many, the most one of them can lend, and the lowest rate any
 * of them accepts, read from the protocol's list of active lender intents.
 * It always says that a matching service fills a request against them only
 * when its terms fit a lender's limits, so a fill is likely but neither
 * instant nor guaranteed (RB-FUNDS). That claim needs the network's
 * matching switch and standing-intent switch on and its keepers running:
 * with either switch off it says no request is filled against them, with the
 * keepers paused it says the matching service fills none until they resume
 * though a lender or another filler still may, and with any of the three
 * unread it says that is not known. A failed re-read keeps the last answer and says it may have changed.
 * The reader's own intents are never counted, since the protocol refuses a
 * match with oneself. Lenders that let only fillers they have chosen fill
 * against them are stated apart, and the likely fill is never claimed for
 * them, since whether the matching service is among those fillers is not
 * read here. Before a request is typed it states the terms intent fills
 * take (full-term interest unless a lender opted into pro-rata, partial
 * repayment only with pro-rata, no interest schedule); in the request form
 * only the lenders whose terms take the request are counted, and terms that
 * rule every lender here out say so instead of the likely fill. The longest
 * term shown counts each lender's end date as of the reading.
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
  const opts = { exclude: account, unavailable: read.data?.pausedOwners };
  // With a request typed, only the lenders whose terms take it are counted
  // (#3619: pro-rata interest only from a lender who opted in).
  const fit = request === undefined ? opts : { ...opts, request };
  const at = read.data?.at ?? 0n;
  const any = read.data ? standingReady(read.data.intents, lending, collateral, at, opts) : null;
  const ready = read.data ? standingReady(read.data.intents, lending, collateral, at, fit) : null;
  const open = read.data ? standingReady(read.data.intents, lending, collateral, at, { ...fit, limited: false }) : null;
  const limited = read.data ? standingReady(read.data.intents, lending, collateral, at, { ...fit, limited: true }) : null;
  const figures = (r: StandingReady) => ({
    count: String(r.lenders),
    amount: tokenAmount(r.largest, lending, meta, format),
    rate: formatBps(r.minRateBps),
  });
  const matching = read.data ? intentMatching(read.data) : 'unknown';
  const stale = read.data !== null && read.error !== null;
  // Terms no intent takes, or, failing that, a pro-rata request none of the
  // lenders here opted into.
  const blocked = request ? (intentRequestBlock(request) ?? (ready === null ? 'pro-rata' : null)) : null;

  let body: ReactNode;
  if (read.data === null) {
    body =
      read.state === 'failed' ? (
        <p className="tier-b">{format('borrow.standingFailed', { reason: read.error ?? 'no answer' })}</p>
      ) : (
        <p className="tier-b">{text('borrow.standingReading')}</p>
      );
  } else if (matching === 'halted') {
    body = (
      <p className="tier-a" data-testid="standing-halted">
        {text('borrow.standingHalted')}
      </p>
    );
  } else if (matching === 'off') {
    body = <p className="tier-a">{text('borrow.standingOff')}</p>;
  } else if (any === null) {
    body = (
      <p className="tier-b">
        {partial ? format('borrow.standingNonePart', { shown: String(read.data.scanned), total: read.data.total.toString() }) : text('borrow.standingNone')}
      </p>
    );
  } else {
    body = (
      <>
        {open !== null && (
          <p className="tier-b" data-testid="standing-ready">
            {format(open.lenders === 1 ? 'borrow.standingOne' : 'borrow.standingMany', figures(open))}
          </p>
        )}
        {limited !== null && (
          <p className="tier-a" data-testid="standing-limited">
            {format(
              open === null
                ? limited.lenders === 1
                  ? 'borrow.standingLimitedOne'
                  : 'borrow.standingLimitedMany'
                : limited.lenders === 1
                  ? 'borrow.standingAlsoLimitedOne'
                  : 'borrow.standingAlsoLimitedMany',
              figures(limited),
            )}
          </p>
        )}
        {blocked !== null ? (
          <p className="tier-a" data-testid="standing-blocked">
            {text(BLOCK_COPY[blocked])}
          </p>
        ) : matching === 'paused' ? (
          <p className="tier-a" data-testid="standing-paused">
            {text('borrow.standingPaused')}
          </p>
        ) : matching === 'unknown' ? (
          <p className="tier-a">{text('borrow.standingFillUnknown')}</p>
        ) : (
          // Switches on and keepers running: the likely fill is claimed only
          // for the lenders any filler may fill against.
          open !== null && <p className="tier-b">{text('borrow.standingFill')}</p>
        )}
        {request === undefined && <p className="tier-b">{text('borrow.standingTerms')}</p>}
        {isAdvanced && <p className="tier-b">{format('borrow.standingLimits', { days: String((ready ?? any).maxDays), ltv: formatBps(BigInt((ready ?? any).maxLtvBps)) })}</p>}
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
