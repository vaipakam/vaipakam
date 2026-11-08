import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
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
import { createVaultBlockers, createVaultCall, createVaultChanged, createVaultReceipt, measureCreateVault, readCreateVaultReview, type CreateVaultReview } from './createVault';

/** The store key the create-vault flow keeps its state under. */
export const CREATE_VAULT_KEY = 'vault.create';

/** Whether the flow is open or in flight, so the page keeps it on screen
 *  until the reader closes the finish card (the vault then exists, and the
 *  page's own state would otherwise drop the panel). */
export function useCreateVaultHeld(): { held: boolean; setOpen: (v: boolean | null) => void } {
  const entry = useTxEntry(CREATE_VAULT_KEY);
  const [open, setOpen] = useStoredValue<boolean>(`${CREATE_VAULT_KEY}:open`);
  return { held: open === true || holdsFlow(entry.phase), setOpen };
}

/**
 * ACC-20 — create my vault. The review says whose vault it is, that nothing
 * moves, and that a deposit or a first offer would create it anyway; it is
 * sent only after the protocol's dry run passes, and the finish card names
 * the vault address the transaction's record gives.
 */
export function CreateVault({ chain, own, onClose }: { chain: SupportedChain; own: OwnStateClient; onClose: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<CreateVaultReview>(`${CREATE_VAULT_KEY}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(CREATE_VAULT_KEY);

  const tx = useTrackedTx({
    key: CREATE_VAULT_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'CreateVaultStopped', reason, reopensAt: null, remedy: null });
      };
      const call = createVaultCall(account);
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('vault.stepCreate') }));
      return writeContract(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    measure: async (receipt) => measureCreateVault(receipt.logs, diamond, account, copy),
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (who: string) => readCreateVaultReview(own, diamond, who);
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
  const onReview = tx.phase.kind === 'review' && review !== null;
  useReviewRefresh<CreateVaultReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.identity),
    sameSubject: () => true,
    changed: (before, next) => createVaultChanged(before, next, copy) !== null,
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
    if (review === null || review.identity !== identity) {
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
    // Opened once; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: CreateVaultReview;
    try {
      next = await read(review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = createVaultChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = createVaultBlockers(next, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'CreateVaultBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? createVaultBlockers(review, copy) : [];
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
            <WhyLink summaryKey="vault.whySummary" detailKey="vault.why" />
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
    <div className="repay-loan" data-testid="vault-create-panel">
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
        receipt={review ? createVaultReceipt(account, copy, review.readAt) : null}
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
