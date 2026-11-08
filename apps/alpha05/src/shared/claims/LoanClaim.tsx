import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { assetAmount } from '../positions/assetAmount';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useTxEntry, useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { measureLoanClaim, type OutcomeText } from './claimOutcome';
import type { ClaimSide } from './loanClaim';
import { loanClaimReceipt } from './loanClaimReceipt';
import { CLAIM, claimFunction, loanClaimBlockers, loanClaimChanged, readLoanClaimReview, type LoanClaimReview } from './loanClaimReview';

type Hex = `0x${string}`;

/** The store key one side's claim keeps its state under: one per loan and
 *  side, so the loan page and the Claims page share it (RB-CLAIM: one flow,
 *  many entry points). */
export function loanClaimKey(loanId: bigint, side: ClaimSide): string {
  return `claim.loan.${side}.${loanId.toString()}`;
}

/** Whether one side's claim is open or in flight, so a page keeps its panel
 *  on screen until the reader closes the finish card. */
export function useLoanClaimHeld(loanId: bigint, side: ClaimSide): { held: boolean; open: boolean; setOpen: (v: boolean | null) => void } {
  const key = loanClaimKey(loanId, side);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  return { held: open === true || holdsFlow(entry.phase), open: open === true, setOpen };
}

interface LoanClaimProps {
  loanId: bigint;
  side: ClaimSide;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * LN-48 / LN-49 — collect one side of a loan's claim, by that side's
 * position holder. The review states every payout the claim makes, what past
 * sellers take first, where the payment lands, and every consequence; it is
 * sent only after the protocol's dry run passes, and its outcome is measured
 * from the transaction's own logs: the claim record, what reached the wallet
 * (or the protected account's queue or vault), and whether the loan settled.
 * No approval is asked: nothing leaves the wallet.
 */
export function LoanClaim({ loanId, side, chain, own, meta, onClose }: LoanClaimProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = loanClaimKey(loanId, side);
  const [review, setReview] = useStoredValue<LoanClaimReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);

  const words: OutcomeText = {
    copy,
    amount: (asset, v) => tokenAmount(v, asset, meta, format),
    exact: (asset, v) => exactTokenAmount(v, asset, meta, format),
    nft: (l) => assetAmount({ asset: l.asset, assetType: l.assetType, amount: 0n, tokenId: l.tokenId, quantity: l.amount }, meta, format),
  };

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no claim under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'ClaimStopped', reason, reopensAt: null, remedy: null });
      };
      // The dry run again, at send: the protocol's own verdict on this claim
      // now, which also screens the wallet.
      const functionName = claimFunction(side);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CLAIM, functionName, args: [loanId], account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('loanClaim.stepSend') }));
      return writeContract(config, { address: diamond, abi: CLAIM, functionName, args: [loanId], chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measureLoanClaim(review, receipt.logs, diamond, account, words) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readLoanClaimReview(own, diamond, loanId, side, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId && review.side === side;
  useReviewRefresh<LoanClaimReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readLoanClaimReview(own, diamond, before.loanId, before.side, before.identity, copy),
    sameSubject: (a, b) => a.loanId === b.loanId && a.side === b.side,
    changed: (before, next) => loanClaimChanged(before, next, copy) !== null,
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
    if (review === null || review.loanId !== loanId || review.side !== side || review.identity !== identity) {
      setReview(null);
      let live = true;
      readLoanClaimReview(own, diamond, loanId, side, identity, copy).then(
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
    // Opened once per loan and side; the tracker and the stored review carry
    // the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId, side]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: LoanClaimReview;
    try {
      next = await readLoanClaimReview(own, diamond, loanId, side, review.identity, copy);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = loanClaimChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = loanClaimBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.verdict.refusals[0]?.code ?? (next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'ClaimBlocked'),
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? loanClaimBlockers(review, copy) : [];
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
            <WhyLink summaryKey="loanClaim.whySummary" detailKey="loanClaim.why" />
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
    <div className="repay-loan" data-testid={`loan-claim-panel-${side}`}>
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
        receipt={review ? loanClaimReceipt(review, meta, copy) : null}
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
