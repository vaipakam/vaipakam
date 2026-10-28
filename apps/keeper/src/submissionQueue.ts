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
  estimateGas,
  getTransactionCount,
  prepareTransactionRequest,
  sendRawTransaction,
  sendTransaction,
  signTransaction,
  writeContract,
} from 'viem/actions';
import { HttpRequestError, keccak256, TimeoutError, type Hex } from 'viem';
import { gasLimitFromEstimate } from '@vaipakam/lib/gasLimit';
import { SubrequestBudgetExhausted } from './subrequestBudget';
import { assertEpochsHold } from './epochFence';

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

/** A send refused because its pass's run deadline had passed (#2571 r1,
 *  #2572). Raised at its turn in the queue, before the nonce is read, or at
 *  the last moment before broadcast. Either way no nonce is spent and nothing
 *  reaches the network. The second check comes AFTER signing, so the bytes
 *  may have been signed locally and discarded: the guarantee is "not sent",
 *  never "not signed" (#2572 r4). */
export class SendPastDeadline extends Error {}

/** Whether `err` is, or wraps, a {@link SendPastDeadline}. viem wraps an
 *  error raised inside `writeContract` (`ContractFunctionExecutionError`,
 *  with the original as `cause`), so a top-level `instanceof` misses it; the
 *  cause chain is walked the way {@link isDefinitiveRejection} walks it. */
export function isSendPastDeadline(err: unknown): boolean {
  let depth = 0;
  for (let e: unknown = err; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof SendPastDeadline) return true;
  }
  return false;
}

/** How a deadline refusal reads in a log line, wherever a send reports one. */
export const SEND_DEFERRED_WORDING =
  'deferred to the next run: the run deadline passed before broadcast, so nothing was sent';

/** The one way a send site reports a send that did not go out (#2572 r3).
 *  A deadline refusal is a deferral, logged as such, never as a failure: the
 *  slot refused it before anything was signed, so there is nothing to chase
 *  and the next run retries. Anything else is logged with `failure`, through
 *  `logFailure` (the site's own level). Returns whether it was a deferral. */
export function reportSendError(
  prefix: string,
  err: unknown,
  failure: string,
  logFailure: (line: string) => void = console.error,
): boolean {
  if (isSendPastDeadline(err)) {
    console.log(`${prefix} ${SEND_DEFERRED_WORDING}`);
    return true;
  }
  logFailure(`${prefix} ${failure}`);
  return false;
}

/** The one rule for a run deadline, applied wherever a send states one. */
function assertFiniteDeadline(notAfterMs: unknown, where: string): asserts notAfterMs is number {
  // Refused as well as typed: the keeper's typecheck does not cover its tests
  // or any untyped caller, and a missing or NaN deadline would compare false
  // forever and silently switch the check off.
  if (typeof notAfterMs !== 'number' || !Number.isFinite(notAfterMs)) {
    throw new TypeError(`${where}: a finite run deadline is required (got ${String(notAfterMs)})`);
  }
}

/**
 * Run `send` in this account's next slot on `chainId`, handing it the
 * nonce to use. `send` must broadcast at most one transaction with that
 * nonce, call `signed()` once it holds the signed bytes and before
 * broadcasting them, and resolve only once the broadcast has returned.
 *
 * `notAfterMs` is the run deadline of the pass sending (#2572), enforced HERE
 * because this is the one place every send passes through — the queued wallet
 * and the keeper's own prepared sends alike. It is checked twice:
 *
 *  - when the slot's turn comes, so a send that waited out its deadline behind
 *    another pass's costs no nonce read or preparation;
 *  - inside `signed()`, the boundary every sender calls between holding the
 *    signed bytes and broadcasting them (#2572 r2). The nonce read, the epoch
 *    fence and the sender's own preparation all await the network, and any of
 *    them can cross the deadline; this is the last moment before anything
 *    leaves the process. Refused there, the signed bytes are discarded unsent
 *    and the nonce is released.
 *
 * Either refusal is a {@link SendPastDeadline}.
 *
 * The nonce is read through `wallet`'s own transport, so a pass that caps
 * its requests counts the read.
 */
export async function withSubmissionSlot<T>(
  wallet: WalletClient,
  chainId: number,
  address: Address,
  notAfterMs: number,
  send: (nonce: number, signed: () => void) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  assertFiniteDeadline(notAfterMs, 'withSubmissionSlot');
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
    if (now() >= notAfterMs) {
      throw new SendPastDeadline(`send refused at its turn: the run's deadline passed while it waited — next run`);
    }
    const pending = await getTransactionCount(wallet, { address, blockTag: 'pending' });
    const floor = floors.get(key);
    const fresh = floor !== undefined && now() - floor.at < FLOOR_TTL_MS;
    const nonce = fresh ? Math.max(pending, floor.next) : pending;
    // The epoch fence (#2569 r4), before the signature: a send is made only
    // while the indexer's epoch this process was launched under still holds.
    // Thrown here, nothing was signed, so the nonce is simply released.
    await assertEpochsHold();
    let wasSigned = false;
    let result: T;
    try {
      result = await send(nonce, () => {
        // Thrown before `wasSigned` is set: nothing is broadcast, so the
        // nonce stays free for the next send.
        if (now() >= notAfterMs) {
          throw new SendPastDeadline(`send refused before broadcast: the run's deadline passed while it was prepared — next run`);
        }
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
  // Refused by the slot before any broadcast (#2572): nothing reached the
  // network, like the subrequest budget's refusal above.
  if (chain.some((e) => e instanceof SendPastDeadline)) return true;
  if (chain.some((e) => e instanceof TimeoutError || e instanceof HttpRequestError)) return false;
  if (chain.some((e) => NONCE_TAKEN.test(String((e as { message?: unknown }).message ?? '')))) {
    return false;
  }
  return chain.some((e) => {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'number' && code !== -1;
  });
}

/** The signed transaction a failed broadcast may still have relayed, by the
 *  error it failed with (Codex #2602 r6). */
const relayedHashes = new WeakMap<object, Hex>();

/**
 * The hash of the transaction `err`'s broadcast may have RELAYED, or
 * undefined. A broadcast that fails after signing without a definitive node
 * answer (a timeout, a lost response) may still reach the chain: the queue
 * keeps its nonce reserved for exactly that reason ({@link withSubmissionSlot}).
 * Its hash is the hash of the signed bytes, known before they left the
 * process, so a caller can still look for its receipt instead of reading the
 * send as one that moved nothing. The whole cause chain is read, because viem
 * wraps a broadcast's error (`writeContract` → `sendTransaction`).
 */
export function possiblyRelayedHash(err: unknown): Hex | undefined {
  let n = 0;
  for (let e: unknown = err; e && typeof e === 'object' && n < 8; e = (e as { cause?: unknown }).cause, n++) {
    const h = relayedHashes.get(e as object);
    if (h) return h;
  }
  return undefined;
}

/**
 * A prepared transaction with the gas limit every keeper send uses (#2997):
 * when the caller (`args`) named no limit, the node's estimate plus the
 * one margin {@link gasLimitFromEstimate} adds. A node estimates in the
 * latest block's environment with no margin at all, and the transaction
 * mines in a later block, so a call whose cost moves with time can run out
 * of gas at the bare estimate. Unused gas is not charged, so the margin
 * costs nothing when it is not needed; it does mean the account must hold
 * the fee for the higher limit to be accepted.
 *
 * The keeper's two preparation sites both apply it: the queued wallet
 * ({@link queuedWallet}) and the raw slot (`keeperSend.ts`).
 */
export function withGasLimitRule<R extends object>(args: { gas?: unknown }, request: R): R {
  const gas = (request as { gas?: unknown }).gas;
  return args.gas === undefined && typeof gas === 'bigint' ? { ...request, gas: gasLimitFromEstimate(gas) } : request;
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
export function queuedWallet(
  wallet: WalletClient,
  chainId: number,
  /** The run deadline of the pass this wallet sends for (#2571 r1; required
   *  since #2572). Checked INSIDE the submission slot, at the moment the
   *  send's turn comes — a check before queuing cannot cover the wait behind
   *  another pass's send, or a slow fee estimate. Every pass has one: the
   *  tick computes it from the pass's cadence, so a send signed after its
   *  run's slot has ended waits for the next run instead of competing with
   *  it. */
  notAfterMs: number,
): WalletClient {
  // At build time too, so a wallet without a deadline fails where it is made
  // rather than at its first send.
  assertFiniteDeadline(notAfterMs, 'queuedWallet');
  return wallet.extend((base) => {
    // Typed loosely: viem's generic signatures for these actions cannot be
    // restated by a wrapper; the arguments pass through unchanged.
    const queuedSend = async (args: Parameters<typeof sendTransaction>[1]) => {
      const account = (args.account ?? base.account) as Account | Address | undefined;
      // Not a local signer, or a nonce the caller chose: viem handles the
      // first (and reports a missing account), and the second is the
      // caller's to coordinate.
      if (typeof account !== 'object' || account.type !== 'local' || args.nonce !== undefined) {
        // The same gas-limit rule on this path too (#2997): viem would
        // otherwise prepare it at the bare estimate.
        const gas = args.gas ?? gasLimitFromEstimate(await estimateGas(base, args as never));
        return sendTransaction(base, { ...args, gas } as never);
      }
      // viem's own sendTransaction, split at the signature so the slot
      // knows whether a failure could have reached the network.
      return withSubmissionSlot(base, chainId, account.address, notAfterMs, async (nonce, signed) => {
        const request = withGasLimitRule(
          args,
          await prepareTransactionRequest(base, {
            ...(args as object),
            account,
            nonce,
          } as never),
        );
        const serialized = await signTransaction(base, {
          ...(request as object),
          account,
          chain: null,
        } as never);
        signed();
        try {
          return await sendRawTransaction(base, { serializedTransaction: serialized });
        } catch (err) {
          // Possibly relayed: the same rule that keeps the nonce reserved
          // ({@link withSubmissionSlot}) keeps the hash findable.
          if (err && typeof err === 'object' && !isDefinitiveRejection(err)) relayedHashes.set(err, keccak256(serialized));
          throw err;
        }
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
