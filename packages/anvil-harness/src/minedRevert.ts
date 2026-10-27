/**
 * Why a mined transaction reverted (#2892).
 *
 * Every harness write simulates before it sends, so a revert the simulation
 * sees surfaces as the contract's own error. One that simulates clean and
 * reverts only when mined does not: all the receipt says is "reverted", on a
 * node the suite throws away. {@link explainMinedRevert} reads the cause from
 * the node while it is still up. The scenario chain's writes and the CCIP
 * relay's deliveries both report through it, so the two cannot drift apart.
 *
 * It imports no ABI of its own: each caller names the ABIs to decode with.
 * The deploy fixture is loaded by the connected app's Playwright suite, whose
 * Node loader refuses the contracts package's bare JSON imports, so a module
 * the fixture reaches must not pull in the Diamond union.
 */
import { BaseError, decodeErrorResult, type Abi, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import type { AnvilControl } from './rpc';
/** Revert data of a call frame, where the node reports it. */
interface CallTrace {
  output?: Hex;
  error?: string;
}

/**
 * Why a mined transaction reverted, in one line (#2892).
 *
 * A write that simulated clean and reverted when mined leaves only a receipt
 * that says "reverted", on a node the suite discards. This reads the cause
 * while the node is still up:
 *
 *   1. the node's own trace of the mined execution (`debug_traceTransaction`
 *      with the call tracer), so the revert data is the data the mined
 *      transaction actually produced;
 *   2. when the node gives no trace, the same call (same sender, calldata,
 *      value and gas limit) replayed against the state before its block.
 *      That is a reconstruction, and the line says so: it runs under the
 *      earlier block's timestamp and without any transaction mined before it
 *      in the same block.
 *
 * The data is decoded with each of `abis` in turn (a Diamond write passes the
 * facet's ABI and then the Diamond union, so a revert raised by another facet
 * still gets its name). The line
 * also names the block, its timestamp and the gas used against the limit, so
 * an out-of-gas or a clock-dependent revert is visible without the node.
 *
 * Best-effort throughout: a failure to explain never replaces the revert.
 */
export async function explainMinedRevert(
  pub: PublicClient,
  rpc: AnvilControl['rpc'],
  receipt: TransactionReceipt,
  abis: readonly Abi[],
): Promise<string> {
  const parts: string[] = [];
  let block: { timestamp: bigint } | undefined;
  let tx: Awaited<ReturnType<PublicClient['getTransaction']>> | undefined;
  try {
    block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  } catch {
    /* no timestamp to report */
  }
  try {
    tx = await pub.getTransaction({ hash: receipt.transactionHash });
  } catch {
    /* no gas limit or calldata to report */
  }
  parts.push(`block ${receipt.blockNumber}${block ? ` at timestamp ${block.timestamp}` : ''}`);
  parts.push(`gas ${receipt.gasUsed}${tx ? ` of ${tx.gas}${receipt.gasUsed >= tx.gas ? ' (all of it)' : ''}` : ''}`);

  let data: Hex | undefined;
  let source = '';
  let nodeError: string | undefined;
  try {
    const trace = await rpc<CallTrace>('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]);
    data = trace.output;
    nodeError = trace.error;
    source = 'mined trace';
  } catch {
    /* the node has no tracer: replay below */
  }
  if (source === '' && tx && tx.to && receipt.blockNumber > 0n) {
    source = `replayed at block ${receipt.blockNumber - 1n}`;
    try {
      // Under the mined gas limit, so an out-of-gas reproduces as one.
      await pub.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber - 1n });
      return `${parts.join(', ')}: the replay did not revert, so the cause depends on the mined block itself (its timestamp, or a transaction before it in the block)`;
    } catch (e) {
      const raw = e instanceof BaseError ? e.walk((x) => typeof (x as { data?: unknown }).data === 'string') : undefined;
      data = (raw as { data?: Hex } | undefined)?.data;
      // #2759 — a caught value becomes text only as a bounded description:
      // viem's shortMessage carries no request URL; anything else, its class name.
      nodeError = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.name : 'a non-Error value was thrown';
    }
  }
  if (source === '') return `${parts.join(', ')}: no trace and no replay were possible`;
  return `${parts.join(', ')}; ${source}: ${describeRevertData(data, abis, nodeError)}`;
}

/** A revert's data as `ErrorName(args)`, or what the node said when it has none. */
function describeRevertData(data: Hex | undefined, abis: readonly Abi[], nodeError: string | undefined): string {
  if (!data || data === '0x') {
    return `no revert data${nodeError ? ` (node: ${nodeError})` : ''}, which is a bare revert or running out of gas`;
  }
  for (const candidate of abis) {
    try {
      const d = decodeErrorResult({ abi: candidate, data });
      const args = (d.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : JSON.stringify(a))).join(', ');
      return `${d.errorName}(${args})`;
    } catch {
      /* not in this ABI */
    }
  }
  return `undecoded revert data ${data}`;
}
