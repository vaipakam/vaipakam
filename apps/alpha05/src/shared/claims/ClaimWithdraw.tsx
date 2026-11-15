import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { assetAmount } from '../positions/assetAmount';
import { useTokenMeta } from '../reads/tokens';
import { inFlight, useStoredValue, useTxEntries, useTxEntry, useTxStore } from '../tx/txStore';
import { reviewIdentity } from '../ui/ActionFlow';
import type { WithdrawDraft } from '../vault/withdraw';
import { WithdrawVault } from '../vault/WithdrawVault';
import { ASSET_TYPE } from '../nft/nft';
import type { ClaimMode, ClaimWithdrawPlan } from './claimWithdraw';

/** The store key of a claim's `n`th follow-on withdrawal. */
export function claimWithdrawKey(claimKey: string, n: number): string {
  return `${claimKey}:withdraw:${n}`;
}

/** Whether any withdrawal a claim opened is out with the wallet or the
 *  chain (its finish card then waits to be closed). */
export function useClaimWithdrawBusy(claimKey: string): boolean {
  const prefix = `${claimKey}:withdraw:`;
  return useTxEntries().some(([key, e]) => key.startsWith(prefix) && (inFlight(e.phase) || e.phase.kind === 'receipt-unknown'));
}

/** Clears what a claim's follow-on step kept (call when the claim closes). */
export function useClearClaimWithdraw(claimKey: string): () => void {
  const store = useTxStore();
  const prefix = `${claimKey}:withdraw:`;
  return () => {
    store.setValue(`${claimKey}:withdrawShown`, null);
    store.setValue(`${claimKey}:withdrawClosed`, null);
    store.setValue(`${claimKey}:withdrawFinished`, null);
    // Each follow-on withdrawal not out with the wallet or the chain goes
    // back to idle with what it kept, so the next claim under this key opens
    // its own; one still out keeps its entry (the transaction bar shows it).
    for (const [key, e] of store.all()) {
      if (!key.startsWith(prefix) || inFlight(e.phase) || e.phase.kind === 'receipt-unknown') continue;
      store.update(key, (x) => ({ ...x, phase: { kind: 'idle' }, frozen: null, submission: null, note: null }));
      for (const v of ['review', 'draft', 'presetLeft', 'amount', 'tokenId', 'subject']) store.setValue(`${key}:${v}`, null);
    }
  };
}

/**
 * #3631, step 2 of "claim and withdraw": once the claim confirms, the
 * withdrawal of exactly what it credited to the vault, one asset at a time,
 * each through the ordinary vault withdrawal (its own review, dry run,
 * protected-mode route and finish card). A reader who chose to keep the
 * payout in the vault is told it is there, and may still withdraw it now.
 * A withdrawal closed or refused leaves the claim done and the money in the
 * vault, said so, and is offered again; one that went through (or whose
 * outcome could not be read) is never offered again, so a second
 * confirmation cannot draw other funds from the vault. The withdrawals open
 * only while the reader is still connected as the network and account the
 * claim ran for.
 */
export function ClaimWithdraw({ claimKey, plan, mode, chain, own }: { claimKey: string; plan: ClaimWithdrawPlan; mode: ClaimMode; chain: SupportedChain; own: OwnStateClient }) {
  const { text, format } = useCopy();
  const [shownStored, setShown] = useStoredValue<boolean>(`${claimKey}:withdrawShown`);
  const [closed, setClosed] = useStoredValue<number[]>(`${claimKey}:withdrawClosed`);
  const [finished, setFinished] = useStoredValue<number[]>(`${claimKey}:withdrawFinished`);
  const { drafts } = plan;
  const meta = useTokenMeta(drafts.map((d) => d.asset)).data;
  const shown = shownStored ?? mode === 'withdraw';
  const sameIdentity = reviewIdentity(own) === plan.identity;
  const what = (d: WithdrawDraft) =>
    assetAmount({ asset: d.asset, assetType: ASSET_TYPE[d.standard], amount: d.standard === 'erc20' ? d.amount : 0n, tokenId: d.tokenId, quantity: d.amount }, meta, format);
  const unlisted = plan.unlisted > 0 && (
    <p className="tier-a" data-testid="claim-withdraw-unlisted">
      {format('claimWithdraw.unlisted', { n: String(plan.unlisted) })}
    </p>
  );
  if (drafts.length === 0) return unlisted || null;

  if (!shown)
    return (
      <section className="claim-withdraw" data-testid="claim-withdraw-kept">
        <h3>{text('claimWithdraw.keptTitle')}</h3>
        <p className="tier-b">{text('claimWithdraw.keptNote')}</p>
        {unlisted}
        <p className="actions">
          <button type="button" className="btn" onClick={() => setShown(true)} data-testid="claim-withdraw-now">
            {text('claimWithdraw.withdrawNow')}
          </button>
        </p>
      </section>
    );

  return (
    <section className="claim-withdraw" data-testid="claim-withdraw">
      <h3>{text('claimWithdraw.stepTitle')}</h3>
      <p className="tier-b">{text('claimWithdraw.stepNote')}</p>
      {unlisted}
      {drafts.map((d, n) =>
        finished?.includes(n) ? (
          <p key={n} className="tier-b" data-testid={`claim-withdraw-finished-${n}`}>
            {format('claimWithdraw.finished', { what: what(d) })}
          </p>
        ) : closed?.includes(n) || !sameIdentity ? (
          sameIdentity ? (
            <p key={n} className="actions">
              <button type="button" className="btn" onClick={() => setClosed((c) => (c ?? []).filter((x) => x !== n))} data-testid={`claim-withdraw-again-${n}`}>
                {format('claimWithdraw.withdrawAgain', { what: what(d) })}
              </button>
            </p>
          ) : (
            <p key={n} className="tier-a" data-testid={`claim-withdraw-other-${n}`}>
              {format('claimWithdraw.otherIdentity', { what: what(d) })}
            </p>
          )
        ) : (
          <ClaimWithdrawStep
            key={n}
            flowKey={claimWithdrawKey(claimKey, n)}
            draft={d}
            chain={chain}
            own={own}
            onClosed={(moved) => (moved ? setFinished((f) => [...(f ?? []).filter((x) => x !== n), n]) : setClosed((c) => [...(c ?? []).filter((x) => x !== n), n]))}
          />
        ),
      )}
    </section>
  );
}

/** One follow-on withdrawal. Its finish card's Close reports whether the
 *  withdrawal went through: anything but a measured "nothing moved" (a
 *  completed or queued withdrawal, part of one, or one whose outcome could
 *  not be read) counts as moved, so it is not offered again. A withdrawal
 *  closed before or without a transaction did not move anything. */
function ClaimWithdrawStep({
  flowKey,
  draft,
  chain,
  own,
  onClosed,
}: {
  flowKey: string;
  draft: WithdrawDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  onClosed: (moved: boolean) => void;
}) {
  const { phase } = useTxEntry(flowKey);
  // Read at render: the flow resets its entry before it calls onClose.
  const moved = phase.kind === 'measured' ? phase.outcome.verdict !== 'not-done' : phase.kind === 'receipt-unknown';
  return (
    <WithdrawVault
      chain={chain}
      own={own}
      flowKey={flowKey}
      subject={{ standard: draft.standard, asset: draft.asset, tokenId: draft.standard === 'erc20' ? 0n : draft.tokenId }}
      preset={draft}
      onClose={() => onClosed(moved)}
    />
  );
}

/**
 * #3631 — how a claim is opened: "Claim and withdraw" (the claim, then the
 * withdrawal of what it put in the vault) leads, "Claim to my vault" keeps
 * it there to lend or post as collateral. Both open the same claim review,
 * which states the two steps or the choice to keep.
 */
export function ClaimChoice({ testId, onStart, label }: { testId: string; onStart: (mode: ClaimMode) => void; label?: string }) {
  const { text } = useCopy();
  return (
    <div className="position-action-row claim-choice">
      {label !== undefined && <p className="row-head">{label}</p>}
      <button type="button" className="btn btn-primary" onClick={() => onStart('withdraw')} data-testid={`${testId}`}>
        {text('claimWithdraw.actionWithdraw')}
      </button>
      <button type="button" className="btn" onClick={() => onStart('keep')} data-testid={testId.replace('-open-', '-keep-')}>
        {text('claimWithdraw.actionKeep')}
      </button>
    </div>
  );
}
