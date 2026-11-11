import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { sendWrite } from '../tx/send';
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
import { destinationReceipt } from './destinationReceipt';
import {
  destinationBlockers,
  destinationCall,
  destinationChanged,
  measureDestination,
  readDestinationReview,
  type DestinationAction,
  type DestinationReview,
} from './destinations';

type Hex = `0x${string}`;

/** The store key the Protection page keeps its destination action under:
 *  one change at a time. */
export const DESTINATION_KEY = 'protection.destination';

export interface DestinationChoice {
  action: DestinationAction;
  destination: Hex;
}

export function useDestinationHeld(): { choice: DestinationChoice | null; inFlight: boolean; open: (c: DestinationChoice | null) => void } {
  const entry = useTxEntry(DESTINATION_KEY);
  const [choice, setChoice] = useStoredValue<DestinationChoice>(`${DESTINATION_KEY}:choice`);
  return { choice, inFlight: holdsFlow(entry.phase), open: setChoice };
}

const STEP = { add: 'dest.stepAdd', cancel: 'dest.stepCancel', apply: 'dest.stepApply', remove: 'dest.stepRemove' } as const;

interface Props {
  chain: SupportedChain;
  own: OwnStateClient;
  choice: DestinationChoice;
  /** The address as the reader saved it, when it is in their book. */
  saved: SavedAddress | null;
  onClose: () => void;
}

/**
 * ACC-41 / #3415 — one change to the account's payout destinations: ask to
 * add a saved address, cancel a waiting request, make a matured one active,
 * or remove one. The review states the destination in full and every
 * consequence; the call is sent only after the protocol's dry run passes,
 * asked again just before the wallet opens, and the finish card states what
 * the protocol recorded, from the transaction's own logs. Nothing leaves
 * the wallet and no approval is asked.
 */
export function DestinationActionFlow({ chain, own, choice, saved, onClose }: Props) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const { action, destination } = choice;
  const [review, setReview] = useStoredValue<DestinationReview>(`${DESTINATION_KEY}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(DESTINATION_KEY);
  const sameChoice = (r: DestinationReview | null) => r !== null && r.action === action && r.destination.toLowerCase() === destination.toLowerCase();

  const tx = useTrackedTx({
    key: DESTINATION_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no destination change under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'DestinationStopped', reason, reopensAt: null, remedy: null });
      };
      // #3379 B2: the change is a write to the account's own vault.
      const call = destinationCall(action, account, destination, review.facts.vault);
      if (call === null) return stop(text('safety.notEnabled'));
      const dry = await askThrough(own, (c) => c.simulateContract({ ...call, account }));
      if (dry.kind === 'reverted') return stop(format('safety.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text(STEP[action]) }));
      return sendWrite(config, { ...call, chainId: chain.chainId, account } as never);
    },
    measure: async (receipt) => (review ? measureDestination(review, receipt.logs, diamond, copy) : []),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readDestinationReview(own, diamond, action, destination, who, copy);
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
  useReviewRefresh<DestinationReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.action === b.action && a.destination.toLowerCase() === b.destination.toLowerCase(),
    changed: (before, next) => destinationChanged(before, next, copy) !== null,
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
  }, [action, destination]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: DestinationReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = destinationChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = destinationBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'DestinationBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? destinationBlockers(review, copy) : [];
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
            <WhyLink summaryKey="dest.whySummary" detailKey="dest.why" />
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
    <div className="repay-loan" data-testid="destination-panel" data-action={action}>
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
        receipt={review && sameChoice(review) ? destinationReceipt(review, saved, copy) : null}
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
