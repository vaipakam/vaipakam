import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { ReadState } from '../../shared/positions/PositionSections';
import {
  fallbackEndState,
  finishBlockers,
  finishCall,
  finishChanged,
  finishReceipt,
  measureFinish,
  readFallbackEnd,
  readFinishReview,
  type FallbackEnd,
  type FinishReview,
} from '../../shared/positions/fallbackEnd';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { sendWrite } from '../../shared/tx/send';
import { askThrough } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../../shared/tx/txStore';
import { useMounted, useReviewRefresh } from '../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';
import { formatSpan, formatUtc, shortAddress } from '../../shared/ui/format';
import { useNow } from '../../shared/ui/useNow';

type Hex = `0x${string}`;

/** The store key the finish on one loan keeps its state under. */
export function finishKey(loanId: bigint): string {
  return `position.fallbackFinish.${loanId.toString()}`;
}

/** Whether a finish on the loan is open or in flight: the page keeps the
 *  card through its outcome, though the loan has left fallback by then. */
export function useFallbackFinishHeld(loanId: bigint): boolean {
  const entry = useTxEntry(finishKey(loanId));
  const [open] = useStoredValue<boolean>(`${finishKey(loanId)}:open`);
  return open === true || holdsFlow(entry.phase);
}

interface FallbackEndCardProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  /** The collateral asset the recorded split is in. */
  collateralAsset: Hex;
  /** Whether the reader holds the lender position: the screen then says
   *  what a finish by anyone means for that side. */
  lender: boolean;
}

/**
 * #3865 — a loan in fallback: its dated end as the protocol reports it now,
 * what moves that date, and, once the protocol says it can be finished, the
 * step anyone may take to finish it in kind. The finish pays its caller
 * nothing; the page says so.
 */
export function FallbackEndCard({ loanId, chain, own, meta, collateralAsset, lender }: FallbackEndCardProps) {
  const { text } = useCopy();
  const diamond = chain.diamondAddress as Hex;
  const read = useOwnRead(['position', 'fallbackEnd', diamond, loanId.toString()], (c) => readFallbackEnd(c, diamond, loanId), { perBlock: true });
  const [, setOpen] = useStoredValue<boolean>(`${finishKey(loanId)}:open`);
  // A finish under way keeps its panel through its outcome, even once the
  // loan has left fallback and the date reads as none.
  const held = useFallbackFinishHeld(loanId);
  return (
    <section className="home-section position-facts" aria-labelledby="position-fallback-end" data-testid="position-fallback-end">
      <h2 id="position-fallback-end">{text('fallbackEnd.sectionTitle')}</h2>
      <ReadState read={read}>
        {(end) => <EndFacts end={end} lender={lender} canOpen={!held} onOpen={() => setOpen(true)} />}
      </ReadState>
      {held && <FinishFlow loanId={loanId} chain={chain} own={own} meta={meta} collateralAsset={collateralAsset} onClose={() => setOpen(null)} />}
    </section>
  );
}

function EndFacts({ end, lender, canOpen, onOpen }: { end: FallbackEnd; lender: boolean; canOpen: boolean; onOpen: () => void }) {
  const { text, format } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  const state = fallbackEndState(end, nowSec);
  if (state.kind === 'none')
    return (
      <p className="tier-a" data-testid="fallback-end-none">
        {text('fallbackEnd.none')}
      </p>
    );
  return (
    <div data-testid="fallback-end-facts" data-state={state.kind}>
      <p className="tier-b" data-testid="fallback-end-date">
        {format('fallbackEnd.date', { date: formatUtc(end.endAt) })}
      </p>
      <p className="tier-b">{format('fallbackEnd.entered', { date: formatUtc(end.enteredAt), wait: formatSpan(Number(end.waitSeconds)) })}</p>
      <p className="tier-a" data-testid="fallback-end-moves">
        {text('fallbackEnd.moves')}
      </p>
      {/* Security review: before the date, the lender is told what a finish
          by anyone does to that side. */}
      {lender && state.kind === 'waiting' && (
        <div data-testid="fallback-end-lender">
          <Notice tone="warn" tier="A">
            {text('fallbackEnd.lenderWarning')}
          </Notice>
        </div>
      )}
      {state.kind === 'held' && (
        <p className="tier-a" data-testid="fallback-end-held">
          {text('fallbackEnd.notFinishableNow')}
        </p>
      )}
      {state.kind === 'finishable' && (
        <>
          <p className="tier-a">{text('fallbackEnd.finishableNow')}</p>
          {canOpen && (
            <button type="button" className="btn" data-testid="fallback-finish-open" onClick={onOpen}>
              {text('fallbackEnd.finishButton')}
            </button>
          )}
        </>
      )}
      <WhyLink summaryKey="fallbackEnd.whySummary" detailKey="fallbackEnd.why" />
    </div>
  );
}

/** The finish: reviewed, sent only after the protocol's dry run passes, and
 *  measured from the transaction's own record. No approval, nothing leaves
 *  the wallet but gas. */
function FinishFlow({
  loanId,
  chain,
  own,
  meta,
  collateralAsset,
  onClose,
}: Omit<FallbackEndCardProps, 'lender'> & { onClose: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress as Hex;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = finishKey(loanId);
  const [review, setReview] = useStoredValue<FinishReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const amount = (v: bigint) => tokenAmount(v, collateralAsset, meta, format);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no finish under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'FallbackFinishStopped', reason, reopensAt: null, remedy: null });
      };
      const call = finishCall(loanId);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('fallbackEnd.stepSend') }));
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measureFinish(review, receipt.logs, diamond, amount, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readFinishReview(own, diamond, loanId, who);
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
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId;
  useReviewRefresh<FinishReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.loanId === b.loanId,
    changed: (before, next) => finishChanged(before, next, copy) !== null,
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
    if (review === null || review.loanId !== loanId || review.identity !== identity) {
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
    // Opened once per loan; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: FinishReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = finishChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = finishBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'FallbackNotFinishable', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? finishBlockers(review, copy) : [];
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
    <div className="repay-loan" data-testid={`fallback-finish-panel-${loanId.toString()}`}>
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
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? finishReceipt(review, copy) : null}
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
