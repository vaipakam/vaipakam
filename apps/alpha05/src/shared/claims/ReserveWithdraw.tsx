import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { measureReserve, readReserveReview, reserveBlockers, reserveCall, reserveChanged, reserveReceipt, type ReserveReview, type ReserveWords } from './reserveReview';

type Hex = `0x${string}`;

/** The store key a reserve withdrawal on one loan keeps its state under. */
export const RESERVE_KEY_PREFIX = 'claim.reserve.';
export function reserveKey(loanId: bigint): string {
  return `${RESERVE_KEY_PREFIX}${loanId.toString()}`;
}

/** Whether the withdrawal on a loan is open or in flight, so a page keeps
 *  its panel on screen until the reader closes the finish card. */
export function useReserveHeld(loanId: bigint): { held: boolean; setOpen: (v: boolean | null) => void } {
  const key = reserveKey(loanId);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  return { held: open === true || holdsFlow(entry.phase), setOpen };
}

/** Amounts in words, short or exact. */
export function reserveWords(meta: TokenMetaMap | null, format: ReturnType<typeof useCopy>['format']): ReserveWords {
  return { amount: (asset, v, exact) => (exact ? exactTokenAmount(v, asset, meta, format) : tokenAmount(v, asset, meta, format)) };
}

interface ReserveWithdrawProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * LN-62 — take back an unused extension reserve. The review states what is
 * reserved, whether an extension could still draw on it, and where it lands;
 * the whole reserve is withdrawn, sent only after the protocol's dry run
 * passes, and its outcome is measured from the transaction's own record.
 * Nothing leaves the wallet and no approval is asked.
 */
export function ReserveWithdraw({ loanId, chain, own, meta, onClose }: ReserveWithdrawProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = reserveKey(loanId);
  const [review, setReview] = useStoredValue<ReserveReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const words = reserveWords(meta, format);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review || review.row.funding === null) throw new Error('no reserve withdrawal under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'ReserveWithdrawStopped', reason, reopensAt: null, remedy: null });
      };
      // The amount is the reserve the review read and the reader confirmed.
      const call = reserveCall(loanId, account, review.row.funding.reserved);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('reserve.stepSend') }));
      return writeContract(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measureReserve(review, receipt.logs, diamond, account, words, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readReserveReview(own, diamond, loanId, who, copy);
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
  useReviewRefresh<ReserveReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.loanId === b.loanId,
    changed: (before, next) => reserveChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
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
    let next: ReserveReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = reserveChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = reserveBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.verdict.refusals[0]?.code ?? (next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'ReserveWithdrawBlocked'),
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? reserveBlockers(review, copy) : [];
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
            <WhyLink summaryKey="reserve.whySummary" detailKey="reserve.why" />
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
    <div className="repay-loan" data-testid={`reserve-panel-${loanId.toString()}`}>
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
        receipt={review ? reserveReceipt(review, account, copy) : null}
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
