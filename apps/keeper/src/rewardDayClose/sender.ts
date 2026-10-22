// apps/keeper/src/rewardDayClose/sender.ts
//
// Simulate-then-send, one transaction at a time, within the run's budget
// ({@link MAX_SENDS_PER_RUN} per chain). Each send is simulated first on the
// current state and waits for its receipt before the next (every pass signs
// from one key). The sender holds the run's one record of what was refused
// and what landed, keyed `step:day`: its own calls write it, and so does a
// step that declines a call for a reason the contract would not see (a
// report shape Base would refuse). It is also where the fee ceiling holds:
// every paid send passes through `call`, so no step can pay past it.

import type { Hex, TransactionReceipt } from 'viem';
import { PastRunDeadline } from '../batchRead';
import { keeperTxPending } from '../keeperSend';
import type { KeeperContext } from '../keeper';
import { isDefinitiveRejection, reportSendError } from '../submissionQueue';
import { ABI, FRONTIER_SHORT, MAX_SENDS_PER_RUN, PAUSED_REFUSAL, RACES, RECEIPT_TIMEOUT_MS } from './constants';
import type { DayCloseDeps } from './deps';
import { classify, shortErr } from './errors';

/** 'landed'; 'skipped' (not sent: budget, deadline, a race, no key, or the
 *  run stopped); or the reason the contract refused the call. */
export type CallResult = 'landed' | 'skipped' | string;

export class Sender {
  private ctx: KeeperContext | null | undefined;
  private sends = 0;
  private pendingChecked = false;
  stopped = false;
  stopReason = '';
  /** Why the run stopped sending, when that is a fault that can repeat run
   *  after run (no key, an RPC that does not answer, a send the node refused,
   *  a receipt not seen, a transaction of this keeper's still unmined): said
   *  by the `held` alert, so a stalled pass is never visible only in logs.
   *  Null for an ordinary stop (the send budget or the run's deadline, which
   *  the next run continues from) and for a pause, which is said apart. */
  stall: string | null = null;
  /** Writes that went out and may have landed: landed, or sent with no
   *  receipt seen. A write known to have reverted is not counted. */
  maybeSent = 0;
  /** The receipt of the last call, when it landed (null otherwise). */
  receipt: TransactionReceipt | null = null;
  /** `step:day` → why, for calls refused this run (by the contract, or
   *  declined by the step before sending). */
  readonly refused = new Map<string, string>();
  /** `step:day` keys whose call landed this run. */
  readonly landed = new Set<string>();
  /** `step:day` → what could not be read, for steps a failed read kept from
   *  being tried this run. Every step that skips a day on an unknown says so
   *  here, so a day held by a read is never held silently. */
  readonly unread = new Map<string, string>();

  /** Record that `what` could not be read, keeping `step:day` from being
   *  worked this run. Several reads for one step are all named. */
  noteUnread(key: string, what: string): void {
    const had = this.unread.get(key);
    if (had === undefined) this.unread.set(key, what);
    else if (!had.split('; ').includes(what)) this.unread.set(key, `${had}; ${what}`);
  }

  constructor(private readonly deps: DayCloseDeps) {}

  /** The run was stopped by a paused protocol. */
  get paused(): boolean {
    return this.stopReason === PAUSED_REFUSAL;
  }

  private stop(why: string, stall: string | null = null): 'skipped' {
    this.stopped = true;
    this.stopReason = why;
    this.stall = stall;
    return 'skipped';
  }

  async call(step: string, day: number, functionName: string, args: readonly unknown[], value: bigint): Promise<CallResult> {
    this.receipt = null;
    if (this.stopped) return 'skipped';
    const key = `${step}:${day}`;
    // The fee ceiling (#2627) is checked before anything else is read: a send
    // that would pay more than it, or a ceiling that cannot be read, goes
    // nowhere, and the day stays owed.
    if (value > 0n) {
      const cap = this.deps.feeCeiling;
      if ('unread' in cap) {
        this.noteUnread(key, cap.unread);
        return 'skipped';
      }
      if (value > cap.wei) {
        const why = `its quoted CCIP fee of ${value} wei is above this keeper's ceiling of ${cap.wei} wei on this chain (${cap.from}), so nothing was paid or sent; it goes out once the quote is at or under the ceiling, or the ceiling is raised`;
        this.refused.set(key, why);
        return why;
      }
    }
    if (this.sends >= MAX_SENDS_PER_RUN) return this.stop('send-budget');
    if (Date.now() >= this.deps.sendDeadline) return this.stop('deadline');
    if (this.ctx === undefined) this.ctx = this.deps.context();
    const ctx = this.ctx;
    if (!ctx) return this.stop('no-signing-key', 'it has no signing key for this chain, so it sent nothing');
    // A transaction of this keeper's still unmined (an earlier run's whose
    // receipt was not seen, or another pass's) may be this very step: the
    // state reads as before it, and a second send would queue behind it only
    // to revert once it lands. Nothing persists between runs, so the chain is
    // asked, once per run, before the first send.
    if (!this.pendingChecked) {
      let pending: string | null;
      try {
        pending = await keeperTxPending(ctx.client, ctx.wallet.account!.address);
      } catch (err) {
        if (err instanceof PastRunDeadline) return this.stop('deadline');
        console.error(`[keeper] rewardDayClose chain=${ctx.chainId} the keeper's pending transactions could not be read: ${shortErr(err)}`);
        return this.stop('rpc-unavailable', `it could not read whether a transaction of its own is still unmined (${shortErr(err)}), so it sent nothing`);
      }
      if (pending !== null) return this.stop(pending, `a transaction of its own is still unmined on this chain (${pending}), so it sent nothing behind it`);
      this.pendingChecked = true;
    }
    try {
      await ctx.client.simulateContract({ address: ctx.diamond, abi: ABI, functionName, args, value, account: ctx.wallet.account! });
    } catch (err) {
      if (err instanceof PastRunDeadline) return this.stop('deadline');
      const c = classify(err);
      if ('unread' in c) {
        // No answer from the contract is not its refusal: say nothing about
        // the day, and stop sending on this RPC for the run.
        console.error(`[keeper] rewardDayClose chain=${ctx.chainId} ${functionName}(${day}) not simulated, the RPC did not answer: ${c.unread}`);
        this.noteUnread(`${step}:${day}`, 'the simulation of the call (the RPC did not answer)');
        return this.stop('rpc-unavailable', `the RPC did not answer the simulation of ${functionName} for day ${day}, so it sent nothing more`);
      }
      const reason = c.refused;
      if (reason === PAUSED_REFUSAL) return this.stop(PAUSED_REFUSAL);
      if (RACES.has(reason)) return 'skipped';
      if (reason !== FRONTIER_SHORT) this.refused.set(key, reason);
      return reason;
    }
    this.sends += 1;
    const label = `[keeper] rewardDayClose chain=${ctx.chainId} ${functionName}(${day})`;
    let hash: Hex;
    try {
      hash = (await ctx.wallet.writeContract({ address: ctx.diamond, abi: ABI, functionName, args, value, chain: undefined, account: ctx.wallet.account ?? null } as never)) as Hex;
    } catch (err) {
      // A deferral at the deadline sent nothing, and says so.
      if (reportSendError(label, err, `send failed: ${shortErr(err)}`)) return this.stop('deadline');
      // Only a send the node did not answer may have gone out (a timeout, a
      // lost response, a nonce already taken): one the node refused outright
      // (insufficient funds, a coded RPC refusal) left nothing.
      const refused = isDefinitiveRejection(err);
      if (!refused) this.maybeSent += 1;
      return this.stop(
        'send-failed',
        `the node ${refused ? 'refused' : 'did not answer'} its send of ${functionName} for day ${day} (${shortErr(err)})${refused ? ', so nothing went out' : ', which may still have gone out'}; a refusal like insufficient funds for the gas and CCIP fee repeats every run until it is fixed`,
      );
    }
    console.log(`${label} value=${value} tx=${hash}`);
    try {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') {
        this.refused.set(key, `reverted on chain (tx ${hash})`);
        return `reverted on chain (tx ${hash})`;
      }
      this.receipt = receipt;
    } catch (err) {
      console.error(`${label} receipt not seen in time: ${shortErr(err)}`);
      this.maybeSent += 1;
      return this.stop('receipt-timeout', `it saw no receipt for ${functionName} for day ${day} (tx ${hash}) in time; it may still land`);
    }
    this.maybeSent += 1;
    this.landed.add(key);
    return 'landed';
  }
}
