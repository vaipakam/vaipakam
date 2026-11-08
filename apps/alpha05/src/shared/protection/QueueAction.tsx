import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { assetAmount } from '../positions/assetAmount';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { KIND_ERC20, PAYOUT, QUEUE_FUNCTION, type PendingPayout, type QueueAction } from './queue';
import { measureQueueAction, queueBlockers, queueChanged, queueReceipt, readQueueReview, type QueueReview } from './queueReview';

type Hex = `0x${string}`;

/** The store key one action on one queued payout keeps its state under, so
 *  every page that lists the row shares it (RB-CLAIM: one flow, many entry
 *  points). */
export const QUEUE_KEY_PREFIX = 'queue.payout.';
export function queueActionKey(id: bigint, action: QueueAction): string {
  return `${QUEUE_KEY_PREFIX}${action}.${id.toString()}`;
}

/** Whether an action on a row is open or in flight, so a page keeps its
 *  panel on screen until the reader closes the finish card. */
export function useQueueActionHeld(id: bigint, action: QueueAction): { held: boolean; setOpen: (v: boolean | null) => void } {
  const key = queueActionKey(id, action);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  return { held: open === true || holdsFlow(entry.phase), setOpen };
}

/** A payout's size in words, short or exact. */
export function payoutWords(p: Pick<PendingPayout, 'kind' | 'asset' | 'tokenId'>, meta: TokenMetaMap | null, format: ReturnType<typeof useCopy>['format']) {
  return (amount: bigint, exact: boolean) =>
    p.kind === KIND_ERC20
      ? tokenAmount(amount, p.asset, meta, format, exact)
      : assetAmount({ asset: p.asset, assetType: p.kind, amount: 0n, tokenId: p.tokenId, quantity: amount }, meta, format);
}

interface QueueActionProps {
  account: Hex;
  id: bigint;
  action: QueueAction;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * LN-55 / LN-56 — release, cancel or co-sign one queued payout. The review
 * names the row by its request code, states what it pays and to which
 * destination, and every consequence (a release that cancels because the
 * destination is no longer allowed says so); it is sent only after the
 * protocol's dry run passes, and its outcome is measured from the
 * transaction's own logs. Nothing leaves the wallet and no approval is asked.
 */
export function QueuePayoutAction({ account, id, action, chain, own, meta, onClose }: QueueActionProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const viewer = own.account;
  const identity = reviewIdentity(own);
  const flowKey = queueActionKey(id, action);
  const [review, setReview] = useStoredValue<QueueReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const p = review?.row.payout ?? null;
  const words = p ? payoutWords(p, meta, format) : () => text('receipt.unknown');

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account: viewer,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no queued payout under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'QueueStopped', reason, reopensAt: null, remedy: null });
      };
      const functionName = QUEUE_FUNCTION[action];
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: PAYOUT, functionName, args: [id], account: viewer }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(
        format('accept.stepOf', { n: '1', total: '1', what: text(action === 'release' ? 'queue.stepRelease' : action === 'cancel' ? 'queue.stepCancel' : 'queue.stepCosign') }),
      );
      return writeContract(config, { address: diamond, abi: PAYOUT, functionName, args: [id], chainId: chain.chainId, account: viewer });
    },
    measure: async (receipt) => (review ? measureQueueAction(review, receipt.logs, diamond, viewer, words, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readQueueReview(own, diamond, account, id, action, who, copy);
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
  const onReview = tx.phase.kind === 'review' && review !== null && review.id === id && review.action === action;
  useReviewRefresh<QueueReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.id === b.id && a.action === b.action,
    changed: (before, next) => queueChanged(before, next, copy) !== null,
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
    if (review === null || review.id !== id || review.action !== action || review.identity !== identity) {
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
    // Opened once per row and action; the tracker and the stored review
    // carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, action]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: QueueReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = queueChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = queueBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.verdict.refusals[0]?.code ?? (next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'QueueBlocked'),
          reason: blockers[0]!,
          reopensAt: next.verdict.refusals[0]?.reopensAt ?? null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? queueBlockers(review, copy) : [];
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
            <WhyLink summaryKey="queue.whySummary" detailKey="queue.why" />
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
    <div className="repay-loan" data-testid={`queue-${action}-panel-${id.toString()}`}>
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
        receipt={review ? queueReceipt(review, viewer, (exact) => words(review.row.payout?.amount ?? 0n, exact), copy) : null}
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
