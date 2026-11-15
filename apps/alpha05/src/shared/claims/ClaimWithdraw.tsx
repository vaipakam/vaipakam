import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { assetAmount } from '../positions/assetAmount';
import { useTokenMeta } from '../reads/tokens';
import { inFlight, useStoredValue, useTxEntries, useTxStore } from '../tx/txStore';
import type { WithdrawDraft } from '../vault/withdraw';
import { WithdrawVault } from '../vault/WithdrawVault';
import { ASSET_TYPE } from '../nft/nft';
import type { ClaimMode } from './claimWithdraw';

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
 * vault, said so, and is offered again.
 */
export function ClaimWithdraw({
  claimKey,
  drafts,
  mode,
  chain,
  own,
}: {
  claimKey: string;
  drafts: readonly WithdrawDraft[];
  mode: ClaimMode;
  chain: SupportedChain;
  own: OwnStateClient;
}) {
  const { text, format } = useCopy();
  const [shownStored, setShown] = useStoredValue<boolean>(`${claimKey}:withdrawShown`);
  const [closed, setClosed] = useStoredValue<number[]>(`${claimKey}:withdrawClosed`);
  const meta = useTokenMeta(drafts.map((d) => d.asset)).data;
  const shown = shownStored ?? mode === 'withdraw';
  const what = (d: WithdrawDraft) =>
    assetAmount({ asset: d.asset, assetType: ASSET_TYPE[d.standard], amount: d.standard === 'erc20' ? d.amount : 0n, tokenId: d.tokenId, quantity: d.amount }, meta, format);
  if (drafts.length === 0) return null;

  if (!shown)
    return (
      <section className="claim-withdraw" data-testid="claim-withdraw-kept">
        <h3>{text('claimWithdraw.keptTitle')}</h3>
        <p className="tier-b">{text('claimWithdraw.keptNote')}</p>
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
      {drafts.map((d, n) =>
        closed?.includes(n) ? (
          <p key={n} className="actions">
            <button type="button" className="btn" onClick={() => setClosed((c) => (c ?? []).filter((x) => x !== n))} data-testid={`claim-withdraw-again-${n}`}>
              {format('claimWithdraw.withdrawAgain', { what: what(d) })}
            </button>
          </p>
        ) : (
          <WithdrawVault
            key={n}
            chain={chain}
            own={own}
            flowKey={claimWithdrawKey(claimKey, n)}
            subject={{ standard: d.standard, asset: d.asset, tokenId: d.standard === 'erc20' ? 0n : d.tokenId }}
            preset={d}
            onClose={() => setClosed((c) => [...(c ?? []).filter((x) => x !== n), n])}
          />
        ),
      )}
    </section>
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
