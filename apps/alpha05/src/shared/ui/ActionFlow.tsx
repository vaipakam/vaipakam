import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { OwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useTxStore } from '../tx/txStore';
import { useCopy } from '../copy/useCopy';
import type { Refusal } from '../eligibility/types';
import type { FinishCard as FinishCardModel, Receipt as ReceiptModel } from '../receipt/types';
import type { TrackedTx } from '../tx/useTrackedTx';
import { FinishCard } from './FinishCard';
import { Icon } from './Icon';
import { Notice } from './Notice';
import { Receipt, type AssetInfo } from './Receipt';
import { shortAddress } from './format';
import { useNow } from './useNow';

/**
 * What the last re-check before the wallet opens found (RB-REVIEW). The
 * review's inputs are read again and the call is simulated; the wallet opens
 * only on `ok`.
 * - `changed`: an input moved since the review was built; the caller has
 *   already updated what the receipt is built from, so the reader sees the
 *   new receipt and confirms again.
 * - `refused`: the protocol's own first refusal (from the simulation, or a
 *   switch the re-read found), stated as given; nothing is sent.
 * - `unreadable`: a safety prerequisite could not be read; signing is
 *   withheld, and the reader can try again.
 */
export type Recheck =
  | { kind: 'ok' }
  | { kind: 'changed'; what: string }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'unreadable'; reason: string };

/** The wallet and network a review is built under (`chainId:account`). */
export function reviewIdentity(own: Pick<OwnStateClient, 'chainId' | 'account'>): string {
  return `${own.chainId}:${own.account.toLowerCase()}`;
}

export interface ActionFlowProps {
  tx: TrackedTx;
  /** The connected wallet and network now (`reviewIdentity`). */
  identity: string;
  /** The identity the review's inputs were read under, kept by the caller
   *  WITH those inputs, so it survives this component unmounting while the
   *  wallet or network switches. A review built for one identity is never
   *  signed under another (RB-REVIEW): when they differ, signing is
   *  withheld and the reader starts again. */
  reviewedFor: string;
  /** The receipt as of the review's latest read; null while it is read, or
   *  when the page mounted again after the review (progress and the finish
   *  card then show the receipt frozen when the wallet was asked). */
  receipt: ReceiptModel | null;
  /** Re-read and simulate right before the wallet opens. `current` turns
   *  false once the reader closes this review, opens another, or the flow
   *  unmounts: a re-check writes what it found into the caller's review
   *  state only while it is true, so a late answer never reopens or edits a
   *  review the reader has left. */
  recheck: (current: () => boolean) => Promise<Recheck>;
  describeAsset: (asset: `0x${string}`) => AssetInfo | null;
  /** The connected chain's explorer origin, frozen with the review when the
   *  wallet is asked: transaction links always use the network it was sent
   *  on. */
  explorer: string;
  /** The next action the finish card offers, if any. */
  next: FinishCardModel['next'];
  /** Rendered under a measured outcome (a "Continue" that resumes a gated
   *  action, a wallet watch-asset offer, next-step links). */
  after?: (outcome: FinishCardModel['outcome']) => ReactNode;
  /** Back to idle; the caller closes its panel. */
  onClose: () => void;
  /** What the review needs from the reader before the wallet may open (a
   *  consent checkbox, a blocker stated in place), rendered under the
   *  receipt; confirming is withheld until `ready`. */
  gate?: { node: ReactNode; ready: boolean };
  /** While the wallet is asked, which of several prompts is open ("Wallet
   *  step 2 of 3: …"); the generic line otherwise. */
  signingNote?: string | null;
}

/**
 * RB-CONFIDENCE — the same four things on every write, so the app is learned
 * once: the receipt before the signature, the wallet step narrated while it
 * is open, a progress line while the transaction runs, and the finish card
 * with the MEASURED outcome. A transaction handed to the wallet is never
 * retried silently: a receipt that cannot be read keeps its hash on screen
 * and offers "Check again", and nothing new is offered until it is resolved.
 */
export function ActionFlow({ tx, identity, reviewedFor, receipt, recheck, describeAsset, explorer, next, after, onClose, gate, signingNote }: ActionFlowProps) {
  const { text, format } = useCopy();
  const nowMs = useNow();
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<Exclude<Recheck, { kind: 'ok' }> | null>(null);
  const { phase } = tx;
  const store = useTxStore();
  const location = useLocation();
  // While this flow is on screen the shell's "still in progress" line is not
  // needed for it.
  useEffect(() => {
    store.update(tx.key, (e) => ({ ...e, shown: e.shown + 1 }));
    return () => void store.update(tx.key, (e) => ({ ...e, shown: Math.max(0, e.shown - 1) }));
  }, [store, tx.key]);
  // Past the review, what the reader confirmed is drawn from the frozen
  // copy, never rebuilt for the wallet or network connected now.
  const shownReceipt = phase.kind === 'review' ? receipt : (tx.frozen?.receipt ?? receipt);
  const shownExplorer = phase.kind === 'review' ? explorer : (tx.frozen?.explorer ?? explorer);
  /** Bumped when the review closes or this flow unmounts: a re-check still
   *  running for a review the reader has left never opens the wallet, even
   *  if the caller has since opened another review on the same tracker. */
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );
  /** The identity as of the latest render, for a re-check that resolves
   *  after the wallet or network moved. */
  const live = useRef(identity);
  useEffect(() => {
    live.current = identity;
  }, [identity]);
  /** The gate (a consent) as of the latest render: a reader who withdraws it
   *  while the re-check runs never has the wallet opened on the old answer. */
  const gateReady = useRef(gate === undefined || gate.ready);
  useEffect(() => {
    gateReady.current = gate === undefined || gate.ready;
  }, [gate]);

  const close = () => {
    attempt.current += 1;
    setFound(null);
    tx.reset();
    onClose();
  };

  const confirm = async () => {
    const mine = attempt.current;
    const current = () => attempt.current === mine;
    setChecking(true);
    setFound(null);
    let result: Recheck;
    try {
      result = await recheck(current);
    } catch (e) {
      result = { kind: 'unreadable', reason: (e as Error).message };
    }
    if (attempt.current !== mine) return;
    setChecking(false);
    // Moved while the re-check ran: the render now withholds signing.
    if (live.current !== reviewedFor) return;
    // The gate was withdrawn while the re-check ran: the render now holds
    // Confirm until it is given again.
    if (!gateReady.current) return;
    if (result.kind !== 'ok') {
      setFound(result);
      return;
    }
    await tx.run({ identity: reviewedFor, chainId: Number(reviewedFor.split(':')[0]), receipt, explorer, where: location.pathname });
  };

  // Past the review, everything shown is about the wallet that confirmed
  // it. When the reader has since switched wallet or network, say whose it
  // is, so that wallet's outcome is never read as the connected one's.
  const sender = phase.kind === 'review' || phase.kind === 'idle' ? null : (tx.frozen?.identity ?? null);
  const senderNote =
    sender !== null && sender !== identity ? (
      <Notice tone="warn" tier="A">
        {format('flow.sentFrom', { account: shortAddress(sender.split(':')[1] as `0x${string}`), chain: getSupportedChain(Number(sender.split(':')[0]))?.name ?? sender.split(':')[0]! })}
      </Notice>
    ) : null;

  const txLink = (hash: `0x${string}`) => (
    <a href={`${shownExplorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {shortAddress(hash)}
    </a>
  );

  switch (phase.kind) {
    case 'idle':
      return null;
    case 'review': {
      const moved = identity !== reviewedFor;
      const blocked = found?.kind === 'refused' || moved;
      return (
        <div className="action-flow" data-phase="review">
          {receipt === null ? <p className="tier-b">{text('flow.reading')}</p> : <Receipt receipt={receipt} describeAsset={describeAsset} nowMs={nowMs} />}
          {found?.kind === 'changed' && (
            <Notice tone="warn" tier="A">
              {format('flow.changed', { what: found.what })}
            </Notice>
          )}
          {found?.kind === 'refused' && (
            <Notice tone="danger" tier="A">
              {found.refusal.reason}
            </Notice>
          )}
          {found?.kind === 'unreadable' && (
            <Notice tone="warn" tier="A">
              {format('flow.unreadable', { reason: found.reason })}
            </Notice>
          )}
          {moved && (
            <Notice tone="warn" tier="A">
              {text('flow.identityChanged')}
            </Notice>
          )}
          {receipt !== null && gate?.node}
          {checking && <p className="tier-b" role="status">{text('flow.checking')}</p>}
          <p className="actions">
            {!blocked && (
              <button type="button" className="btn btn-primary" disabled={receipt === null || checking || (gate !== undefined && !gate.ready)} onClick={() => void confirm()}>
                <Icon meaning="sign" />
                {text('flow.confirm')}
              </button>
            )}
            <button type="button" className="btn" onClick={close}>
              {text(blocked ? 'flow.close' : 'flow.cancel')}
            </button>
          </p>
        </div>
      );
    }
    case 'signing':
      return (
        <div className="action-flow" data-phase="signing">
          {senderNote}
          <p className="tier-b with-icon" role="status">
            <Icon meaning="pending" />
            {signingNote ?? text('flow.signing')}
          </p>
        </div>
      );
    case 'submitted':
      return (
        <div className="action-flow" data-phase="submitted">
          {senderNote}
          <p className="tier-b with-icon" role="status">
            <Icon meaning="pending" />
            {text('flow.submitted')} {txLink(phase.hash)}
          </p>
        </div>
      );
    case 'mined':
      return (
        <div className="action-flow" data-phase="mined">
          {senderNote}
          <p className="tier-b with-icon" role="status">
            <Icon meaning="pending" />
            {format('flow.mined', { block: phase.blockNumber.toString() })} {txLink(phase.hash)}
          </p>
        </div>
      );
    case 'measured':
      return (
        <div className="action-flow" data-phase="measured" data-verdict={phase.outcome.verdict}>
          {senderNote}
          {shownReceipt !== null && <FinishCard card={{ receipt: shownReceipt, outcome: phase.outcome, next }} describeAsset={describeAsset} nowMs={nowMs} />}
          <p className="tier-b">
            {text('flow.transaction')} {txLink(phase.hash)}
          </p>
          {after?.(phase.outcome)}
          <p className="actions">
            <button type="button" className="btn" onClick={close}>
              {text('flow.close')}
            </button>
          </p>
        </div>
      );
    case 'receipt-unknown':
      return (
        <div className="action-flow" data-phase="receipt-unknown">
          {senderNote}
          <Notice tone="warn" tier="A">
            {format('flow.receiptUnknown', { reason: phase.message })} {txLink(phase.hash)}
          </Notice>
          <p className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void tx.resume()}>
              {text('flow.checkAgain')}
            </button>
            <button type="button" className="btn" onClick={close}>
              {text('flow.close')}
            </button>
          </p>
        </div>
      );
    case 'superseded':
      return (
        <div className="action-flow" data-phase="superseded">
          {senderNote}
          <Notice tone="warn" tier="A">
            {text(phase.reason === 'cancelled' ? 'flow.cancelled' : 'flow.replaced')} {txLink(phase.minedHash)}
          </Notice>
          {phase.unwound && (
            <Notice tone={phase.unwound.status === 'done' ? 'ok' : 'warn'} tier="A">
              {phase.unwound.status === 'done' ? phase.unwound.label : `${phase.unwound.label}: ${phase.unwound.reason}`}
            </Notice>
          )}
          <p className="actions">
            <button type="button" className="btn" onClick={close}>
              {text('flow.close')}
            </button>
          </p>
        </div>
      );
    case 'failed':
      return (
        <div className="action-flow" data-phase="failed">
          {senderNote}
          <Notice tone="danger" tier="A">
            {format('flow.notSent', { reason: phase.message })}
          </Notice>
          <p className="actions">
            <button type="button" className="btn" onClick={close}>
              {text('flow.close')}
            </button>
          </p>
        </div>
      );
  }
}
