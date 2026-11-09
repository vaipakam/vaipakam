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
 * closed by someone else since the plan, say). The batch is then simulated
 * best-effort, which reports each item's outcome, and the estimate is taken
 * on the WHOLE batch again with each item that ran marked must-succeed and
 * each item that failed left best-effort. Nothing is dropped or reordered:
 * a later item can depend on an earlier one (a refinance request is refused
 * until the item before it sets its caps), and an item that fails still runs
 * and still spends gas before it refuses. So the figure counts every item's
 * cost, and an item expected to run cannot be starved inside it.
 *
 * When nothing would run, or the chain moved between the two reads so the
 * marked batch reverts too, there is no figure to give and the wallet estimates.
 * The batch can then only skip, and its read-back says so.
 *
 * @returns The limit to send with, or `undefined` to leave it to the wallet.
 */
export async function bestEffortGasLimit(
  calls: readonly EncodedMulticallCall[],
  node: {
    /** Estimates one `multicall` with these items; rejects when it reverts. */
    estimate: (calls: EncodedMulticallCall[]) => Promise<bigint>;
    /** Runs one `multicall` with these items and returns its results. */
    simulate: (calls: EncodedMulticallCall[]) => Promise<readonly MulticallResult[]>;
  },
): Promise<bigint | undefined> {
  const strict = calls.map((c) => ({ ...c, allowFailure: false }));
  try {
    return gasLimitFromEstimate(await node.estimate(strict));
  } catch {
    // Some item would revert now; size from the ones that run.
  }
  try {
    const results = await node.simulate([...calls]);
    const marked = calls.map((c, i) => ({ ...c, allowFailure: results[i]?.success !== true }));
    if (marked.every((c) => c.allowFailure)) return undefined;
    return gasLimitFromEstimate(await node.estimate(marked));
  } catch {
    return undefined;
  }
}
