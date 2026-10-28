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
  planCloseOutForBatch,
  type CloseOutAction,
  type CloseOutCtx,
  type CloseOutPlan,
} from '../data/closeOutPlan';
import { ConfirmReceipt } from './ConfirmReceipt';
import {
  pullTotals,
  settleFailedSend,
  type BatchOutcome,
  type Mined,
  type OfferGroup,
} from '../data/batchCloseOut';
import { chunkForMulticall, encodeBestEffort } from '../data/multicall';

type Stage =
  | { kind: 'idle' }
  | { kind: 'planning'; action: CloseOutAction }
  | { kind: 'review'; action: CloseOutAction; plans: CloseOutPlan[] }
  | { kind: 'sending'; action: CloseOutAction; step: 'approving' | 'checking' | 'submitting' }
  | { kind: 'done'; action: CloseOutAction; outcomes: BatchOutcome[]; note: string | null };

export function BatchCloseOutCard({
  group,
  onHeldChange,
}: {
  group: OfferGroup<PositionLoan>;
  /** Told when the card starts a batch (true) and when its results are
   *  dismissed (false), so the page keeps it mounted in between even if
   *  the batch leaves the offer with fewer than two open loans. */
  onHeldChange?: (group: OfferGroup<PositionLoan>, held: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();
  const { isAdvanced } = useMode();
  const meta = useTokenMeta(group.loans[0]?.lendingAsset);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // Hold the card from the first step past idle until it is dismissed
  // (both transitions happen only here, in event handlers).
  const start = (action: CloseOutAction) => {
    if (!ctx) return;
    onHeldChange?.(group, true);
    void plan(action);
  };
  const toIdle = () => {
    setError(null);
    setStage({ kind: 'idle' });
    onHeldChange?.(group, false);
  };

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
    const readyIds = plans.filter((p) => p.kind === 'ready').map((p) => p.loanId);
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
      const functionName = action === 'repay' ? 'repayLoan' : 'precloseDirect';
      const outcomes: BatchOutcome[] = [];
      const chunks = chunkForMulticall(readyIds);
      // Whether an earlier send is unsettled. Kept from the SEND, not from
      // its loans' outcomes: a pending send whose loans could not be read
      // back is still pending.
      let sendPending = false;
      for (const [index, planned] of chunks.entries()) {
        // A transaction still unconfirmed may yet spend the approval, so
        // nothing more is sent behind it; the rest wait for their pages.
        if (sendPending) {
          for (const id of chunks.slice(index).flat()) {
            leftOut.push({ loanId: id, kind: 'left-out', reason: copy.batchClose.notSentPending });
          }
          break;
        }
        // LATE re-check, immediately before EACH send: the loan is planned
        // again in full — the same checks as the review, not a subset —
        // because the wallet may have waited on the approval, or on the
        // previous chunk, while a sale was accepted, a request or offset
        // posted, or the position NFT moved (repayLoan is permissionless,
        // so only this check keeps the wallet from paying for a position
        // it no longer holds).
        setStage({ kind: 'sending', action, step: 'checking' });
        const late = await Promise.all(
          planned.map((id) => planCloseOutForBatch(ctx, byId.get(id)!, action)),
        );
        for (const p of late) {
          if (p.kind === 'refused') leftOut.push({ loanId: p.loanId, kind: 'left-out', reason: p.reason });
        }
        const ids = late.filter((p) => p.kind === 'ready').map((p) => p.loanId);
        if (ids.length === 0) continue;
        setStage({ kind: 'sending', action, step: 'submitting' });
        let submitted: `0x${string}` | null = null;
        let mined: Mined;
        try {
          const { receipt } = await write(
            'multicall',
            [encodeBestEffort(ids.map((id) => ({ functionName, args: [BigInt(id)] })))],
            { onSubmitted: (hash) => (submitted = hash) },
          );
          mined = { block: receipt.blockNumber };
        } catch (err) {
          mined = await settleFailedSend(ctx.publicClient, submitted, err);
        }
        sendPending = 'pending' in mined;
        outcomes.push(...(await readBack(ctx, ids, functionName, mined)));
      }
      let note: string | null = null;
      if (approvals.length > 0) {
        // Set the approval back only when it is ESTABLISHED that no loan
        // closed: an unreadable outcome may be a close that spent part of
        // it. Either way the figure stated is the one read from the chain
        // afterwards, never what the unwind is assumed to have done — the
        // unwind leaves an allowance it did not write untouched.
        const noneClosed = outcomes.every((o) => o.kind === 'open' || o.kind === 'changed');
        const cleanupFailed = noneClosed && !(await unwindAll());
        const left = await approvalLeftNote(ctx, totals.map((t) => t.token), amount);
        note = cleanupFailed ? `${copy.errors.approvalCleanupFailed} ${left}` : left;
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
            onClick={() => start('repay')}
          >
            {copy.batchClose.repayAll}
          </button>
          {/* Early close is an Advanced-mode action on the loan page too. */}
          {isAdvanced ? (
            <button
              type="button"
              className="btn"
              disabled={!ready}
              onClick={() => start('preclose')}
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
          onCancel={toIdle}
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
          <button type="button" className="btn" onClick={toIdle}>
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
  const repay = action === 'repay';
  return (
    <>
      <h3 style={{ marginBottom: 8 }}>
        {repay ? copy.batchClose.reviewRepay : copy.batchClose.reviewPreclose}
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {plans.map((p) => (
          <li key={p.loanId} style={{ marginBottom: 6 }}>
            {p.kind === 'ready'
              ? copy.batchClose.dueNow(String(p.loanId), p.pull ? amount(p.pull.due) : '0')
              : copy.batchClose.leftOut(String(p.loanId), p.reason)}
            {/* What the loan page says before this action is signed. */}
            {p.kind === 'ready' && p.notes.length > 0 ? (
              <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {ready.length === 0 ? (
        <>
          <p className="muted">{copy.batchClose.noneReady}</p>
          <button type="button" className="btn" onClick={onCancel}>
            {copy.batchClose.cancel}
          </button>
        </>
      ) : (
        // The same six-row review every other write shows, worded for
        // several loans.
        <ConfirmReceipt
          busy={false}
          confirmLabel={copy.batchClose.confirm}
          onBack={onCancel}
          onConfirm={onConfirm}
          data={{
            youReceive: copy.batchClose.receiveEach,
            youLock: copy.positions.details.receipt.nothingNew,
            youMayOwe: [
              ...totals.map(
                (t) =>
                  `${copy.batchClose.totalDue(amount(t.due))} ${copy.batchClose.approval(amount(t.approve))}`,
              ),
              copy.batchClose.howItRuns,
            ].join(' '),
            youCanLose: repay
              ? copy.positions.details.receipt.loseNothingBeyondOwed
              : copy.positions.details.receipt.loseNothingBeyondPay,
            fees: repay
              ? copy.positions.details.receipt.feesRepay
              : copy.positions.details.receipt.feesPreclose,
            whenThisEnds: copy.batchClose.endsEach,
          }}
        />
      )}
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
    case 'pending':
      return copy.batchClose.pending(id);
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
 * loan as it stands. After a failed or pending send the read is at the
 * latest block: a loan its transaction already closed reads closed, and
 * one still Active reads pending (never open) while that send is pending.
 */
async function readBack(
  ctx: CloseOutCtx,
  ids: number[],
  functionName: 'repayLoan' | 'precloseDirect',
  mined: Mined,
): Promise<BatchOutcome[]> {
  const block = 'block' in mined ? mined.block : undefined;
  return Promise.all(
    ids.map(async (loanId): Promise<BatchOutcome> => {
      try {
        const live = await readLoanLive(ctx.publicClient, ctx.diamond, loanId, block);
        const status = Number(live.status);
        if (status === LoanStatus.Repaid) return { loanId, kind: 'closed' };
        if (status !== LOAN_STATUS_ACTIVE) return { loanId, kind: 'changed' };
        if ('pending' in mined) return { loanId, kind: 'pending' };
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
