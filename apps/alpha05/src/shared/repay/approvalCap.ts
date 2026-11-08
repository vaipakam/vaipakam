/**
 * The one rule both repayment routes (in full, LN-21; in part, LN-22) state
 * their approval and its limits by. Neither `repayLoan` nor `repayPartial`
 * takes a maximum amount or a deadline, so the allowance is the only cap on
 * what a confirmation can take:
 *
 * - it is set to exactly the reviewed maximum whichever way it stands,
 *   lowered as well as raised (`allowanceSteps(prior, cap)`, no shortcut for
 *   an allowance that already covers it);
 * - it caps the amount, never the time, so the review never promises a
 *   deadline: a later confirmation goes through while the protocol's figure
 *   stays within it, and where the figure did not grow over the window the
 *   review says a later confirmation can still go through.
 */
import { maxUint256 } from 'viem';
import type { CopyAccess } from '../copy/useCopy';
import { exactTokenAmount, type TokenMetaMap } from '../reads/tokens';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** An allowance in words: the largest value, which a wallet's "unlimited"
 *  approval sets, is named as such rather than printed as 78 digits. */
export function allowanceFigure(v: bigint, asset: Hex, meta: TokenMetaMap | null, copy: Copy): string {
  return v === maxUint256 ? copy.text('repay.unlimited') : exactTokenAmount(v, asset, meta, copy.format);
}

/** The approval row: already exact, raised, lowered, or through zero first. */
export function approvalRowText(a: { allowance: bigint; steps: number; cap: bigint }, asset: Hex, meta: TokenMetaMap | null, copy: Copy): string {
  const exact = (v: bigint) => exactTokenAmount(v, asset, meta, copy.format);
  if (a.steps === 0) return copy.format('repay.approvalEnough', { amount: exact(a.allowance) });
  if (a.steps === 2) return copy.format('repay.approvalZeroFirst', { amount: exact(a.cap) });
  if (a.allowance > a.cap) return copy.format('repay.approvalLower', { prior: allowanceFigure(a.allowance, asset, meta, copy), amount: exact(a.cap) });
  return copy.format('repay.approvalNeeded', { amount: exact(a.cap) });
}

/** What a confirmation after the reviewed moment does. `capped`: the moment
 *  is the grace end, after which the protocol refuses any repayment. */
export function lateConfirmationLines(w: { capped: boolean; time: string; totalNow: bigint; totalBy: bigint }, copy: Copy): string[] {
  if (w.capped) return [copy.format('repay.loseGraceEnds', { time: w.time })];
  const lines = [copy.format('repay.loseLate', { time: w.time })];
  if (w.totalBy === w.totalNow) lines.push(copy.text('repay.loseSame'));
  return lines;
}

/** The prompts that may follow a repayment that took effect, to put back
 *  what it did not use of the approval: none when no approval was made; up
 *  to two on a token that needs a step to zero first (only when going back
 *  to a non-zero allowance); otherwise one. */
export function putBackPrompts(approvalSteps: number): number {
  if (approvalSteps === 0) return 0;
  return approvalSteps === 2 ? 2 : 1;
}
