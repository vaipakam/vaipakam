/**
 * What the transaction explainer needs from a node, shared by its two callers
 * (#3917, #3919): the operator command `bin/explain-tx.ts` and the failed
 * transaction pass. One list of ABIs, one tracer configuration, one reading
 * of a receipt and one failure description, so the two cannot decode the same
 * transaction differently.
 */
import { parseAbi, type Abi } from 'viem';
import * as abis from '@vaipakam/contracts/abis';
import type { ReceiptFacts } from './txExplainer';

/** The node's call tracer, with the events each call emitted. */
export const CALL_TRACER = { tracer: 'callTracer', tracerConfig: { withLog: true } } as const;

/**
 * The outside interfaces a platform transaction routinely calls: tokens and
 * price feeds. Only what decoding needs; the platform's own ABIs come first.
 */
export const OUTSIDE_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

let cachedAbis: Abi[] | undefined;
/**
 * Every ABI the platform ships (the Diamond union and each standalone
 * contract), then the outside interfaces. Built once, and always the same
 * array, so the explainer's decoding tables are built once per process.
 */
export function platformAbis(): Abi[] {
  cachedAbis ??= [abis.DIAMOND_ABI_VIEM as Abi]
    .concat(Object.entries(abis).filter(([k, v]) => k.endsWith('ABI') && Array.isArray(v)).map(([, v]) => v as unknown as Abi))
    .concat([OUTSIDE_ABI as Abi]);
  return cachedAbis;
}

/** A receipt as the explainer compares it. */
export function receiptFacts(r: {
  status: string;
  gasUsed: bigint;
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}): ReceiptFacts {
  return {
    status: r.status === 'success' || r.status === '0x1' ? 'success' : 'reverted',
    gasUsed: r.gasUsed,
    logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
  };
}

/**
 * A failure described without the request. viem's long message carries the
 * endpoint, and node endpoints carry API keys, so only the short message (or
 * the error's name) is ever shown.
 */
export function boundedFailure(e: unknown): string {
  const short = (e as { shortMessage?: unknown })?.shortMessage;
  if (typeof short === 'string') return short;
  return e instanceof Error ? e.name : 'an unknown failure';
}
