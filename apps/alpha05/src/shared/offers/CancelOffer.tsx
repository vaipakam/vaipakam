import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { assetAmount } from '../positions/assetAmount';
import { tokenAmount, useTokenMeta } from '../reads/tokens';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote, useTxStore } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { cancelBlockers, cancelChanged, cancelReceipt, measureCancel, readCancelReview, type CancelReview, type CancelWords } from './cancel';
import { OFFER_CANCEL } from './reads';

type Hex = `0x${string}`;

/** The store key one offer's cancel keeps its state under, so every page
 *  that lists the offer shares it (RB-CLAIM: one flow, many entry points). */
export function cancelOfferKey(id: bigint): string {
  return `offers.cancel.${id.toString()}`;
}

/** Whether an offer's cancel is open or in flight, so a page keeps its
 *  panel on screen until the reader closes the finish card. */
export function useCancelOfferHeld(id: bigint): { held: boolean; setOpen: (v: boolean | null) => void } {
  const key = cancelOfferKey(id);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  return { held: open === true || holdsFlow(entry.phase), setOpen };
}

/** Which of these offers have a cancel open or in flight, so a list keeps
 *  their rows (and the finish card in them) on screen whatever filter the
 *  reader picked, until the card is closed. */
export function useCancelHeldIds(ids: readonly bigint[]): ReadonlySet<string> {
  const store = useTxStore();
  const snapshot = () =>
    ids
      .filter((id) => {
        const key = cancelOfferKey(id);
        return store.value<boolean>(`${key}:open`) === true || holdsFlow(store.get(key).phase);
      })
      .join(',');
  const held = useSyncExternalStore(store.subscribe, snapshot);
  return useMemo(() => new Set(held === '' ? [] : held.split(',')), [held]);
}

interface CancelOfferProps {
  id: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  onClose: () => void;
}

/**
 * OFF-48 / OFF-49 — cancel one offer, or clean up an expired one. The
 * review states what the offer still locks and returns, where it lands (the
 * creator's protected mode routes it like any payout), who receives it when
 * the reader is not the creator, and every consequence; it is sent only
 * after the protocol's dry run passes, and its outcome is measured from the
 * transaction's own logs. Nothing leaves the wallet and no approval is asked.
 */
export function CancelOffer({ id, chain, own, onClose }: CancelOfferProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const viewer = own.account;
  const identity = reviewIdentity(own);
  const flowKey = cancelOfferKey(id);
  const [review, setReview] = useStoredValue<CancelReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const refund = review?.refund ?? null;
  const metaAssets: Hex[] = refund && (refund.kind === 'erc20' || refund.kind === 'nft') ? [refund.asset] : [];
  const meta = useTokenMeta(metaAssets).data;
  const words: CancelWords = {
    amount: (asset, v, exact) => tokenAmount(v, asset, meta, format, exact),
    nft: (asset, assetType, tokenId, quantity) => assetAmount({ asset, assetType, amount: 0n, tokenId, quantity }, meta, format),
  };

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account: viewer,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no offer under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'CancelStopped', reason, reopensAt: null, remedy: null });
      };
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'cancelOffer', args: [id], account: viewer }));
      if (dry.kind === 'reverted') return stop(format('offerCancel.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('offerCancel.stepSend') }));
      return writeContract(config, { address: diamond, abi: OFFER_CANCEL, functionName: 'cancelOffer', args: [id], chainId: chain.chainId, account: viewer });
    },
    measure: async (receipt) => (review ? measureCancel(review, receipt.logs, diamond, viewer, words, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readCancelReview(own, diamond, id, who, copy);
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
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === id;
  useReviewRefresh<CancelReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.offerId === b.offerId,
    changed: (before, next) => cancelChanged(before, next, copy) !== null,
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
    if (review === null || review.offerId !== id || review.identity !== identity) {
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
    // Opened once per offer; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: CancelReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = cancelChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = cancelBlockers(next, viewer, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'CancelBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? cancelBlockers(review, viewer, copy) : [];
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
            <WhyLink summaryKey="offerCancel.whySummary" detailKey="offerCancel.why" />
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
    <div className="repay-loan" data-testid={`offer-cancel-panel-${id.toString()}`}>
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
        receipt={review ? cancelReceipt(review, viewer, words, copy) : null}
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
