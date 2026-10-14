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
 * broadcast and uses whichever is higher. The floor expires after
 * {@link FLOOR_TTL_MS}: if that broadcast is then dropped, the gap it
 * leaves lasts at most that long before the pending count is trusted
 * again, and the next send fills it.
 *
 * Which failures set the floor is the point of the design:
 *
 * - **Before signing** (a reverted gas estimate, a refused request): no
 *   transaction with this nonce exists anywhere, so nothing is recorded
 *   and the next send reuses the nonce. This is what keeps a reverted
 *   estimate from opening a gap.
 * - **After signing** (the broadcast threw, or its answer never came
 *   back): the RPC may have relayed it. Reusing the nonce could then
 *   replace a keeper action already in flight, so the nonce is
 *   quarantined behind the floor exactly as if the broadcast had been
 *   accepted. If it really was lost, that costs at most one floor
 *   lifetime of later sends waiting behind the gap; replacing a relayed
 *   close-out has no such bound. The send reports the boundary by calling
 *   `signed()` once it holds signed bytes.
 *
 * What remains: a relayed transaction that the answering RPC still cannot
 * see when the floor expires. A later send can then take its nonce. The
 * node refuses that as an underpriced replacement unless the later send's
 * fees are enough higher to replace it, in which case the earlier action
 * is dropped. Closing that needs reconciling against the chain, which an
 * isolate-local queue cannot do reliably on a lagging RPC either.
 *
 * ## Scope
 *
 * The queue lives in this isolate's memory. It orders every pass of one
 * tick, and of overlapping ticks that land in the same isolate. Two ticks
 * running at once in DIFFERENT isolates are not ordered by it. At a
 * one-minute cadence that needs a tick still sending a minute after it
 * started, which the free plan's CPU limit makes unlikely but does not
 * rule out. If it happens, the two can sign different actions with the
 * same nonce. Usually the second is refused and its pass retries it on a
 * later tick. But if the second carries a high enough fee, the node lets
 * it REPLACE the first, and the first pass, which already has a hash,
 * logs an action that never lands. Its own next attempt finds the loan
 * still open and tries again, so the action is delayed rather than lost
 * for good, but the log line that said it was sent is wrong. Closing that
 * needs a nonce lease shared between isolates (for example in D1).
 */
import type { Account, Address, WalletClient } from 'viem';
import {
  getTransactionCount,
  prepareTransactionRequest,
  sendRawTransaction,
  sendTransaction,
  signTransaction,
  writeContract,
} from 'viem/actions';
import { HttpRequestError, TimeoutError } from 'viem';
import { SubrequestBudgetExhausted } from './subrequestBudget';

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
 * nonce to use. `send` must broadcast at most one transaction with that
 * nonce, call `signed()` once it holds the signed bytes and before
 * broadcasting them, and resolve only once the broadcast has returned.
 *
 * The nonce is read through `wallet`'s own transport, so a pass that caps
 * its requests counts the read.
 */
export async function withSubmissionSlot<T>(
  wallet: WalletClient,
  chainId: number,
  address: Address,
  send: (nonce: number, signed: () => void) => Promise<T>,
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
    let wasSigned = false;
    let result: T;
    try {
      result = await send(nonce, () => {
        wasSigned = true;
      });
    } catch (err) {
      // Possibly relayed: the nonce is spoken for. A node that ANSWERED
      // with a refusal took nothing, and moving the floor past an unused
      // nonce would make every later send "nonce too high" and refresh
      // the floor each time, so the gap would never close.
      if (wasSigned && !isDefinitiveRejection(err)) {
        floors.set(key, { next: nonce + 1, at: now() });
      }
      throw err;
    }
    floors.set(key, { next: nonce + 1, at: now() });
    return result;
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/**
 * Answers that say the nonce IS taken: the node already holds a
 * transaction there, quite possibly this one (viem retries a broadcast
 * whose answer was lost, and the retry is refused this way). These must
 * keep the floor, or the next send reuses the nonce and replaces it.
 */
const NONCE_TAKEN = /nonce too low|already known|known transaction|replacement transaction/i;

/**
 * Whether `err` is the node's own answer refusing the transaction, as
 * opposed to an outcome nobody saw. A JSON-RPC error carries a numeric
 * `code`; a timeout or a dropped connection does not. viem's
 * `UnknownRpcError` carries `-1`, its "no code" placeholder, so that
 * counts as unseen. A request the subrequest budget refused before
 * sending is definitive too, in the other direction: nothing left the
 * Worker. The whole cause chain is read before deciding, because viem
 * wraps the node's answer and a placeholder outer code must not hide an
 * inner timeout or a nonce-taken answer.
 */
export function isDefinitiveRejection(err: unknown): boolean {
  const chain: unknown[] = [];
  for (let e: unknown = err; e && chain.length < 8; e = (e as { cause?: unknown }).cause) {
    chain.push(e);
  }
  if (chain.some((e) => e instanceof SubrequestBudgetExhausted)) return true;
  if (chain.some((e) => e instanceof TimeoutError || e instanceof HttpRequestError)) return false;
  if (chain.some((e) => NONCE_TAKEN.test(String((e as { message?: unknown }).message ?? '')))) {
    return false;
  }
  return chain.some((e) => {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'number' && code !== -1;
  });
}

/**
 * `wallet`, with `sendTransaction` AND `writeContract` routed through the
 * queue. Both must be replaced: the wallet's own `writeContract` is a
 * closure over the client it was built with, so replacing
 * `sendTransaction` alone leaves every `writeContract` call unqueued. The
 * replacement `writeContract` runs viem's action against a client whose
 * `sendTransaction` is the queued one, which is where viem looks it up.
 * The queued send calls viem's actions on the UNEXTENDED client, so
 * nothing re-enters the queue. Every other action is untouched.
 */
export function queuedWallet(wallet: WalletClient, chainId: number): WalletClient {
  return wallet.extend((base) => {
    // Typed loosely: viem's generic signatures for these actions cannot be
    // restated by a wrapper; the arguments pass through unchanged.
    const queuedSend = (args: Parameters<typeof sendTransaction>[1]) => {
      const account = (args.account ?? base.account) as Account | Address | undefined;
      // Not a local signer, or a nonce the caller chose: viem handles the
      // first (and reports a missing account), and the second is the
      // caller's to coordinate.
      if (typeof account !== 'object' || account.type !== 'local' || args.nonce !== undefined) {
        return sendTransaction(base, args);
      }
      // viem's own sendTransaction, split at the signature so the slot
      // knows whether a failure could have reached the network.
      return withSubmissionSlot(base, chainId, account.address, async (nonce, signed) => {
        const request = await prepareTransactionRequest(base, {
          ...(args as object),
          account,
          nonce,
        } as never);
        const serialized = await signTransaction(base, {
          ...(request as object),
          account,
          chain: null,
        } as never);
        signed();
        return sendRawTransaction(base, { serializedTransaction: serialized });
      });
    };
    const routed = { ...base, sendTransaction: queuedSend };
    return {
      sendTransaction: queuedSend as never,
      writeContract: ((args: Parameters<typeof writeContract>[1]) =>
        writeContract(routed as never, args)) as never,
    };
  }) as unknown as WalletClient;
}
