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
import { gasLimitFromEstimate } from '@vaipakam/lib/gasLimit';

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

/**
 * The gas limit a best-effort batch is sent with (#126).
 *
 * A node's estimate for a best-effort batch is too low, and fatally so.
 * `eth_estimateGas` looks for the lowest limit at which the OUTER call
 * succeeds, and with `allowFailure: true` the outer call succeeds even when
 * every item inside it ran out of gas: the facet records each one as
 * skipped and returns. Each nested call only gets 63/64 of what is left, so
 * a limit just above what the items use leaves them short, they fail out of
 * gas, and the batch mines "successfully" having closed nothing. That is
 * what a two-loan Repay all did on Anvil: both loans skipped, while each
 * one repaid fine on its own at the same block.
 *
 * So the estimate is taken on the STRICT form of the same batch, every item
 * `allowFailure: false`. There an item that runs out of gas reverts the
 * whole call, so the estimate has to give every item what it needs. The
 * batch is still SENT best-effort, at that estimate plus the shared margin.
 *
 * When the strict form reverts, some item would fail now anyway (a loan
 * closed by someone else since the plan, say). Each item is then estimated
 * on its own, strict, and the limit is the sum of the ones that would run,
 * plus the margin. The sum counts the base transaction cost once per item,
 * so it errs high; unused gas is not charged. When no item would run, there
 * is no figure to give and the wallet estimates as before: the batch can
 * only skip, and its read-back says so.
 *
 * @param estimate Estimates one `multicall` with the given items, rejecting
 *                 when it would revert.
 * @returns The limit to send with, or `undefined` to leave it to the wallet.
 */
export async function bestEffortGasLimit(
  calls: readonly EncodedMulticallCall[],
  estimate: (calls: EncodedMulticallCall[]) => Promise<bigint>,
): Promise<bigint | undefined> {
  const strict = calls.map((c) => ({ ...c, allowFailure: false }));
  try {
    return gasLimitFromEstimate(await estimate(strict));
  } catch {
    // Some item would revert now; size from the ones that would run.
  }
  const alone = await Promise.all(strict.map((c) => estimate([c]).catch(() => null)));
  const running = alone.filter((g): g is bigint => g !== null);
  if (running.length === 0) return undefined;
  return gasLimitFromEstimate(running.reduce((a, g) => a + g, 0n));
}
