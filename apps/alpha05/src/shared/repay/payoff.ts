/**
 * LN-16 / LN-21 — what a full repayment costs, from the protocol's own
 * settlement figure (`calculateRepaymentAmount`), never from app arithmetic.
 *
 * The figure grows while the loan runs (interest accrues by the second on a
 * pro-rata loan, and a late fee starts at the due date), and the protocol
 * pulls the figure as of the block the repayment confirms in. So the review
 * states two of the protocol's own figures: the payoff now, and the payoff
 * at a moment a short while ahead, read by asking the same view with the
 * block time moved forward. The approval is sized to the later figure; what
 * the repayment does not use is put back afterwards.
 *
 * Whether a connection honoured the moved block time is checked, not
 * assumed: the same request reads the block time it ran under, and a
 * connection that ignored the move is passed over like an outage, so a
 * figure "ahead" is never really today's.
 */
import { hexToBigInt, type Abi, type PublicClient } from 'viem';
import { RepayFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const REPAY = RepayFacetABI as Abi;

/** How far ahead the approval reaches: long enough for the wallet steps,
 *  short enough that a repayment confirmed later is refused rather than
 *  drawing on an open-ended approval. */
export const PAYOFF_WINDOW_SECONDS = 30 * 60;

/** Code that returns the block time it runs under (TIMESTAMP, PUSH0,
 *  MSTORE, PUSH1 32, PUSH0, RETURN), run as a call with no target. */
const BLOCK_TIME_PROBE: Hex = '0x425f5260205ff3';

export interface Payoff {
  /** The protocol's figure as of the latest block. */
  now: bigint;
  /** The latest block's time (unix seconds). */
  chainNow: bigint;
  /** The protocol's figure as of `by`. */
  atBy: bigint;
  /** The moment `atBy` is read for (unix seconds). */
  by: bigint;
}

/** The connection did not run the request at the moved block time. */
export class FutureReadUnsupported extends Error {
  constructor() {
    super('this connection cannot read the payoff at a later moment');
  }
}

/** The payoff as of `at` (unix seconds), from one connection, refused when
 *  that connection ignored the moved block time. */
export async function readPayoffAt(client: PublicClient, diamond: Hex, loanId: bigint, at: bigint): Promise<bigint> {
  const blockOverrides = { time: at };
  const [probe, due] = await Promise.all([
    client.call({ data: BLOCK_TIME_PROBE, blockOverrides }),
    client.readContract({ address: diamond, abi: REPAY, functionName: 'calculateRepaymentAmount', args: [loanId], blockOverrides }) as Promise<bigint>,
  ]);
  if (!probe.data || hexToBigInt(probe.data) !== at) throw new FutureReadUnsupported();
  return due;
}

/**
 * The payoff now and as of `min(now + window, cap)`. `cap` is the last
 * moment a repayment is accepted (the end of the grace period on a running
 * loan), or null when there is none (a loan in fallback, which a repayment
 * cures); past it the figure would be for a repayment the protocol refuses.
 */
export async function readPayoff(client: PublicClient, diamond: Hex, loanId: bigint, cap: bigint | null): Promise<Payoff> {
  // The figure "now" is read at the block whose time is stated with it.
  const block = await client.getBlock({ blockTag: 'latest' });
  const now = (await client.readContract({ address: diamond, abi: REPAY, functionName: 'calculateRepaymentAmount', args: [loanId], blockNumber: block.number })) as bigint;
  const chainNow = block.timestamp;
  const ahead = chainNow + BigInt(PAYOFF_WINDOW_SECONDS);
  const by = cap !== null && cap < ahead ? (cap > chainNow ? cap : chainNow) : ahead;
  const atBy = by === chainNow ? now : await readPayoffAt(client, diamond, loanId, by);
  return { now, chainNow, atBy, by };
}
