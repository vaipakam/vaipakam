import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import { refusalText } from '../desk/matchBand';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { OFFER_TYPE_LENDER } from '../positions/model';
import { worldKey } from '../reads/identityKey';
import { useOwnRead } from '../reads/useOwnRead';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatAge, formatBps } from '../ui/format';
import { useNow } from '../ui/useNow';
import type { StoredOffer } from './acceptTerms';
import { useEditOfferHeld, type EditInput } from './EditOffer';
import { indexReason } from './OfferBook';
import { MATCH_CODE, readNearestIndex, readWhy, whyOf, type Counterparty, type Gap, type OptionGap, type Why } from './whyNotMatching';

type Hex = `0x${string}`;

/** How often the index ranking is asked again while the page is open. */
const NEAREST_POLL_MS = 60_000;

const OPTION_KEY: Record<OptionGap, CopyKey> = {
  'interest-mode': 'whyMatch.optionInterest',
  partial: 'whyMatch.optionPartial',
  prepay: 'whyMatch.optionPrepay',
  cadence: 'whyMatch.optionCadence',
};

/**
 * #3623 — on the page of an open token-for-token offer the reader posted:
 * the closest open offers on the other side of its pair (from the index)
 * and, for those, the protocol's own match preview, read at one block. It
 * states one gap, the first refusal of the closest open counterparty, or
 * that a pair would match now, or that nothing stands on the other side.
 * The list of closest offers sits behind a tap. It never promises a match.
 * A rate gap links to the offer's change, filled in with the rate that
 * closes it (#3659); a gap in the term or an option says those stay as
 * posted, so closing it means cancelling and posting again.
 */
export function WhyNotMatching({ offer, chain, own }: { offer: StoredOffer; chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const nowMs = useNow();
  const diamond = chain.diamondAddress as Hex;
  const sameChain = world.chainId === chain.chainId;
  const index = useQuery({
    queryKey: worldKey(world.chainId, 'offerNearest', offer.id.toString()),
    queryFn: () => readNearestIndex(world.indexer, world.chainId, offer.id),
    enabled: sameChain && world.indexer.origin !== null,
    refetchInterval: NEAREST_POLL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const ranked = index.data?.kind === 'ranked' ? index.data : null;
  const ids = ranked?.ids ?? [];
  // The verdict reads the reader's own offer at its own block; the terms in
  // the key make a change to them (seen by the page's offer read) ask again.
  const terms = [offer.interestRateBps, offer.interestRateBpsMax, offer.durationDays, offer.amount, offer.amountMax, offer.collateralAmount, offer.collateralAmountMax]
    .map(String)
    .join(',');
  const chainRead = useOwnRead(['whyMatch', diamond, offer.id.toString(), terms, ids.map(String).join(',')], (c) => readWhy(c, diamond, offer.id, ids, own.account), {
    // Read even with no counterparty: the matching switch is stated on its
    // own, since with matching off no counterparty ever opens a loan by match.
    enabled: ranked !== null,
  });
  const why: Why | null = ranked !== null && chainRead.data ? whyOf(ranked, chainRead.data) : null;
  // A refresh that failed behind a verdict already shown: the verdict stays,
  // marked with its age and the failure.
  const staleRead = chainRead.data !== null && chainRead.error !== null && chainRead.readAt !== null;
  const indexFailed = !sameChain || world.indexer.origin === null || index.status === 'error';

  return (
    <section className="home-section" aria-labelledby="why-match-title" data-testid="why-match" id="why-match">
      <h2 id="why-match-title">{text('whyMatch.title')}</h2>
      <p className="tier-b">{text('whyMatch.lead')}</p>
      {indexFailed ? (
        <p className="tier-a notice-warn" data-testid="why-match-index-failed">
          {format('whyMatch.indexFailed', { reason: !sameChain || world.indexer.origin === null ? text('offerBook.noIndex') : indexReason(index.error, text) })}
        </p>
      ) : index.data?.kind === 'ineligible' ? (
        <p className="tier-a" data-testid="why-match-not-listed">
          {text('whyMatch.notListed')}
        </p>
      ) : chainRead.state === 'failed' && why === null ? (
        <p className="tier-a notice-warn" data-testid="why-match-chain-failed">
          {format('whyMatch.chainFailed', { reason: chainRead.error ?? '' })}
        </p>
      ) : why === null ? (
        <p className="tier-b">{text('whyMatch.reading')}</p>
      ) : (
        <>
          <p className="tier-a" data-testid="why-match-verdict" data-why={why.kind}>
            <WhyLine why={why} mine={chainRead.data?.mine ?? offer} />
          </p>
          {why.kind === 'gap' && why.closerUnknown > 0 && (
            <p className="tier-a notice-warn" data-testid="why-match-closer-unknown">
              {format('whyMatch.closerUnknown', { count: String(why.closerUnknown) })}
            </p>
          )}
          {staleRead && (
            <p className="tier-a notice-warn" data-testid="why-match-stale">
              {format('whyMatch.stale', { reason: chainRead.error ?? '', age: formatAge(Math.max(0, Math.round((nowMs - (chainRead.readAt ?? 0)) / 1000))) })}
            </p>
          )}
          {ranked !== null && ranked.oppositeOpen > 0 && (
            <p className="tier-b" data-testid="why-match-standing">
              {format('whyMatch.standing', { count: String(ranked.oppositeOpen) })}
            </p>
          )}
          {chainRead.data && chainRead.data.counterparties.length > 0 && (
            <details data-testid="why-match-closest">
              <summary>{text('whyMatch.closestTitle')}</summary>
              <ul className="rows">
                {chainRead.data.counterparties.map((c) => (
                  <li key={c.offer.id.toString()} data-testid={`why-match-row-${c.offer.id.toString()}`}>
                    <Link to={`/offers/${c.offer.id.toString()}`}>{format('offerPage.title', { id: c.offer.id.toString() })}</Link>
                    {': '}
                    {rangeOf(c.offer)}% · {format('offerPage.days', { days: c.offer.durationDays.toString() })} · <RowVerdict c={c} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {why.kind === 'gap' && <GapAction gap={why.gap} offerId={offer.id} />}
        </>
      )}
    </section>
  );
}

function rangeOf(o: StoredOffer): string {
  const max = o.interestRateBpsMax > o.interestRateBps ? o.interestRateBpsMax : o.interestRateBps;
  return max > o.interestRateBps ? `${formatBps(o.interestRateBps)}–${formatBps(max)}` : formatBps(o.interestRateBps);
}

function RowVerdict({ c }: { c: Counterparty }) {
  const copy = useCopy();
  if (c.state !== 'open') return <>{copy.text('whyMatch.closestEnded')}</>;
  if (c.code === null) return <>{copy.text('whyMatch.closestUnasked')}</>;
  if (c.code === MATCH_CODE.ok) return <>{copy.text('whyMatch.closestMatch')}</>;
  return <>{refusalText(c.code, copy)}</>;
}

function WhyLine({ why, mine }: { why: Why; mine: StoredOffer }) {
  const copy = useCopy();
  const { text, format } = copy;
  switch (why.kind) {
    case 'none':
      return <>{text('whyMatch.none')}</>;
    case 'switch-off':
      return <>{text('whyMatch.switchOff')}</>;
    case 'switch-unread':
      return <>{text('whyMatch.switchUnread')}</>;
    case 'unread':
      return <>{text('whyMatch.unread')}</>;
    case 'matchable':
      return <>{format('whyMatch.matchable', { id: why.with.offer.id.toString(), rate: formatBps(why.with.matchRateBps ?? 0n) })}</>;
    case 'gap':
      return <GapLine gap={why.gap} id={why.with.offer.id} lend={mine.offerType === OFFER_TYPE_LENDER} />;
  }
}

function GapLine({ gap, id, lend }: { gap: Gap; id: bigint; lend: boolean }) {
  const copy = useCopy();
  const { text, format } = copy;
  switch (gap.kind) {
    case 'rate': {
      const key: CopyKey = lend ? (gap.theirsHigh ? 'whyMatch.rateLenderHigh' : 'whyMatch.rateLender') : gap.theirsHigh ? 'whyMatch.rateBorrower' : 'whyMatch.rateBorrowerLow';
      return <>{format(key, { theirs: formatBps(gap.theirs), mine: formatBps(gap.mine) })}</>;
    }
    case 'term': {
      const key: CopyKey = lend ? (gap.upTo ? 'whyMatch.termLenderUpTo' : 'whyMatch.termLender') : gap.upTo ? 'whyMatch.termBorrowerUpTo' : 'whyMatch.termBorrower';
      return <>{format(key, { theirs: gap.theirs.toString(), mine: gap.mine.toString() })}</>;
    }
    case 'option':
      return <>{text(OPTION_KEY[gap.which])}</>;
    case 'code':
      return <>{format('whyMatch.code', { id: id.toString(), reason: refusalText(gap.code, copy) })}</>;
  }
}

/** The figure that closes a rate gap: the bound of the reader's range on
 *  the counterparty's side moves to the counterparty's nearest bound. Every
 *  other bound stays, so the range stays well formed. */
export function ratePrefill(gap: Extract<Gap, { kind: 'rate' }>): EditInput {
  return gap.theirsHigh ? { rateMax: formatBps(gap.theirs) } : { rateMin: formatBps(gap.theirs) };
}

/** What the reader can do about the gap. */
function GapAction({ gap, offerId }: { gap: Gap; offerId: bigint }) {
  const { text, format } = useCopy();
  const edit = useEditOfferHeld(offerId);
  const open = (prefill?: EditInput) => {
    edit.open(prefill);
    // The change opens in the offer's action area below.
    requestAnimationFrame(() => document.getElementById('offer-edit')?.scrollIntoView({ block: 'start' }));
  };
  if (gap.kind === 'rate')
    return (
      <p className="actions">
        <button type="button" className="btn" onClick={() => open(ratePrefill(gap))} data-testid="why-match-change-rate">
          {format(gap.theirsHigh ? 'whyMatch.changeRateMax' : 'whyMatch.changeRateMin', { rate: formatBps(gap.theirs) })}
        </button>
      </p>
    );
  if (gap.kind === 'term' || gap.kind === 'option') return <p className="tier-b">{text(gap.kind === 'term' ? 'whyMatch.termFixed' : 'whyMatch.optionFixed')}</p>;
  return (
    <p className="actions">
      <button type="button" className="btn btn-link" onClick={() => open()} data-testid="why-match-change">
        {text('whyMatch.changeOffer')}
      </button>
    </p>
  );
}
