/**
 * One transaction of several protocol steps, through the protocol's batch
 * entry (`MulticallFacet.multicall`, which keeps the signer as the caller of
 * every step). Each step is sent with `allowFailure: false`, so either every
 * step lands or none does, and the batch re-raises the failing step's own
 * revert. The batch ABI carries every error the steps can raise, so that
 * revert is named, and its arguments decoded, as it would be from the step
 * sent alone. One module, so every batched write builds its call the same
 * way (a guarded post, an Auto-lend setup).
 */
import { encodeFunctionData, type Abi } from 'viem';
import { MulticallFacetABI } from '@vaipakam/contracts/abis';

const MULTICALL = MulticallFacetABI as Abi;

/** The batch entry plus every error the steps' ABIs declare, each once. */
export function batchAbi(...steps: readonly Abi[]): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const item of [...MULTICALL, ...steps.flatMap((a) => a.filter((i) => i.type === 'error'))]) {
    const key = item.type === 'error' || item.type === 'function' || item.type === 'event' ? `${item.type}:${item.name}:${JSON.stringify(item.inputs)}` : item.type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out as Abi;
}

/** One step of a batch: a call on one of the steps' ABIs. */
export interface BatchStep {
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** The batch as one contract call, ready for a dry run or a write. */
export function batchCall(steps: readonly BatchStep[]) {
  const calls = steps.map((s) => ({ callData: encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args }), allowFailure: false }));
  return { abi: batchAbi(...steps.map((s) => s.abi)), functionName: 'multicall', args: [calls] as const };
}
