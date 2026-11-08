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
import { SELLER } from './sellerClaim';
import {
  measureSellerClaim,
  readSellerClaimReview,
  sellerClaimBlockers,
  sellerClaimChanged,
  sellerClaimReceipt,
  type SellerClaimReview,
  type SellerWords,
} from './sellerClaimReview';

type Hex = `0x${string}`;

/** The store key a seller withdrawal on one loan keeps its state under. */
export const SELLER_CLAIM_KEY_PREFIX = 'claim.seller.';
export function sellerClaimKey(loanId: bigint): string {
  return `${SELLER_CLAIM_KEY_PREFIX}${loanId.toString()}`;
}

/** Whether the withdrawal on a loan is open or in flight, so a page keeps
 *  its panel on screen until the reader closes the finish card. */
export function useSellerClaimHeld(loanId: bigint): { held: boolean; setOpen: (v: boolean | null) => void } {
  const key = sellerClaimKey(loanId);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  return { held: open === true || holdsFlow(entry.phase), setOpen };
}

/** Amounts in words, short or exact. */
export function sellerWords(meta: TokenMetaMap | null, format: ReturnType<typeof useCopy>['format']): SellerWords {
  return { amount: (asset, v, exact) => (exact ? exactTokenAmount(v, asset, meta, format) : tokenAmount(v, asset, meta, format)) };
}

interface SellerClaimProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * LN-52 — withdraw the interest a past seller of the lender position earned
 * and was not paid. The review states what is owed, what waits in the vault,
 * on an ended loan the seller's part of the split and what stays unpaid, and
 * where the payment lands; it is sent only after the protocol's dry run
 * passes, and its outcome is measured from the transaction's own record.
 * Nothing leaves the wallet and no approval is asked.
 */
export function SellerClaim({ loanId, chain, own, meta, onClose }: SellerClaimProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = sellerClaimKey(loanId);
  const [review, setReview] = useStoredValue<SellerClaimReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const words = sellerWords(meta, format);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no seller claim under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'SellerClaimStopped', reason, reopensAt: null, remedy: null });
      };
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: SELLER, functionName: 'claimAsSeller', args: [loanId], account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('sellerClaim.stepSend') }));
      return writeContract(config, { address: diamond, abi: SELLER, functionName: 'claimAsSeller', args: [loanId], chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measureSellerClaim(review, receipt.logs, diamond, account, words, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readSellerClaimReview(own, diamond, loanId, who, copy);
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
  useReviewRefresh<SellerClaimReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.loanId === b.loanId,
    changed: (before, next) => sellerClaimChanged(before, next, copy) !== null,
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
    let next: SellerClaimReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = sellerClaimChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = sellerClaimBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.verdict.refusals[0]?.code ?? (next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'SellerClaimBlocked'),
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? sellerClaimBlockers(review, copy) : [];
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
            <WhyLink summaryKey="sellerClaim.whySummary" detailKey="sellerClaim.why" />
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
    <div className="repay-loan" data-testid={`seller-claim-panel-${loanId.toString()}`}>
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
        receipt={review ? sellerClaimReceipt(review, account, words, copy) : null}
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
