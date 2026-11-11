import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import type { SavedAddress } from '../address/book';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { signerReceipt } from './signerReceipt';
import { measureSigner, readSignerReview, signerBlockers, signerCall, signerChanged, type SignerAction, type SignerReview } from './signers';

type Hex = `0x${string}`;

/** The store key the Protection page keeps its signer change under (one
 *  change at a time); the nominee's accept page keeps its own. */
export const SIGNER_KEY = 'protection.signer';
export const SIGNER_ACCEPT_KEY = 'protection.signerAccept';

export interface SignerChoice {
  action: SignerAction;
  /** The signer the change is about; the account itself for the co-sign switch. */
  signer: Hex;
}

export function useSignerHeld(key: string): { choice: SignerChoice | null; inFlight: boolean; open: (c: SignerChoice | null) => void } {
  const entry = useTxEntry(key);
  const [choice, setChoice] = useStoredValue<SignerChoice>(`${key}:choice`);
  return { choice, inFlight: holdsFlow(entry.phase), open: setChoice };
}

const STEP = {
  add: 'signer.stepAdd',
  accept: 'signer.stepAccept',
  cancelAdd: 'signer.stepCancelAdd',
  applyAdd: 'signer.stepApplyAdd',
  remove: 'signer.stepRemove',
  cancelRemove: 'signer.stepCancelRemove',
  applyRemove: 'signer.stepApplyRemove',
  cosignOn: 'signer.stepCosignOn',
  cosignOff: 'signer.stepCosignOff',
} as const satisfies Record<SignerAction, string>;

interface Props {
  chain: SupportedChain;
  own: OwnStateClient;
  /** The protected account: the connected wallet's own, or the linked one
   *  on the nominee's accept page. */
  account: Hex;
  storeKey: string;
  choice: SignerChoice;
  /** The signer as the reader saved it, when it is in their book. */
  saved: SavedAddress | null;
  onClose: () => void;
}

/**
 * ACC-41 / #3415 — one change to the account's secondary signers: ask to
 * add a saved wallet, accept the role (from the nominee's own key), cancel
 * a waiting request, make an accepted one active, ask to remove a signer,
 * cancel or carry out that removal, or switch the co-sign requirement. The
 * review states the signer in full, what a signer can and cannot do, and
 * every consequence; the call is sent only after the protocol's dry run
 * passes, asked again just before the wallet opens, and the finish card
 * states what the protocol recorded, from the transaction's own logs.
 * Nothing leaves the vault and no approval is asked.
 */
export function SignerActionFlow({ chain, own, account, storeKey, choice, saved, onClose }: Props) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const identity = reviewIdentity(own);
  const { action, signer } = choice;
  const [review, setReview] = useStoredValue<SignerReview>(`${storeKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(storeKey);
  const sameChoice = (r: SignerReview | null) =>
    r !== null && r.action === action && r.signer.toLowerCase() === signer.toLowerCase() && r.facts.account.toLowerCase() === account.toLowerCase();

  const tx = useTrackedTx({
    key: storeKey,
    chainId: chain.chainId,
    account: own.account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no signer change under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'SignerStopped', reason, reopensAt: null, remedy: null });
      };
      // #3379 B2: a signer change is a write to the account's vault.
      const call = signerCall(action, account, signer, own.account, review.facts.vault, diamond);
      if (call === null) return stop(text('safety.notEnabled'));
      const dry = await askThrough(own, (c) => c.simulateContract({ ...call, account: own.account }));
      if (dry.kind === 'reverted') return stop(format('safety.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text(STEP[action]) }));
      return writeContract(config, { ...call, chainId: chain.chainId, account: own.account } as never);
    },
    measure: async (receipt) => (review ? measureSigner(review, receipt.logs, diamond, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readSignerReview(own, diamond, account, action, signer, who, copy);
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
  const onReview = tx.phase.kind === 'review' && sameChoice(review);
  useReviewRefresh<SignerReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) =>
      a.action === b.action && a.signer.toLowerCase() === b.signer.toLowerCase() && a.facts.account.toLowerCase() === b.facts.account.toLowerCase(),
    changed: (before, next) => signerChanged(before, next, copy) !== null,
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
    if (!sameChoice(review) || review!.identity !== identity) {
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
    // Opened once per choice; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, signer, account]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: SignerReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = signerChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = signerBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'SignerBlocked',
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? signerBlockers(review, copy) : [];
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
            <WhyLink summaryKey="signer.whySummary" detailKey="signer.why" />
          </div>
        ),
      }
    : undefined;

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="signer-panel" data-action={action}>
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
        receipt={review && sameChoice(review) ? signerReceipt(review, saved, copy) : null}
        recheck={recheck}
        describeAsset={() => null}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
