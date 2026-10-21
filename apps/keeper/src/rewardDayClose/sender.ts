// apps/keeper/src/rewardDayClose/sender.ts
//
// Simulate-then-send, one transaction at a time, within the run's budget
// ({@link MAX_SENDS_PER_RUN} per chain). Each send is simulated first on the
// current state and waits for its receipt before the next (every pass signs
// from one key). The sender holds the run's one record of what was refused
// and what landed, keyed `step:day`: its own calls write it, and so does a
// step that declines a call for a reason the contract would not see (a
// report shape Base would refuse).

import type { Hex, TransactionReceipt } from 'viem';
import { PastRunDeadline } from '../batchRead';
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
  stopped = false;
  stopReason = '';
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

  constructor(private readonly deps: DayCloseDeps) {}

  /** The run was stopped by a paused protocol. */
  get paused(): boolean {
    return this.stopReason === PAUSED_REFUSAL;
  }

  private stop(why: string): 'skipped' {
    this.stopped = true;
    this.stopReason = why;
    return 'skipped';
  }

  async call(step: string, day: number, functionName: string, args: readonly unknown[], value: bigint): Promise<CallResult> {
    this.receipt = null;
    if (this.stopped) return 'skipped';
    if (this.sends >= MAX_SENDS_PER_RUN) return this.stop('send-budget');
    if (Date.now() >= this.deps.sendDeadline) return this.stop('deadline');
    if (this.ctx === undefined) this.ctx = this.deps.context();
    const ctx = this.ctx;
    if (!ctx) return this.stop('no-signing-key');
    const key = `${step}:${day}`;
    try {
      await ctx.client.simulateContract({ address: ctx.diamond, abi: ABI, functionName, args, value, account: ctx.wallet.account! });
    } catch (err) {
      if (err instanceof PastRunDeadline) return this.stop('deadline');
      const c = classify(err);
      if ('unread' in c) {
        // No answer from the contract is not its refusal: say nothing about
        // the day, and stop sending on this RPC for the run.
        console.error(`[keeper] rewardDayClose chain=${ctx.chainId} ${functionName}(${day}) not simulated, the RPC did not answer: ${c.unread}`);
        return this.stop('rpc-unavailable');
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
      if (!isDefinitiveRejection(err)) this.maybeSent += 1;
      return this.stop('send-failed');
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
      return this.stop('receipt-timeout');
    }
    this.maybeSent += 1;
    this.landed.add(key);
    return 'landed';
  }
}
