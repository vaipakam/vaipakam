/**
 * "Refinance all" on a borrower's offer-grouped loans (#126 slice 3) — the
 * outcome half.
 *
 * Each loan is planned through the shared request plan
 * (`refinancePlan.ts`), and its calls (the guardrail write when needed,
 * then the request) go to the Diamond's multicall as consecutive items
 * with `allowFailure` set, so a loan whose request fails is skipped while
 * the others post. Which loans the transaction posted a request for is
 * read from its own logs, never assumed from the receipt's status.
 */
import { parseEventLogs, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { submitErrorText } from '../lib/errors';
import { LOAN_STATUS_ACTIVE, readLoanLive } from '../contracts/loanLive';
import { MAX_MULTICALL_CALLS, chunkForMulticall } from './multicall';
import type { Mined } from './batchCloseOut';
import { refinanceCalls, type RefinanceCtx, type RefinanceRequestReady } from './refinancePlan';

/** A loan's outcome after the batch. */
export type RefinanceBatchOutcome =
  /** This batch's transaction posted its request, as offer `offerId`. */
  | { loanId: number; kind: 'posted'; offerId: string }
  /** The loan left Active before its request ran. */
  | { loanId: number; kind: 'changed' }
  /** Sent, and neither confirmed nor refused yet: it may still post. */
  | { loanId: number; kind: 'pending' }
  | { loanId: number; kind: 'open'; reason: string }
  | { loanId: number; kind: 'left-out'; reason: string }
  | { loanId: number; kind: 'unknown' };

/** Loans per transaction. A loan can take two items (the guardrail write
 *  and the request), and a pair is never split across transactions: the
 *  request is refused without the guardrails it needs, so a request sent
 *  apart from its write would only fail. */
export const LOANS_PER_REFINANCE_SEND = Math.floor(MAX_MULTICALL_CALLS / 2);

/** Split the ready loans into sends the facet accepts, order kept. */
export function chunkRefinanceLoans<T>(loans: readonly T[]): T[][] {
  return chunkForMulticall(loans, LOANS_PER_REFINANCE_SEND);
}

/** Every Diamond call one send makes, in order: each loan's pair kept
 *  together. */
export function refinanceSendCalls(
  plans: readonly RefinanceRequestReady[],
): { functionName: string; args: readonly unknown[] }[] {
  return plans.flatMap(refinanceCalls);
}

/**
 * The requests a mined transaction posted, by the loan each one
 * refinances, from its own logs. Every request emits `OfferCreatedDetails`
 * carrying the loan it targets; a multicall item that reverted had its
 * logs rolled back with it, so the logs say exactly which loans got a
 * request — where a later search could not tell this batch's request from
 * one posted elsewhere. Only the Diamond's own logs, and only requests
 * this wallet created, count.
 */
export function requestsInLogs(
  logs: readonly Log[],
  diamond: `0x${string}`,
  creator: `0x${string}`,
): Map<number, string> {
  const ours = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const created = parseEventLogs({
    abi: DIAMOND_ABI_VIEM,
    logs: ours as Log[],
    eventName: 'OfferCreatedDetails',
  }) as unknown as Array<{
    args: {
      offerId: bigint;
      creator: `0x${string}`;
      fields: { refinanceTargetLoanId: bigint };
    };
  }>;
  const out = new Map<number, string>();
  for (const e of created) {
    const target = e.args.fields.refinanceTargetLoanId;
    if (target === 0n || e.args.creator.toLowerCase() !== creator.toLowerCase()) continue;
    out.set(Number(target), e.args.offerId.toString());
  }
  return out;
}

/**
 * Read each loan back after its transaction. Posted only when the
 * transaction's own logs say so. After a PENDING send nothing is read and
 * every other loan is `pending`: posting a request leaves the loan's
 * status as it was, so a loan read as no longer Active may have had its
 * request posted first, and only the send's logs can say. After a mined
 * send a loan without a request is read at the transaction's block: one
 * that left Active is `changed`; one still Active is asked, at that
 * block, why its request would fail — the multicall skips a failing item
 * without saying why. After a send that did not run the read is at the
 * latest block.
 */
export async function readBackRequests(
  ctx: RefinanceCtx,
  planned: readonly RefinanceRequestReady[],
  mined: Mined,
): Promise<RefinanceBatchOutcome[]> {
  const posted =
    'block' in mined ? requestsInLogs(mined.logs, ctx.diamond, ctx.holder) : new Map();
  const block = 'block' in mined ? mined.block : undefined;
  return Promise.all(
    planned.map(async (plan): Promise<RefinanceBatchOutcome> => {
      const { loanId } = plan;
      const offerId = posted.get(loanId);
      if (offerId !== undefined) return { loanId, kind: 'posted', offerId };
      if ('pending' in mined) return { loanId, kind: 'pending' };
      try {
        const live = await readLoanLive(ctx.publicClient, ctx.diamond, loanId, block);
        if (live.status !== LOAN_STATUS_ACTIVE) return { loanId, kind: 'changed' };
        if ('failure' in mined) return { loanId, kind: 'open', reason: mined.failure };
        try {
          // The guardrail write ran in the same item list, so at this
          // block the request alone says why it was refused.
          await ctx.publicClient.simulateContract({
            account: ctx.holder,
            address: ctx.diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'createOffer',
            args: [plan.payload],
            blockNumber: block,
          });
          return { loanId, kind: 'open', reason: copy.batchRefinance.skippedRetry };
        } catch (err) {
          return { loanId, kind: 'open', reason: submitErrorText(err) };
        }
      } catch {
        return { loanId, kind: 'unknown' };
      }
    }),
  );
}

/** Set the approval back only when it is ESTABLISHED that no request was
 *  posted: a pending or unreadable outcome may be a request that needs
 *  it, and removing that would leave a lender's acceptance unable to
 *  collect the payoff. */
export function noRequestPosted(outcomes: readonly RefinanceBatchOutcome[]): boolean {
  return outcomes.every((o) => o.kind === 'open' || o.kind === 'changed');
}

/** What the ready requests need, summed per token: the approval (each
 *  request's largest possible wallet share of its payoff, #3042) and the
 *  spare balance (each one's top-up today). One lending asset per offer, so one entry in practice. */
export function refinanceTotals(
  plans: readonly RefinanceRequestReady[],
): { token: `0x${string}`; approval: bigint; topUp: bigint }[] {
  const byToken = new Map<string, { token: `0x${string}`; approval: bigint; topUp: bigint }>();
  for (const p of plans) {
    const token = p.liveLoan.principalAsset;
    const prev = byToken.get(token.toLowerCase());
    byToken.set(
      token.toLowerCase(),
      prev
        ? { token: prev.token, approval: prev.approval + p.approval, topUp: prev.topUp + p.topUp }
        : { token, approval: p.approval, topUp: p.topUp },
    );
  }
  return [...byToken.values()];
}
