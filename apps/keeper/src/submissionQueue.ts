/**
 * One transaction at a time per keeper account per chain (#2486).
 *
 * Every signing pass a tick launches runs as its own task and signs with
 * the same keeper key. Without coordination, two passes sending on one
 * chain in one tick can both read the same pending nonce before either
 * broadcast is visible. One transaction is then rejected (`nonce too low`,
 * `replacement underpriced`) or silently replaces the other, even when
 * they act on different loans.
 *
 * So every send goes through {@link withSubmissionSlot}: a per-key queue
 * that admits one send at a time. Inside its slot a send reads the pending
 * nonce fresh, prepares, signs and broadcasts; the next send starts only
 * after that broadcast has returned or failed.
 *
 * ## Why not viem's `nonceManager`
 *
 * It hands out a nonce in `prepareTransactionRequest`, before gas
 * estimation. A send whose estimate then reverts (common here: a loan
 * someone else already closed) leaves it remembering a nonce that was
 * never broadcast, and the next send takes the one after it. That is a
 * nonce gap, and every later keeper transaction on the chain waits behind
 * it. Here a nonce is remembered only after a broadcast the RPC accepted.
 *
 * ## The remembered floor
 *
 * Reading the pending count right after a broadcast is usually enough,
 * but a load-balanced RPC can answer from a node that has not seen the
 * transaction yet. So a slot also remembers the nonce after the last
 * accepted broadcast and uses whichever is higher. The floor expires after
 * {@link FLOOR_TTL_MS}: if a broadcast the RPC accepted is then dropped,
 * the gap it leaves lasts at most that long before the pending count is
 * trusted again. A broadcast that threw records nothing, because whether
 * it was relayed is unknown and a guessed floor could open a gap.
 *
 * ## Scope
 *
 * The queue lives in this isolate's memory. It orders every pass of one
 * tick, and of overlapping ticks that land in the same isolate. Two ticks
 * running at once in DIFFERENT isolates are not ordered by it. At a
 * one-minute cadence that needs a tick still sending a minute after it
 * started, which the free plan's CPU limit makes unlikely but does not
 * rule out. If it happens, one send fails with a nonce error and is
 * retried by its pass on a later tick; nothing is lost or doubled.
 */
import type { Account, Address, WalletClient } from 'viem';
import { getTransactionCount, sendTransaction } from 'viem/actions';

/** How long a remembered nonce outranks the RPC's pending count. */
export const FLOOR_TTL_MS = 60_000;

interface Floor {
  next: number;
  at: number;
}

const tails = new Map<string, Promise<void>>();
const floors = new Map<string, Floor>();

function keyOf(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** Test seam: forget every queue and floor. */
export function resetSubmissionQueues(): void {
  tails.clear();
  floors.clear();
}

/**
 * Run `send` in this account's next slot on `chainId`, handing it the
 * nonce to use. `send` must broadcast exactly one transaction with that
 * nonce, and resolve only once the broadcast has returned.
 *
 * The nonce is read through `wallet`'s own transport, so a pass that caps
 * its requests counts the read.
 */
export async function withSubmissionSlot<T>(
  wallet: WalletClient,
  chainId: number,
  address: Address,
  send: (nonce: number) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const key = keyOf(chainId, address);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    const pending = await getTransactionCount(wallet, { address, blockTag: 'pending' });
    const floor = floors.get(key);
    const fresh = floor !== undefined && now() - floor.at < FLOOR_TTL_MS;
    const nonce = fresh ? Math.max(pending, floor.next) : pending;
    const result = await send(nonce);
    floors.set(key, { next: nonce + 1, at: now() });
    return result;
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/**
 * `wallet`, with `sendTransaction` routed through the queue. `writeContract`
 * reaches `sendTransaction` through the client, so it is queued too; every
 * other action is untouched. The override calls viem's own action on the
 * UNEXTENDED client, so nothing re-enters the queue.
 */
export function queuedWallet(wallet: WalletClient, chainId: number): WalletClient {
  return wallet.extend((base) => ({
    // Typed loosely: viem's generic signature for this action cannot be
    // restated by a wrapper; the arguments pass through unchanged.
    sendTransaction: ((args: Parameters<typeof sendTransaction>[1]) => {
      const account = (args.account ?? base.account) as Account | Address | undefined;
      const address = typeof account === 'string' ? account : account?.address;
      // No account, or a nonce the caller chose: viem reports the first,
      // and the second is the caller's to coordinate.
      if (!address || args.nonce !== undefined) return sendTransaction(base, args);
      return withSubmissionSlot(base, chainId, address, (nonce) =>
        sendTransaction(base, { ...args, nonce } as typeof args),
      );
    }) as never,
  })) as unknown as WalletClient;
}

