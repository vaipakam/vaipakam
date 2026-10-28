/**
 * The Diamond's `MulticallFacet.multicall` as the app uses it — shared by
 * Claim all (#1268) and the batch close-out on Positions (#126).
 *
 * Each item runs in its own delegatecall frame as the user, so every
 * call keeps its own checks (position NFT, grace, sanctions, pause). With
 * `allowFailure: true` an item that reverts is skipped and rolls back
 * only its own frame; the rest still run.
 */
import { encodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/** Mirrors `MulticallFacet.MAX_MULTICALL_CALLS` — a batch past it reverts
 *  `MulticallTooLarge`, so callers split or cap at this size. */
export const MAX_MULTICALL_CALLS = 30;

/** One encoded `MulticallFacet.Call`. */
export interface EncodedMulticallCall {
  callData: `0x${string}`;
  allowFailure: boolean;
}

/** One `MulticallFacet.Result`, index-aligned with its call. */
export interface MulticallResult {
  success: boolean;
  returnData: `0x${string}`;
}

/** Encode Diamond calls as best-effort multicall items. */
export function encodeBestEffort(
  calls: readonly { functionName: string; args: readonly unknown[] }[],
): EncodedMulticallCall[] {
  return calls.map((c) => ({
    callData: encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName: c.functionName,
      args: c.args as unknown[],
    }),
    allowFailure: true,
  }));
}

/** Split into batches the facet accepts, order kept. */
export function chunkForMulticall<T>(items: readonly T[], size = MAX_MULTICALL_CALLS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
