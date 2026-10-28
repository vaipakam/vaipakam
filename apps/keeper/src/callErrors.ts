// apps/keeper/src/callErrors.ts
//
// What a failed call says, for every pass that simulates before it sends
// (the day-close pass and the reward close-out pass): a
// contract that ANSWERED and refused is a refusal, with its reason; anything
// else (a transport error, a timeout, an RPC rejection) says nothing about the
// call, and is never reported as the contract's answer.

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
import { describeFailure } from '@vaipakam/lib/errorDescription';

export function classify(err: unknown): { refused: string } | { unread: string } {
  const answered = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
  return answered ? { refused: revertName(err) ?? shortErr(err) } : { unread: shortErr(err) };
}

/** The decoded custom error a call reverted with, when the ABI names it. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

/** The decoded arguments of the custom error a call reverted with, when the
 *  ABI names it (empty otherwise). */
export function revertArgs(err: unknown): readonly unknown[] {
  if (!(err instanceof BaseError)) return [];
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? (r.data?.args ?? []) : [];
}

/** viem's one-line summary when there is one; otherwise a bounded description
 *  that never carries the raw message (RPC URLs carry API keys). */
export function shortErr(err: unknown): string {
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  return (typeof short === 'string' && short.length > 0 ? short : describeFailure(err)).slice(0, 200);
}
