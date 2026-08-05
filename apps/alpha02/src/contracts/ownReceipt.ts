/**
 * Wait for the receipt of the transaction WE sent (#1529 review rounds
 * 10-11).
 *
 * viem's `waitForTransactionReceipt` follows REPLACEMENTS. When the user
 * cancels a pending transaction (a zero-value self-send at the same
 * nonce) or speeds it up, the wait does not fail — it resolves with the
 * REPLACEMENT's receipt, and for a cancel that receipt reads
 * `status: 'success'`. A transaction that did nothing we asked for
 * therefore presents exactly like one that did.
 *
 * Every `status === 'success'` check in this codebase rested on that not
 * happening. Round 10 found it in one approve; round 11 found the same
 * unsound assumption in three more places, which is what makes it worth a
 * shared helper rather than a fourth local patch. The generic test is
 * cheap and needs no knowledge of what the call was for: the receipt has
 * to belong to the hash we submitted.
 *
 * `settled()` is the generic form. Where the intended effect is itself
 * cheaply observable — an allowance, an approval flag — prefer reading
 * that instead: state answers "did what I wanted happen?" while a receipt
 * only answers "did some transaction happen?", and state subsumes reorgs
 * and RPC lies as well as replacements. See `ensureAllowance`, which
 * confirms on the allowance itself.
 */
import type { PublicClient } from 'viem';

export interface SettledTx {
  /** True only when OUR transaction mined successfully. */
  ok: boolean;
  /** The submitted transaction was replaced (cancelled or sped up). */
  replaced: boolean;
  /** Our transaction mined but reverted. */
  reverted: boolean;
}

export async function settled(
  publicClient: PublicClient,
  hash: `0x${string}`,
): Promise<SettledTx> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A different hash means viem followed a replacement — the outcome
  // belongs to some other transaction, whatever its status says.
  const replaced =
    receipt.transactionHash.toLowerCase() !== hash.toLowerCase();
  const reverted = !replaced && receipt.status !== 'success';
  return { ok: !replaced && !reverted, replaced, reverted };
}

/** `settled`, but throwing the right sentence for the common case where
 *  the caller has nothing to do but report failure. */
export async function assertSettled(
  publicClient: PublicClient,
  hash: `0x${string}`,
  what: string,
): Promise<void> {
  const r = await settled(publicClient, hash);
  if (r.replaced) {
    throw new Error(
      `${what} was cancelled or replaced before it took effect (${hash})`,
    );
  }
  if (r.reverted) throw new Error(`${what} reverted (${hash})`);
}
