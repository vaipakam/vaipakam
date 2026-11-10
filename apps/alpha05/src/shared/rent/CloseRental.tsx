import { useEffect, useRef, useState } from 'react';
import type { Abi, Log } from 'viem';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { ClaimFacetABI, RepayFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { assetAmount } from '../positions/assetAmount';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { repaidStatus } from '../repay/repaidLog';
import type { AnchoredReader } from '../tx/anchored';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { closeReceipt } from './closeReceipt';
import { closeBlockers, closeChangedBetween, readCloseReview, type CloseReview } from './closeReview';
import { isRevoked, rentalUpdate } from './rentalLog';

type Hex = `0x${string}`;

const REPAY_ABI = RepayFacetABI as Abi;
const CLAIM_ABI = ClaimFacetABI as Abi;

/** `LibVaipakam.LoanStatus.Repaid`: the status a rental's close leaves it in. */
const STATUS_REPAID = 1;

/** The store key a rental's close keeps its state under: one per rental. */
export function closeRentalKey(loanId: bigint): string {
  return `position.rentClose.${loanId.toString()}`;
}

interface CloseRentalProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * NFT-05 — the renter closes a running rental. It is the protocol's
 * repayment of a rental (`repayLoan`): the rent owed and any late fee are
 * paid out of the rent and buffer already in the renter's own vault, the
 * rest comes back to the renter as a claim, and the renter's use ends at
 * once. Nothing is taken from the wallet, so there is no approval: one
 * prompt, sent only after a dry run passes. The outcome is measured from
 * the transaction's own log (the status the close left the rental in), from
 * the claim it recorded for the renter, and from the rental update it
 * logged, which revokes the renter's use.
 */
export function CloseRental({ loanId, chain, own, meta, onClose }: CloseRentalProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = closeRentalKey(loanId);
  const [review, setReview] = useStoredValue<CloseReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no rental close under review');
      // The dry run: the protocol's own verdict on this close, now.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: REPAY_ABI, functionName: 'repayLoan', args: [loanId], account }));
      if (dry.kind === 'reverted') throw new StatedRefusal({ code: 'RentCloseStopped', reason: format('rentClose.dryRunRefused', { reason: refusalFromError(dry.error).reason }), reopensAt: null, remedy: null });
      if (dry.kind === 'unreadable') throw new StatedRefusal({ code: 'RentCloseStopped', reason: format('flow.unreadable', { reason: dry.reason }), reopensAt: null, remedy: null });
      setStep(text('rentClose.stepSend'));
      return writeContract(config, { address: diamond, abi: REPAY_ABI, functionName: 'repayLoan', args: [loanId], chainId: chain.chainId, account });
    },
    unwind: async () => null,
    measure: async (receipt, at) => (review ? measure(review, receipt.logs, at) : []),
    release: async () => null,
  });

  /** What the close left: the rental's status (its own log), the renter's
   *  claim, and the rental update its own log records. */
  const measure = async (r: CloseReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const l = r.loan;
    const pay = l.prepayAsset;
    const legs: LegOutcome[] = [];
    const closedLabel = format('rentClose.legClosed', { id: loanId.toString() });
    // The close's own log, not the status at the block: both sides claiming
    // later in the same block settles the rental after it was closed.
    const status = repaidStatus(logs, diamond, loanId);
    const closed = status === STATUS_REPAID;
    legs.push(closed ? { status: 'done', label: closedLabel } : { status: 'not-done', label: closedLabel, reason: text('rentClose.notClosed') });
    if (!closed) return legs;

    // The renter's claim: the prepayment less the rent and late fee as of
    // the close's block, which lies between the two figures the review
    // stated (the refund only falls as time passes).
    try {
      // The renter's row as the protocol records it (`getClaimable`, borrower
      // side): its asset and amount.
      const row = await at.read((c, b) => c.readContract({ address: diamond, abi: CLAIM_ABI, functionName: 'getClaimable', args: [loanId, false], blockNumber: b.blockNumber }) as Promise<readonly [Hex, bigint]>);
      const claim = { asset: row[0], amount: row[1] };
      const high = r.now.refund ?? 0n;
      const low = r.atBy.refund ?? 0n;
      const label = format('rentClose.legClaim', { amount: tokenAmount(claim.amount, pay, meta, format) });
      legs.push(
        claim.asset.toLowerCase() === pay.toLowerCase() && claim.amount >= low && claim.amount <= high
          ? { status: 'done', label }
          : {
              status: 'unknown',
              label,
              reason: format('rentClose.claimOther', { amount: exactTokenAmount(claim.amount, pay, meta, format), low: exactTokenAmount(low, pay, meta, format), high: exactTokenAmount(high, pay, meta, format) }),
            },
      );
    } catch (e) {
      legs.push({ status: 'unknown', label: format('rentClose.legClaim', { amount: text('receipt.unknown') }), reason: refusalFromError(e).reason });
    }

    // The renter's use: the close's own log for this rental. The owner's
    // vault totals are no measure of it (an expired rental is already out of
    // them, and another rental of the token can move them in the same block).
    const nft = assetAmount({ asset: l.principalAsset, assetType: l.assetType, amount: 0n, tokenId: l.tokenId, quantity: l.quantity }, meta, format);
    const useLabel = format('rentClose.legUse', { nft });
    const update = rentalUpdate(logs, diamond, loanId);
    legs.push(update !== null && isRevoked(update) ? { status: 'done', label: useLabel } : { status: 'not-done', label: useLabel, reason: text('rentClose.useOther') });
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readCloseReview(own, diamond, loanId, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const keepOf = (r: CloseReview) => ({ by: r.late.by, capped: r.capped });

  // RB-RAILS: read again each block while the review is on screen; only a
  // change the review states (closeChangedBetween) reopens it.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId;
  useReviewRefresh<CloseReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readCloseReview(own, diamond, before.loanId, before.identity, copy, keepOf(before)),
    sameSubject: (a, b) => a.loanId === b.loanId,
    changed: (before, next) => closeChangedBetween(before, next, copy) !== null,
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
      readCloseReview(own, diamond, loanId, identity, copy).then(
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
    // Opened once per rental; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: CloseReview;
    try {
      next = await readCloseReview(own, diamond, loanId, review.identity, copy, keepOf(review));
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = closeChangedBetween(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = closeBlockers(next, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: next.verdict.refusals[0]?.code ?? 'InsufficientPrepay', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const blockers = review ? closeBlockers(review, copy) : [];
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
            <WhyLink summaryKey="rentClose.whySummary" detailKey="rentClose.why" />
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
    <div className="repay-loan" data-testid="rent-close-panel">
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
        receipt={review ? closeReceipt(review, meta, copy) : null}
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
