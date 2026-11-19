import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import { refusalText } from '../desk/matchBand';
import { useCopy } from '../copy/useCopy';
import { networkKeeper } from '../keepers/keepers';
import type { StoredOffer } from '../offers/acceptTerms';
import type { IntentSummary } from '../offers/intents';
import { indexReason } from '../offers/OfferBook';
import { worldKey } from '../reads/identityKey';
import { useOwnRead } from '../reads/useOwnRead';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatBps } from '../ui/format';
import {
  intentRefusalText,
  intentGapOf,
  readIntentNearest,
  readWhyIntent,
  riskBlockText,
  verdictOk,
  whyIntentOf,
  type IntentGap,
  type SlotRequest,
  type WhyIntent,
} from './whyIntent';

type Hex = `0x${string}`;

/** How often the index ranking is asked again while the panel is open. */
const NEAREST_POLL_MS = 60_000;

/**
 * #3660 — on an active Auto-lend with money waiting, behind a tap: the open
 * borrow requests on its pair closest to its terms (from the index) and,
 * for those, the protocol's own preview of a fill from this Auto-lend, read
 * at one block. It states one gap, the closest open request's first
 * refusal, or that a fill would be taken now, or that no request stands on
 * the pair. Nothing is read until it is opened, and it never promises a
 * fill.
 */
export function WhyIntentPanel({ intent, chain, own }: { intent: IntentSummary; chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const [open, setOpen] = useState(false);
  const world = useWorldRail();
  const diamond = chain.diamondAddress as Hex;
  const sameChain = world.chainId === chain.chainId;
  const i = intent;
  const keeper = networkKeeper(chain.chainId);
  const solver = keeper ?? own.account;
  const terms = [i.minRateBps, i.maxDurationDays, i.availableCapital, i.maxExposure, i.livePrincipal].map(String).join(',');
  const index = useQuery({
    queryKey: worldKey(world.chainId, 'intentNearest', i.owner.toLowerCase(), i.lendingAsset.toLowerCase(), i.collateralAsset.toLowerCase(), String(i.slot), terms),
    queryFn: () => readIntentNearest(world.indexer, world.chainId, i),
    enabled: open && sameChain && world.indexer.origin !== null,
    refetchInterval: NEAREST_POLL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const ids = index.data?.ids ?? [];
  const chainRead = useOwnRead(
    ['whyIntent', diamond, i.lendingAsset.toLowerCase(), i.collateralAsset.toLowerCase(), String(i.slot), terms, ids.map(String).join(',')],
    (c) => readWhyIntent(c, diamond, i, ids, solver),
    { enabled: open && index.data !== undefined && ids.length > 0 },
  );
  const why: WhyIntent | null = index.data === undefined ? null : ids.length === 0 ? { kind: 'none' } : chainRead.data ? whyIntentOf(i, index.data, chainRead.data) : null;
  const indexFailed = !sameChain || world.indexer.origin === null || index.status === 'error';

  return (
    <details className="autolend-why" data-testid="autolend-why" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary data-testid="autolend-why-open">{text('whyIntent.open')}</summary>
      {open && (
        <div>
          <p className="tier-b">{text('whyIntent.lead')}</p>
          {keeper === null && <p className="tier-a">{text('whyIntent.noService')}</p>}
          {indexFailed ? (
            <p className="tier-a notice-warn" data-testid="autolend-why-index-failed">
              {format('whyIntent.indexFailed', { reason: !sameChain || world.indexer.origin === null ? text('offerBook.noIndex') : indexReason(index.error, text) })}
            </p>
          ) : chainRead.state === 'failed' && why === null ? (
            <p className="tier-a notice-warn" data-testid="autolend-why-chain-failed">
              {format('whyIntent.chainFailed', { reason: chainRead.error ?? '' })}
            </p>
          ) : why === null ? (
            <p className="tier-b">{text('whyIntent.reading')}</p>
          ) : (
            <>
              <p className="tier-a" data-testid="autolend-why-verdict" data-why={why.kind}>
                <WhyLine why={why} />
              </p>
              {why.kind === 'gap' && why.closerUnknown > 0 && <p className="tier-a notice-warn">{format('whyIntent.closerUnknown', { count: String(why.closerUnknown) })}</p>}
              {index.data !== undefined && index.data.oppositeOpen > 0 && (
                <p className="tier-b" data-testid="autolend-why-standing">
                  {format('whyIntent.standing', { count: String(index.data.oppositeOpen) })}
                </p>
              )}
              {chainRead.data && chainRead.data.requests.length > 0 && (
                <details data-testid="autolend-why-closest">
                  <summary>{text('whyIntent.closestTitle')}</summary>
                  <ul className="rows">
                    {chainRead.data.requests.map((r) => (
                      <li key={r.offer.id.toString()}>
                        <Link to={`/offers/${r.offer.id.toString()}`}>{format('offerPage.title', { id: r.offer.id.toString() })}</Link>
                        {': '}
                        {rangeOf(r.offer)}% · {format('offerPage.days', { days: r.offer.durationDays.toString() })} · <RowVerdict r={r} intent={i} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {why.kind === 'gap' && (why.gap.kind === 'rate' || why.gap.kind === 'term') && <p className="tier-b">{text('whyIntent.changeHint')}</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function rangeOf(o: StoredOffer): string {
  const max = o.interestRateBpsMax > o.interestRateBps ? o.interestRateBpsMax : o.interestRateBps;
  return max > o.interestRateBps ? `${formatBps(o.interestRateBps)}–${formatBps(max)}` : formatBps(o.interestRateBps);
}

function RowVerdict({ r, intent }: { r: SlotRequest; intent: IntentSummary }) {
  const copy = useCopy();
  if (r.state !== 'open') return <>{copy.text('whyIntent.closestEnded')}</>;
  if (r.verdict === null) return <>{copy.text('whyIntent.closestUnasked')}</>;
  if (verdictOk(r.verdict)) return <>{copy.text('whyIntent.closestFill')}</>;
  return <GapText gap={intentGapOf(intent, r.offer, r.verdict)} id={r.offer.id} bare />;
}

function WhyLine({ why }: { why: WhyIntent }) {
  const { text, format } = useCopy();
  switch (why.kind) {
    case 'none':
      return <>{text('whyIntent.none')}</>;
    case 'unread':
      return <>{text('whyIntent.unread')}</>;
    case 'fillable':
      return <>{format('whyIntent.fillable', { id: why.with.offer.id.toString(), rate: formatBps(why.with.verdict?.matchRateBps ?? 0n) })}</>;
    case 'gap':
      return <GapText gap={why.gap} id={why.with.offer.id} />;
  }
}

/** A gap in words. `bare` drops the request's number, for the list rows. */
function GapText({ gap, id, bare = false }: { gap: IntentGap; id: bigint; bare?: boolean }) {
  const copy = useCopy();
  const { format } = copy;
  switch (gap.kind) {
    case 'rate':
      return <>{format('whyIntent.rate', { theirs: formatBps(gap.theirs), mine: formatBps(gap.mine) })}</>;
    case 'term':
      return <>{format('whyIntent.term', { theirs: gap.theirs.toString(), mine: String(gap.mine) })}</>;
    default: {
      const reason = gap.kind === 'intent' ? intentRefusalText(gap.code, copy) : gap.kind === 'match' ? refusalText(gap.code, copy) : riskBlockText(gap.code, copy);
      return <>{bare ? reason : format('whyIntent.code', { id: id.toString(), reason })}</>;
    }
  }
}
