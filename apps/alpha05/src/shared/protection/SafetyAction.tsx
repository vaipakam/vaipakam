import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { Abi } from 'viem';
import { sendWrite } from '../tx/send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { measureSafety, readSafetyReview, safetyBlockers, safetyChanged, safetyLogs, safetySteps, sendSafetySteps, stepCall, type SafetyAction, type SafetyDraft, type SafetyReview, type SafetySend } from './safety';
import { safetyReceipt } from './safetyReceipt';

/** The store key the card's safety action keeps its state under: one at a
 *  time, shared by every page that shows the card. */
export const SAFETY_KEY = 'vault.safety';

/** The action the card holds open (its review, or a send in flight), and
 *  the draft `enable` was chosen with. */
export interface SafetyChoice {
  action: SafetyAction;
  draft: SafetyDraft | null;
}

export function useSafetyHeld(): { choice: SafetyChoice | null; inFlight: boolean; open: (c: SafetyChoice | null) => void } {
  const entry = useTxEntry(SAFETY_KEY);
  const [choice, setChoice] = useStoredValue<SafetyChoice>(`${SAFETY_KEY}:choice`);
  return { choice, inFlight: holdsFlow(entry.phase), open: setChoice };
}

interface SafetyActionProps {
  chain: SupportedChain;
  own: OwnStateClient;
  choice: SafetyChoice;
  onClose: () => void;
}

const STEP = { enable: 'safety.stepEnable', lock: 'safety.stepLock', unlock: 'safety.stepUnlock', finalize: 'safety.stepFinalize' } as const;

/**
 * ACC-37 / ACC-43 — one safety action on the wallet's own account: turn
 * protected mode on, lock the account, ask to unlock it, or apply the
 * changes that are due. The review states what the mode becomes and every
 * consequence; the call is sent only after the protocol's dry run passes,
 * asked again just before the wallet opens, and the finish card states what
 * the protocol recorded, from the transaction's own logs. Nothing leaves
 * the wallet and no approval is asked.
 */
export function SafetyActionFlow({ chain, own, choice, onClose }: SafetyActionProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const { action, draft } = choice;
  const [review, setReview] = useStoredValue<SafetyReview>(`${SAFETY_KEY}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(SAFETY_KEY);
  const sameChoice = (r: SafetyReview | null) => r !== null && r.action === action && JSON.stringify(r.draft) === JSON.stringify(draft);

  // What the last send landed, for its measurement (Codex #3489 r1).
  const sentRef = useRef<SafetySend | null>(null);
  const tx = useTrackedTx({
    key: SAFETY_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no safety action under review');
      sentRef.current = null;
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'SafetyStopped', reason, reopensAt: null, remedy: null });
      };
      // #3379 B2: the action's transactions, in order. Every step that lands
      // is kept with its logs, so the outcome is measured over all of them;
      // a step that cannot be sent after an earlier one landed is reported
      // as a leg of the outcome rather than as a failure of the whole action.
      const steps = safetySteps(action, account, review.facts.vault, draft, review.due);
      if (steps.length === 0) return stop(text('safety.nothingDue'));
      let vault = review.facts.vault;
      const what = (i: number) => format('accept.stepOf', { n: String(i + 1), total: String(steps.length), what: text(STEP[action]) });
      const sent = await sendSafetySteps(
        steps.length,
        async (i) => {
          const step = steps[i];
          if (step.to === 'vault' && vault === null) {
            const read = await own.read((c) =>
              c.readContract({ address: diamond, abi: VaultFactoryFacetABI as Abi, functionName: 'getUserVaultAddress', args: [account] }) as Promise<`0x${string}`>,
            );
            vault = /^0x0{40}$/i.test(read.value) ? null : read.value;
            if (vault === null) return stop(text('safety.notEnabled'));
          }
          const call = stepCall(step, diamond, vault ?? diamond);
          const dry = await askThrough(own, (c) => c.simulateContract({ ...call, account }));
          if (dry.kind === 'reverted') return stop(format('safety.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
          if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
          setStep(what(i));
          return sendWrite(config, { ...call, chainId: chain.chainId, account } as never);
        },
        async (hash) => {
          const landed = await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
          return { ok: landed.status === 'success', logs: landed.logs };
        },
        what,
        text('flow.reverted'),
      );
      sentRef.current = sent;
      return sent.hash;
    },
    measure: async (receipt) => {
      if (!review) return [];
      const sent = sentRef.current;
      const legs = measureSafety(review, safetyLogs(sent?.landed ?? [], receipt), diamond, copy);
      return sent?.stopped ? [...legs, sent.stopped] : legs;
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readSafetyReview(own, diamond, action, draft, who, copy);
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
  useReviewRefresh<SafetyReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: (a, b) => a.action === b.action && JSON.stringify(a.draft) === JSON.stringify(b.draft),
    changed: (before, next) => safetyChanged(before, next, copy) !== null,
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
  }, [action, draft?.delaySeconds, draft?.protectNfts]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: SafetyReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = safetyChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = safetyBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'SafetyBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? safetyBlockers(review, copy) : [];
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
            <WhyLink summaryKey="safety.whySummary" detailKey="safety.why" />
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
    <div className="repay-loan" data-testid="vault-safety-panel" data-action={action}>
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
        receipt={review && sameChoice(review) ? safetyReceipt(review, copy) : null}
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
