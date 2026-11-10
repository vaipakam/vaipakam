/**
 * Why a mined transaction reverted (rulebook RB-FUNDS, #3482), read from
 * the chain after the fact, so the finish card says more than "it was
 * refused" where the chain lets it.
 *
 * Two readings, in order of certainty:
 * - The receipt used ALL the gas the transaction allowed. A refusal by the
 *   protocol returns the unused gas, so spending the whole allowance means
 *   it most likely ran out of gas. The figures are facts; the cause is
 *   stated as the likely one.
 * - Otherwise the call is replayed on the state just before its block and
 *   the protocol's refusal is decoded. A transaction earlier in the same
 *   block can change that state, so the replay names the LIKELY reason; a
 *   replay that goes through says that something in the block changed what
 *   the call relied on; a replay that cannot be run says why.
 *
 * Nothing here can turn a revert into a success: it only explains one.
 */
import type { Hex } from 'viem';
import type { CopyKey } from '../copy/useCopy';
import { UNRECOGNISED, USER_REJECTED, refusalFromError } from '../eligibility/refusal';
import { formatExact } from '../ui/format';

export type RevertCause =
  /** The whole gas allowance was spent: most likely out of gas. */
  | { kind: 'out-of-gas'; gasLimit: bigint }
  /** The replay on the state before its block was refused, and why. */
  | { kind: 'refused'; reason: string }
  /** The replay went through: the block changed what the call relied on. */
  | { kind: 'replay-passes' }
  /** The cause could not be read (the transaction or the replay). */
  | { kind: 'unread'; reason: string };

/** What the reading needs from a chain client (a viem public client). */
export interface RevertReader {
  getTransaction: (args: { hash: Hex }) => Promise<{ from: Hex; to: Hex | null; input: Hex; value: bigint; gas: bigint }>;
  call: (args: { account: Hex; to: Hex; data: Hex; value: bigint; gas: bigint; blockNumber: bigint }) => Promise<unknown>;
}

export interface RevertedReceipt {
  transactionHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

function short(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.split('\n')[0]?.slice(0, 160) || 'no reason given';
}

export async function readRevertCause(client: RevertReader, receipt: RevertedReceipt): Promise<RevertCause> {
  let tx: Awaited<ReturnType<RevertReader['getTransaction']>>;
  try {
    tx = await client.getTransaction({ hash: receipt.transactionHash });
  } catch (e) {
    return { kind: 'unread', reason: `the transaction could not be read: ${short(e)}` };
  }
  if (receipt.gasUsed >= tx.gas) return { kind: 'out-of-gas', gasLimit: tx.gas };
  // A contract creation has no `to`; nothing in this app sends one.
  if (tx.to === null || receipt.blockNumber === 0n) return { kind: 'unread', reason: 'there is no earlier state to replay it on' };
  try {
    await client.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber - 1n });
  } catch (e) {
    const refusal = refusalFromError(e);
    // An error the decoder cannot name is a refusal only when the node
    // says the call reverted; otherwise the replay itself may have failed
    // (the node keeps no older state, say), so it is reported as unread
    // rather than as a reason.
    if (refusal.code === USER_REJECTED || (refusal.code === UNRECOGNISED && !/revert/i.test(short(e)))) {
      return { kind: 'unread', reason: `the replay failed: ${short(e)}` };
    }
    return { kind: 'refused', reason: refusal.reason };
  }
  return { kind: 'replay-passes' };
}

/** A reason ends as a sentence, so the copy around it reads on. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The sentence the finish card adds to "it reverted", from the cause. */
export function revertSentence(cause: RevertCause, format: (key: CopyKey, vars: Record<string, string>) => string): string {
  switch (cause.kind) {
    case 'out-of-gas':
      return format('flow.revertOutOfGas', { gas: formatExact(cause.gasLimit, 0) });
    case 'refused':
      return format('flow.revertRefused', { reason: sentence(cause.reason) });
    case 'replay-passes':
      return format('flow.revertReplayPasses', {});
    case 'unread':
      return format('flow.revertUnread', { reason: sentence(cause.reason) });
  }
}
