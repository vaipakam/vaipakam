/**
 * Repay, or close early, every loan that came from one offer (#126).
 *
 * The borrower's loans from one offer share a lending asset, so the batch
 * is one approval for the total, then one Diamond `multicall` per 30
 * loans. Every loan is planned through the same live checks its own page
 * runs (`closeOutPlan.ts`); a loan with anything to disclose is left out
 * and named, never folded in silently. Each call in the multicall runs as
 * the borrower with `allowFailure`, so a loan that fails at execution is
 * skipped while the others close.
 *
 * Outcomes are read back from the chain after each transaction, not
 * assumed from it: a loan is "closed" only when its live status reads
 * Repaid. Where nothing closed, the approval is set back the way the
 * single-loan flow sets it back.
 */
import { useState } from 'react';
import { Layers, LoaderCircle } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { erc20Abi } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useMode } from '../app/ModeContext';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, trackApproval, useTokenMeta } from '../contracts/erc20';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { LOAN_STATUS_ACTIVE, readLoanLive } from '../contracts/loanLive';
import { LoanStatus } from '../lib/types';
import { captureTxError, submitErrorText } from '../lib/errors';
import { formatTokenAmountUp } from '../lib/format';
import type { PositionLoan } from '../data/hooks';
import {
  lateBatchRefusal,
  planCloseOutForBatch,
  type CloseOutAction,
  type CloseOutCtx,
  type CloseOutPlan,
} from '../data/closeOutPlan';
import { pullTotals, type BatchOutcome, type OfferGroup } from '../data/batchCloseOut';
import { chunkForMulticall, encodeBestEffort } from '../data/multicall';

type Stage =
  | { kind: 'idle' }
  | { kind: 'planning'; action: CloseOutAction }
  | { kind: 'review'; action: CloseOutAction; plans: CloseOutPlan[] }
  | { kind: 'sending'; action: CloseOutAction; step: 'approving' | 'checking' | 'submitting' }
  | { kind: 'done'; action: CloseOutAction; outcomes: BatchOutcome[]; note: string | null };

export function BatchCloseOutCard({ group }: { group: OfferGroup<PositionLoan> }) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();
  const { isAdvanced } = useMode();
  const meta = useTokenMeta(group.loans[0]?.lendingAsset);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const ctx: CloseOutCtx | null =
    address && walletChain && publicClient
      ? { publicClient, diamond: walletChain.diamondAddress, holder: address }
      : null;
  const ready = Boolean(ctx && walletClient && onSupportedChain && meta.data);
  const amount = (raw: bigint) =>
    meta.data ? `${formatTokenAmountUp(raw, meta.data.decimals)} ${meta.data.symbol}` : '';
  const byId = new Map(group.loans.map((l) => [l.loanId, l]));

  async function plan(action: CloseOutAction) {
    if (!ctx) return;
    setError(null);
    setStage({ kind: 'planning', action });
    const plans = await Promise.all(
      group.loans.map((l) => planCloseOutForBatch(ctx, l, action)),
    );
    setStage({ kind: 'review', action, plans });
  }

  async function confirm(action: CloseOutAction, plans: CloseOutPlan[]) {
    if (!ctx || !walletClient || !walletChain || !address) return;
    setError(null);
    const leftOut: BatchOutcome[] = plans
      .filter((p) => p.kind === 'refused')
      .map((p) => ({ loanId: p.loanId, kind: 'left-out', reason: p.reason }));
    let readyIds = plans.filter((p) => p.kind === 'ready').map((p) => p.loanId);
    const totals = pullTotals(plans);
    const approvals = totals.map((t) => ({ token: t.token, tracker: trackApproval() }));
    const unwindClients = {
      publicClient: ctx.publicClient,
      walletClient,
      owner: address,
      spender: walletChain.diamondAddress,
    };
    const unwindAll = async (): Promise<boolean> =>
      (await Promise.all(approvals.map((a) => a.tracker.unwind(unwindClients)))).every(Boolean);
    try {
      // The wallet must hold every loan's padded figure at once, and one
      // approval covers them all.
      setStage({ kind: 'sending', action, step: 'approving' });
      for (const [i, t] of totals.entries()) {
        await assertErc20BalanceLive({
          publicClient: ctx.publicClient,
          token: t.token,
          owner: address,
          amount: t.approve,
          symbol: meta.data?.symbol,
        });
        await ensureAllowance({
          publicClient: ctx.publicClient,
          walletClient,
          token: t.token,
          owner: address,
          spender: walletChain.diamondAddress,
          amount: t.approve,
          ...approvals[i].tracker.hooks(t.token),
        });
      }
      // LATE re-check: an acceptance, request or offset can land while the
      // wallet waits on the approval.
      setStage({ kind: 'sending', action, step: 'checking' });
      const late = await Promise.all(
        readyIds.map(async (id) => ({ id, reason: await lateBatchRefusal(ctx, byId.get(id)!) })),
      );
      for (const l of late) {
        if (l.reason) leftOut.push({ loanId: l.id, kind: 'left-out', reason: l.reason });
      }
      readyIds = late.filter((l) => !l.reason).map((l) => l.id);
      const functionName = action === 'repay' ? 'repayLoan' : 'precloseDirect';
      const outcomes: BatchOutcome[] = [];
      for (const ids of chunkForMulticall(readyIds)) {
        setStage({ kind: 'sending', action, step: 'submitting' });
        let mined: { block: bigint } | { failure: string };
        try {
          const { receipt } = await write('multicall', [
            encodeBestEffort(ids.map((id) => ({ functionName, args: [BigInt(id)] }))),
          ]);
          mined = { block: receipt.blockNumber };
        } catch (err) {
          mined = { failure: captureTxError(err) };
        }
        outcomes.push(...(await readBack(ctx, ids, functionName, mined)));
      }
      let note: string | null = null;
      if (approvals.length > 0) {
        if (!outcomes.some((o) => o.kind === 'closed')) {
          note = (await unwindAll())
            ? copy.batchClose.approvalReturned
            : copy.errors.approvalCleanupFailed;
        } else {
          // Each close pulls only what it owes, so the pad, and the share
          // of any loan that stayed open, is still approved. Say how much.
          note = await approvalLeftNote(ctx, totals.map((t) => t.token), amount);
        }
      }
      setStage({ kind: 'done', action, outcomes: [...outcomes, ...leftOut], note });
    } catch (err) {
      // Nothing was sent: the failure is in a check or the approval.
      const message = captureTxError(err);
      const unwound = await unwindAll();
      setError(unwound ? message : `${message} ${copy.errors.approvalCleanupFailed}`);
      setStage({ kind: 'review', action, plans });
    } finally {
      for (const key of ['loan', 'loanLive', 'loanLiveStatus', 'myLoans', 'claimables']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }

  const busy = stage.kind === 'planning' || stage.kind === 'sending';
  const ids = group.loans.map((l) => `#${l.loanId}`).join(', ');

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">
        <Layers aria-hidden />
        <h2 style={{ margin: 0 }}>
          {copy.batchClose.title(group.offerId)}
        </h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {copy.batchClose.lede(ids)}
      </p>

      {stage.kind === 'idle' ? (
        <div className="stack" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready}
            onClick={() => void plan('repay')}
          >
            {copy.batchClose.repayAll}
          </button>
          {/* Early close is an Advanced-mode action on the loan page too. */}
          {isAdvanced ? (
            <button
              type="button"
              className="btn"
              disabled={!ready}
              onClick={() => void plan('preclose')}
            >
              {copy.batchClose.closeAllEarly}
            </button>
          ) : null}
        </div>
      ) : null}

      {busy ? (
        <p className="muted">
          <LoaderCircle className="spin" aria-hidden size={16} />{' '}
          {stage.kind === 'planning'
            ? copy.batchClose.checking
            : copy.batchClose.phase[stage.step]}
        </p>
      ) : null}

      {stage.kind === 'review' ? (
        <BatchReview
          action={stage.action}
          plans={stage.plans}
          amount={amount}
          onConfirm={() => void confirm(stage.action, stage.plans)}
          onCancel={() => {
            setError(null);
            setStage({ kind: 'idle' });
          }}
        />
      ) : null}

      {stage.kind === 'done' ? (
        <>
          <ul className="row-list" style={{ listStyle: 'none', padding: 0 }}>
            {stage.outcomes.map((o) => (
              <li key={o.loanId}>{outcomeText(stage.action, o)}</li>
            ))}
          </ul>
          {stage.note ? <p className="muted">{stage.note}</p> : null}
          <button type="button" className="btn" onClick={() => setStage({ kind: 'idle' })}>
            {copy.batchClose.dismiss}
          </button>
        </>
      ) : null}

      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}

function BatchReview({
  action,
  plans,
  amount,
  onConfirm,
  onCancel,
}: {
  action: CloseOutAction;
  plans: CloseOutPlan[];
  amount: (raw: bigint) => string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ready = plans.filter((p) => p.kind === 'ready');
  const totals = pullTotals(plans);
  return (
    <>
      <h3 style={{ marginBottom: 8 }}>
        {action === 'repay' ? copy.batchClose.reviewRepay : copy.batchClose.reviewPreclose}
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {plans.map((p) => (
          <li key={p.loanId}>
            {p.kind === 'ready'
              ? copy.batchClose.dueNow(String(p.loanId), p.pull ? amount(p.pull.due) : '0')
              : copy.batchClose.leftOut(String(p.loanId), p.reason)}
          </li>
        ))}
      </ul>
      {ready.length === 0 ? (
        <p className="muted">{copy.batchClose.noneReady}</p>
      ) : (
        <>
          {totals.map((t) => (
            <p key={t.token} style={{ margin: '0 0 8px' }}>
              {copy.batchClose.totalDue(amount(t.due))}{' '}
              {copy.batchClose.approval(amount(t.approve))}
            </p>
          ))}
          <p className="muted" style={{ marginTop: 0 }}>
            {copy.batchClose.howItRuns}
          </p>
        </>
      )}
      <div className="stack" style={{ flexDirection: 'row', gap: 8 }}>
        {ready.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {copy.batchClose.confirm}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={onCancel}>
          {copy.batchClose.cancel}
        </button>
      </div>
    </>
  );
}

function outcomeText(action: CloseOutAction, o: BatchOutcome): string {
  const id = String(o.loanId);
  switch (o.kind) {
    case 'closed':
      return action === 'repay' ? copy.batchClose.repaid(id) : copy.batchClose.closed(id);
    case 'changed':
      return copy.batchClose.changedOtherwise(id);
    case 'open':
      return copy.batchClose.stillOpen(id, o.reason);
    case 'left-out':
      return copy.batchClose.leftOut(id, o.reason);
    case 'unknown':
      return copy.batchClose.unknown(id);
  }
}

/** The allowance left standing after a batch that closed loans, read
 *  live. One lending asset per offer, so one figure in practice. */
async function approvalLeftNote(
  ctx: CloseOutCtx,
  tokens: readonly `0x${string}`[],
  amount: (raw: bigint) => string,
): Promise<string> {
  try {
    const left = await Promise.all(
      tokens.map((token) =>
        ctx.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ctx.holder, ctx.diamond],
        }),
      ),
    );
    return copy.batchClose.approvalLeft(left.map(amount).join(', '));
  } catch {
    return copy.batchClose.approvalLeftUnread;
  }
}

/**
 * Read each loan back after its transaction. Closed means its live status
 * is Repaid, the status both calls leave; a loan that left Active any
 * other way is reported as changed, not as closed by this batch. After a mined batch the read is pinned to the batch's
 * block, so a node that has not caught up answers "unknown" rather than
 * reporting the loan still open. A loan still open is asked, at that same
 * block, why its call would fail — the multicall skips a failing call
 * without saying why, and a reason read afterwards is a fact about the
 * loan as it stands. After a failed send the read is at the latest block:
 * a transaction can fail to report and still have mined.
 */
async function readBack(
  ctx: CloseOutCtx,
  ids: number[],
  functionName: 'repayLoan' | 'precloseDirect',
  mined: { block: bigint } | { failure: string },
): Promise<BatchOutcome[]> {
  const block = 'block' in mined ? mined.block : undefined;
  return Promise.all(
    ids.map(async (loanId): Promise<BatchOutcome> => {
      try {
        const live = await readLoanLive(ctx.publicClient, ctx.diamond, loanId, block);
        const status = Number(live.status);
        if (status === LoanStatus.Repaid) return { loanId, kind: 'closed' };
        if (status !== LOAN_STATUS_ACTIVE) return { loanId, kind: 'changed' };
        if ('failure' in mined) return { loanId, kind: 'open', reason: mined.failure };
        try {
          await ctx.publicClient.simulateContract({
            account: ctx.holder,
            address: ctx.diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName,
            args: [BigInt(loanId)],
            blockNumber: block,
          });
          return { loanId, kind: 'open', reason: copy.batchClose.skippedRetry };
        } catch (err) {
          return { loanId, kind: 'open', reason: submitErrorText(err) };
        }
      } catch {
        return { loanId, kind: 'unknown' };
      }
    }),
  );
}
