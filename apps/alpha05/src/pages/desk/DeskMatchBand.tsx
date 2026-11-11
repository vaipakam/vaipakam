import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig } from 'wagmi';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../../shared/copy/useCopy';
import {
  bandState,
  capacityText,
  MATCH,
  matchBlockers,
  matchChanged,
  matchReceipt,
  measureMatch,
  overlapPairs,
  pairKey,
  readMatchBand,
  readMatchReview,
  refusalText,
  shareText,
  type MatchPair,
  type MatchReview,
  type PairVerdict,
} from '../../shared/desk/matchBand';
import { marketKey, type DeskLadder } from '../../shared/desk/markets';
import type { SignedMarket } from '../../shared/desk/mySignedOrders';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { worldKey } from '../../shared/reads/identityKey';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { sendWrite } from '../../shared/tx/send';
import { askThrough } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../../shared/tx/txStore';
import { useMounted, useReviewRefresh } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';
import { formatBps, shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

/** The store key a market's open match lives under, so the panel stays on
 *  screen until the reader closes the finish card. */
function openKey(market: SignedMarket): string {
  return `desk.match.open:${marketKey(market)}`;
}

/**
 * OFF-63 — the match band under the desk's ladder. While the market's two
 * sides overlap, the best-priced overlapping pairs are asked of the
 * protocol's own match preview, as this wallet would send the match, and
 * the band offers the first pair it confirms, with the amount, the rate and
 * the collateral the loan would take, the most the sender's share can be,
 * and whose matching capacity the match counts against. With matching
 * switched off on the network the band says so instead of disappearing;
 * with no pair it can confirm, it says why the best-priced pair is refused.
 */
export function DeskMatchBand({
  ladder,
  market,
  chain,
  own,
  meta,
  copy,
}: {
  ladder: DeskLadder;
  market: SignedMarket;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const diamond = chain.diamondAddress;
  const found = overlapPairs(ladder);
  const { pairs, more } = found;
  const read = useOwnRead(['matchBand', diamond, ...pairs.map(pairKey)], (c) => readMatchBand(c, diamond, pairs, own.account));
  const [open, setOpen] = useStoredValue<MatchPair>(openKey(market));
  const amount = (asset: Hex, v: bigint, exact = false) => tokenAmount(v, asset, meta, format, exact);
  const stale = read.state === 'ready' && read.error !== null;
  // The read is keyed by the pairs, so a ladder that moved reads again; until
  // it answers, nothing older is shown as confirmed.
  const state = read.data !== null && read.data.verdicts.length === pairs.length ? bandState(found, read.data) : null;

  const terms = (p: MatchPair, v: PairVerdict) =>
    format('matchBand.terms', {
      amount: amount(p.ask.lendingAsset, v.amount),
      rate: formatBps(v.rateBps),
      days: p.ask.durationDays.toString(),
      collateral: amount(p.bid.collateralAsset, v.collateral),
    });
  const who = (creator: Hex) => (creator.toLowerCase() === own.account.toLowerCase() ? text('matchBand.you') : shortAddress(creator));
  const reason = (code: number | null) => (code === null ? text('matchBand.previewUnread') : refusalText(code, copy));

  return (
    <section className="home-section" aria-labelledby="desk-match-title" data-testid="desk-match" data-state={state?.kind ?? read.state}>
      <h2 id="desk-match-title">{text('matchBand.title')}</h2>
      <p className="tier-b">{text('matchBand.lead')}</p>
      {read.state === 'failed' && (
        <p className="tier-a" data-testid="desk-match-failed">
          {format('matchBand.readFailed', { reason: read.error ?? '' })}
        </p>
      )}
      {stale && <p className="tier-a">{format('matchBand.readStale', { reason: read.error ?? '' })}</p>}
      {state === null && read.state !== 'failed' && <p className="tier-b">{text('matchBand.reading')}</p>}
      {state?.kind === 'switch-unread' && <p className="tier-a">{text('matchBand.switchUnread')}</p>}
      {state?.kind === 'switch-off' && (
        <p className="tier-a" data-testid="desk-match-off">
          {text('matchBand.switchOff')}
        </p>
      )}
      {state?.kind === 'no-overlap' && (
        <p className="tier-b" data-testid="desk-match-none">
          {text('matchBand.noOverlap')}
        </p>
      )}
      {state?.kind === 'no-rate' && (
        <p className="tier-b" data-testid="desk-match-none">
          {text('matchBand.noRate')}
        </p>
      )}
      {state?.kind === 'none' && (
        <p className="tier-a" data-testid="desk-match-refused">
          {format('matchBand.none', { ask: state.pair.ask.id.toString(), bid: state.pair.bid.id.toString(), reason: reason(state.code) })}
        </p>
      )}
      {state?.kind === 'ready' && read.data !== null && (
        <div className="card" data-testid="desk-match-pair" data-pair={pairKey(state.pair)}>
          <p className="tier-b">{text('matchBand.ready')}</p>
          <p className="row-head">
            {format('matchBand.pair', {
              ask: state.pair.ask.id.toString(),
              bid: state.pair.bid.id.toString(),
              lender: who(state.pair.ask.creator),
              borrower: who(state.pair.bid.creator),
            })}
          </p>
          <p data-testid="desk-match-terms">{terms(state.pair, state.verdict)}</p>
          <p className="tier-b" data-testid="desk-match-share">
            {shareText(state.verdict.amount, state.pair.ask.lendingAsset, read.data.settings, amount, copy)}
          </p>
          <p className="tier-b" data-testid="desk-match-capacity">
            {capacityText(read.data.settings, copy)}
          </p>
          {state.top !== null && (
            <p className="tier-a">
              {format('matchBand.topRefused', { ask: state.top.pair.ask.id.toString(), bid: state.top.pair.bid.id.toString(), reason: reason(state.top.code) })}
            </p>
          )}
          {open === null && !stale && (
            <button type="button" className="btn" onClick={() => setOpen(state.pair)} data-testid="desk-match-open">
              {text('matchBand.open')}
            </button>
          )}
        </div>
      )}
      {more && state !== null && state.kind !== 'switch-off' && state.kind !== 'switch-unread' && (
        <p className="tier-a">{format('matchBand.more', { count: String(pairs.length) })}</p>
      )}
      {open !== null && <MatchOffers pair={open} chain={chain} own={own} meta={meta} copy={copy} onClose={() => setOpen(null)} />}
      <WhyLink summaryKey="matchBand.whySummary" detailKey="matchBand.why" />
    </section>
  );
}

/** One match: the review, the protocol's dry run, the send and the
 *  outcome measured from the transaction's logs. Nothing leaves the
 *  sender's wallet but the gas, and no approval is asked. */
function MatchOffers({
  pair,
  chain,
  own,
  meta,
  copy,
  onClose,
}: {
  pair: MatchPair;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  copy: CopyAccess;
  onClose: () => void;
}) {
  const { text, format } = copy;
  const config = useConfig();
  const queryClient = useQueryClient();
  const world = useWorldRail();
  const diamond = chain.diamondAddress;
  const viewer = own.account;
  const identity = reviewIdentity(own);
  const flowKey = `desk.match.${pairKey(pair)}`;
  const [review, setReview] = useStoredValue<MatchReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const entry = useTxEntry(flowKey);
  const amount = (asset: Hex, v: bigint, exact = false) => tokenAmount(v, asset, meta, format, exact);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account: viewer,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no match under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'MatchStopped', reason, reopensAt: null, remedy: null });
      };
      const call = { functionName: 'matchOffers', args: [pair.ask.id, pair.bid.id] } as const;
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: MATCH, ...call, account: viewer }));
      if (dry.kind === 'reverted') return stop(format('matchBand.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('matchBand.stepSend') }));
      return sendWrite(config, { address: diamond, abi: MATCH, ...call, chainId: chain.chainId, account: viewer });
    },
    measure: async (receipt) => {
      // The ladder follows the chain on the index's own scan; asking again
      // now shows the matched offers gone as soon as the index has seen it.
      void queryClient.invalidateQueries({ queryKey: worldKey(world.chainId, 'deskLadder') });
      return review ? measureMatch(review, receipt.logs, diamond, viewer, amount, copy) : [];
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readMatchReview(own, diamond, pair, who, copy);
  const load = async () => {
    try {
      const next = await read(identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && pairKey(review.pair) === pairKey(pair);
  useReviewRefresh<MatchReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => pairKey(a.pair) === pairKey(b.pair),
    changed: (before, next) => matchChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const opening = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!opening) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (review === null || pairKey(review.pair) !== pairKey(pair) || review.identity !== identity) {
      setReview(null);
      let live = true;
      read(identity).then(
        (next) => {
          if (!live) return;
          setLoadError(null);
          setReview(next);
        },
        (e: unknown) => {
          if (live) setLoadError(refusalFromError(e).reason);
        },
      );
      return () => {
        live = false;
      };
    }
    // Opened once per pair; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowKey]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: MatchReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = matchChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = matchBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'MatchBlocked',
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? matchBlockers(review, copy) : [];
  const gate = review
    ? {
        ready: blockers.length === 0,
        node: (
          <div className="repay-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="desk-match-panel" data-held={holdsFlow(entry.phase) ? 'yes' : 'no'}>
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      <ActionFlow
        tx={tx}
        publicQueue
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? matchReceipt(review, viewer, amount, copy) : null}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
