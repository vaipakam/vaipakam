import type { ReactNode } from 'react';
import { useCopy } from '../copy/useCopy';
import { useMode } from '../../app/ModeContext';
import { useOwnRead } from '../reads/useOwnRead';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';
import { readLenderIntents, standingReady } from './intents';

type Hex = `0x${string}`;

/**
 * #3319 — the lenders standing ready for the pair, beside the way to set your
 * own rate: how many, the most one of them can lend, and the lowest rate any
 * of them accepts, read from the protocol's list of active lender intents.
 * It always says that a matching service fills a request against them only
 * when its terms fit a lender's limits, so a fill is likely but neither
 * instant nor guaranteed (RB-FUNDS).
 */
export function StandingLenders({ diamond, lending, collateral, meta }: { diamond: Hex; lending: Hex; collateral: Hex; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const { isAdvanced } = useMode();
  const read = useOwnRead(['borrow', 'intents', diamond.toLowerCase()], (c) => readLenderIntents(c, diamond));
  const partial = read.data !== null && BigInt(read.data.scanned) < read.data.total;
  const ready = read.data ? standingReady(read.data.intents, lending, collateral) : null;

  let body: ReactNode;
  if (read.data === null) {
    body =
      read.state === 'failed' ? (
        <p className="tier-b">{format('borrow.standingFailed', { reason: read.error ?? 'no answer' })}</p>
      ) : (
        <p className="tier-b">{text('borrow.standingReading')}</p>
      );
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
        <p className="tier-b">{text('borrow.standingFill')}</p>
        {isAdvanced && <p className="tier-b">{format('borrow.standingLimits', { days: String(ready.maxDays), ltv: formatBps(BigInt(ready.maxLtvBps)) })}</p>}
        {partial && <p className="tier-b">{format('borrow.standingPart', { shown: String(read.data.scanned), total: read.data.total.toString() })}</p>}
      </>
    );
  }
  return (
    <div className="standing-lenders" data-testid="standing-lenders">
      {body}
    </div>
  );
}
