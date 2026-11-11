import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConfig } from 'wagmi';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../../shared/copy/useCopy';
import {
  cancelCall,
  lapseText,
  measureSignedCancel,
  orderSentence,
  readSignedCancelReview,
  signedCancelBlockers,
  signedCancelChanged,
  signedCancelReceipt,
  targetKey,
  type CancelTarget,
  type SignedCancelReview,
} from '../../shared/desk/cancelSigned';
import { marketKey } from '../../shared/desk/markets';
import { readMySignedOrders, readSignedStandings, sharedNonces, SIGNED_OFFER, type SignedMarket, type SignedStanding } from '../../shared/desk/mySignedOrders';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { indexReason } from '../../shared/offers/OfferBook';
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
import { shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

/** How often the viewer's own signed orders are read from the book. */
const SIGNED_POLL_MS = 30_000;

const STANDING_KEY: Readonly<
  Record<SignedStanding, 'signedOrders.open' | 'signedOrders.used' | 'signedOrders.nonceDone' | 'signedOrders.lapsed' | 'signedOrders.unread'>
> = {
  open: 'signedOrders.open',
  used: 'signedOrders.used',
  'nonce-cancelled': 'signedOrders.nonceDone',
  lapsed: 'signedOrders.lapsed',
  unread: 'signedOrders.unread',
};

/** The store key a market's open cancel lives under, so the panel keeps it
 *  on screen until the reader closes the finish card. */
function openKey(market: SignedMarket): string {
  return `desk.signedCancel.open:${marketKey(market)}`;
}

/**
 * OFF-61 — the viewer's own signed orders on the market the desk shows,
 * from the offer book scoped to them as signer, each with where the chain
 * stands on it now, and the on-chain cancel: of one order, or of every
 * order under one nonce when the book lists several open ones under it.
 * The panel says, before anything is offered, that the on-chain cancel is
 * the only way to stop a signed order: taking one off the book alone would
 * not, and nothing was set aside for one, so a cancel returns nothing.
 */
export function MySignedOrders({
  market,
  chain,
  own,
  meta,
  copy,
}: {
  market: SignedMarket;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const world = useWorldRail();
  const viewer = own.account;
  const noIndex = world.indexer.origin === null;
  const key = marketKey(market);
  const book = useQuery({
    queryKey: worldKey(world.chainId, 'mySignedOrders', key, viewer.toLowerCase()),
    queryFn: () => readMySignedOrders(world.indexer, world.chainId, market, viewer),
    enabled: !noIndex,
    refetchInterval: SIGNED_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: SIGNED_POLL_MS / 2,
    retry: 1,
  });
  const orders = book.data?.orders ?? [];
  const hashes = orders.map((o) => o.orderHash);
  const standing = useOwnRead(['signedStandings', chain.diamondAddress, ...hashes], (c) => readSignedStandings(c, chain.diamondAddress, orders), {
    enabled: orders.length > 0,
    perBlock: true,
  });
  const [open, setOpen] = useStoredValue<CancelTarget>(openKey(market));
  const amount = (asset: Hex, v: bigint, exact = false) => tokenAmount(v, asset, meta, format, exact);
  const standings = standing.data?.standings ?? new Map<Hex, SignedStanding>();
  const groups = sharedNonces(orders, standings);
  const failed = noIndex || book.status === 'error';
  // Where the open cancel shows: under its own row while the book lists the
  // order (or under the nonce's group while it holds two open orders), else
  // on its own, so a cancel in flight never vanishes with its row.
  const listedHere = (t: CancelTarget) =>
    book.data !== undefined && (t.kind === 'order' ? orders.some((o) => o.orderHash === t.order.orderHash) : groups.has(t.nonce));

  return (
    <section className="home-section" aria-labelledby="desk-signed-title" data-testid="desk-signed" data-market={key}>
      <h2 id="desk-signed-title">{text('signedOrders.title')}</h2>
      <p className="tier-b">{text('signedOrders.lead')}</p>
      <p className="tier-a" data-testid="desk-signed-only-way">
        {text('signedOrders.onlyWay')}
      </p>
      {failed && (
        <p className="tier-a" data-testid="desk-signed-failed">
          {format(book.data ? 'signedOrders.failedCached' : 'signedOrders.failed', {
            reason: noIndex ? text('offerBook.noIndex') : indexReason(book.error, text),
          })}
        </p>
      )}
      {!failed && book.data === undefined && <p className="tier-b">{text('signedOrders.reading')}</p>}
      {book.data !== undefined && (
        <>
          {orders.length === 0 && book.data.unread === 0 && (
            <p className="tier-b home-empty" data-testid="desk-signed-none">
              {text('signedOrders.none')}
            </p>
          )}
          {book.data.unread > 0 && <p className="tier-a">{format('signedOrders.unreadRows', { count: String(book.data.unread) })}</p>}
          {book.data.truncated && <p className="tier-a">{text('signedOrders.truncated')}</p>}
          {standing.state === 'failed' && <p className="tier-a">{format('signedOrders.standingFailed', { reason: standing.error ?? '' })}</p>}
          {orders.length > 0 && (
            <ul className="offer-rows">
              {orders.map((o) => {
                const s = standings.get(o.orderHash) ?? 'unread';
                const target: CancelTarget = { kind: 'order', order: o };
                const shown = open !== null && targetKey(open) === targetKey(target);
                return (
                  <li key={o.orderHash} data-testid="desk-signed-order" data-order-hash={o.orderHash} data-standing={s}>
                    <p>{orderSentence(o.order, amount, copy)}</p>
                    <p className="tier-b">
                      {lapseText(o.order, copy)} {text(STANDING_KEY[s])}
                    </p>
                    {s === 'open' && open === null && (
                      <button type="button" className="btn" onClick={() => setOpen(target)} data-testid="desk-signed-cancel">
                        {text('signedOrders.cancel')}
                      </button>
                    )}
                    {shown && listedHere(open) && <CancelSigned target={open} chain={chain} own={own} meta={meta} copy={copy} onClose={() => setOpen(null)} />}
                  </li>
                );
              })}
            </ul>
          )}
          {[...groups].map(([nonce, list]) => {
            const target: CancelTarget = { kind: 'nonce', nonce, orders: list };
            const shown = open !== null && targetKey(open) === targetKey(target);
            return (
              <div key={nonce} className="tier-b" data-testid="desk-signed-nonce" data-nonce={nonce}>
                <p>{format('signedOrders.sharedNonce', { count: String(list.length) })}</p>
                {open === null && (
                  <button type="button" className="btn" onClick={() => setOpen(target)} data-testid="desk-signed-cancel-nonce">
                    {text('signedOrders.cancelNonce')}
                  </button>
                )}
                {shown && <CancelSigned target={open} chain={chain} own={own} meta={meta} copy={copy} onClose={() => setOpen(null)} />}
              </div>
            );
          })}
        </>
      )}
      {open !== null && !listedHere(open) && (
        // A cancel in flight or on its finish card outlives the row the book
        // (or the chain) no longer lists as open.
        <CancelSigned target={open} chain={chain} own={own} meta={meta} copy={copy} onClose={() => setOpen(null)} />
      )}
      <WhyLink summaryKey="signedOrders.whySummary" detailKey="signedOrders.why" />
    </section>
  );
}

/** One cancel: the review, the protocol's dry run, the send and the
 *  outcome measured from the transaction's logs. Nothing leaves the wallet
 *  and no approval is asked. */
function CancelSigned({
  target,
  chain,
  own,
  meta,
  copy,
  onClose,
}: {
  target: CancelTarget;
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
  const flowKey = `desk.signedCancel.${targetKey(target)}`;
  const [review, setReview] = useStoredValue<SignedCancelReview>(`${flowKey}:review`);
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
      if (!review) throw new Error('no cancel under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'SignedCancelStopped', reason, reopensAt: null, remedy: null });
      };
      const call = cancelCall(review.target);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: SIGNED_OFFER, ...call, account: viewer }));
      if (dry.kind === 'reverted') return stop(format('signedCancel.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('signedCancel.stepSend') }));
      return sendWrite(config, { address: diamond, abi: SIGNED_OFFER, ...call, chainId: chain.chainId, account: viewer });
    },
    measure: async (receipt) => {
      // The book follows the chain on its own scan; asking again now shows
      // the order gone as soon as the book has seen the cancel.
      void queryClient.invalidateQueries({ queryKey: worldKey(world.chainId, 'mySignedOrders') });
      return review ? measureSignedCancel(review, receipt.logs, diamond, viewer, copy) : [];
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readSignedCancelReview(own, diamond, target, who, copy);
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
  const onReview = tx.phase.kind === 'review' && review !== null && targetKey(review.target) === targetKey(target);
  useReviewRefresh<SignedCancelReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => targetKey(a.target) === targetKey(b.target),
    changed: (before, next) => signedCancelChanged(before, next, copy) !== null,
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
    if (review === null || targetKey(review.target) !== targetKey(target) || review.identity !== identity) {
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
    // Opened once per target; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowKey]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: SignedCancelReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = signedCancelChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = signedCancelBlockers(next, viewer, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'SignedCancelBlocked',
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? signedCancelBlockers(review, viewer, copy) : [];
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
    <div className="repay-loan" data-testid="desk-signed-cancel-panel" data-held={holdsFlow(entry.phase) ? 'yes' : 'no'}>
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
        receipt={review ? signedCancelReceipt(review, amount, copy) : null}
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
