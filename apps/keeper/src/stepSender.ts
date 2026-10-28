// apps/keeper/src/stepSender.ts
//
// Simulate-then-send, one transaction at a time, within a run's budget. Each
// send is simulated first on the current state and waits for its receipt
// before the next (every pass signs from one key), so a pass whose steps
// build on each other (a walk opened, then paged) can send them in one run.
// The sender holds the run's one record of what was refused and what landed,
// keyed `step:subject`: its own calls write it, and so does a step that
// declines a call for a reason the contract would not see. It is also where a
// fee ceiling holds: every paid send passes through `call`, so no step can pay
// past it.
//
// Shared by the passes that work this way: the reward day-close pass
// (`rewardDayClose/sender.ts` configures it) and the reward close-out pass
// (`rewardCloseOut`). Each pass names its own ABI, the refusals that are
// races rather than faults, and the refusal a paused protocol gives.

import type { Abi, Hex, PublicClient, TransactionReceipt } from 'viem';
import { PastRunDeadline } from './batchRead';
import { classify, shortErr } from './callErrors';
import { keeperTxPending } from './keeperSend';
import type { KeeperContext } from './keeper';
import { isDefinitiveRejection, reportSendError } from './submissionQueue';

/** 'landed'; 'skipped' (not sent: budget, deadline, a race, no key, or the
 *  run stopped); or the reason the contract refused the call. */
export type CallResult = 'landed' | 'skipped' | string;

/** The most one paid send may cost on a chain, or why that is unknown. */
export type SendFeeCeiling = { wei: bigint; from: string } | { unread: string };

/** What a pass fixes about how its sends are made. */
export interface StepSenderConfig {
  /** The pass's name, as its log lines carry it. */
  pass: string;
  /** Every function the pass calls, and the errors it may revert with. */
  abi: Abi;
  /** Sends per chain per run. */
  maxSends: number;
  /** How long a send's receipt is waited for. */
  receiptTimeoutMs: number;
  /** Refusals that mean another caller got there first: skipped, not refused. */
  races: ReadonlySet<string>;
  /** The refusal a paused protocol gives: it stops the run, said apart. */
  pausedRefusal: string;
  /** Refusals returned to the step but not recorded as the run's refusals
   *  (an expected wait the step reports in its own words). */
  unrecorded?: ReadonlySet<string>;
  /** How a call's subject reads in a sentence (`day 3`, `era 2`). */
  describe: (subject: number | string) => string;
  /** What this pass's sends spend, as a refused send names it (`the gas`,
   *  `the gas and CCIP fee`). */
  spends: string;
}

/** What one chain's run gives the sender. */
export interface StepSenderDeps {
  /** The signing context, built only when there is something to send. */
  context: () => KeeperContext | null;
  /** No send starts at or after this. */
  sendDeadline: number;
  /** The paid-send ceiling; absent for a pass that never pays. */
  feeCeiling?: SendFeeCeiling;
}

export class StepSender {
  private ctx: KeeperContext | null | undefined;
  private sends = 0;
  private pendingChecked = false;
  stopped = false;
  stopReason = '';
  /** Why the run stopped sending, when that is a fault that can repeat run
   *  after run (no key, an RPC that does not answer, a send the node refused,
   *  a receipt not seen, a transaction of this keeper's still unmined). Null
   *  for an ordinary stop (the send budget or the run's deadline, which the
   *  next run continues from) and for a pause, which is said apart. */
  stall: string | null = null;
  /** Writes that went out and may have landed: landed, or sent with no
   *  receipt seen. A write known to have reverted is not counted. */
  maybeSent = 0;
  /** The receipt of the last call, when it landed (null otherwise). */
  receipt: TransactionReceipt | null = null;
  /** `step:subject` → why, for calls refused this run (by the contract, or
   *  declined by the step before sending). */
  readonly refused = new Map<string, string>();
  /** `step:subject` keys whose call landed this run. */
  readonly landed = new Set<string>();
  /** `step:subject` → what could not be read, for steps a failed read kept
   *  from being tried this run. Every step that skips on an unknown says so
   *  here, so nothing is held by a read silently. */
  readonly unread = new Map<string, string>();

  constructor(
    private readonly config: StepSenderConfig,
    private readonly deps: StepSenderDeps,
  ) {}

  /** Record that `what` could not be read, keeping `step:subject` from being
   *  worked this run. Several reads for one step are all named. */
  noteUnread(key: string, what: string): void {
    const had = this.unread.get(key);
    if (had === undefined) this.unread.set(key, what);
    else if (!had.split('; ').includes(what)) this.unread.set(key, `${had}; ${what}`);
  }

  /** The run was stopped by a paused protocol. */
  get paused(): boolean {
    return this.stopReason === this.config.pausedRefusal;
  }

  /** Sends this run has made so far. */
  get sent(): number {
    return this.sends;
  }

  private stop(why: string, stall: string | null = null): 'skipped' {
    this.stopped = true;
    this.stopReason = why;
    this.stall = stall;
    return 'skipped';
  }

  async call(step: string, subject: number | string, functionName: string, args: readonly unknown[], value: bigint = 0n): Promise<CallResult> {
    this.receipt = null;
    if (this.stopped) return 'skipped';
    const { abi, pass, describe } = this.config;
    const key = `${step}:${subject}`;
    // The fee ceiling is checked before anything else is read: a send that
    // would pay more than it, or a ceiling that cannot be read, goes nowhere.
    if (value > 0n) {
      const cap = this.deps.feeCeiling ?? { unread: 'no fee ceiling is configured for this pass' };
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
    if (this.sends >= this.config.maxSends) return this.stop('send-budget');
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
        pending = await keeperTxPending(ctx.client as PublicClient, ctx.wallet.account!.address);
      } catch (err) {
        if (err instanceof PastRunDeadline) return this.stop('deadline');
        console.error(`[keeper] ${pass} chain=${ctx.chainId} the keeper's pending transactions could not be read: ${shortErr(err)}`);
        return this.stop('rpc-unavailable', `it could not read whether a transaction of its own is still unmined (${shortErr(err)}), so it sent nothing`);
      }
      if (pending !== null) return this.stop(pending, `a transaction of its own is still unmined on this chain (${pending}), so it sent nothing behind it`);
      this.pendingChecked = true;
    }
    try {
      await ctx.client.simulateContract({ address: ctx.diamond, abi, functionName, args, value, account: ctx.wallet.account! });
    } catch (err) {
      if (err instanceof PastRunDeadline) return this.stop('deadline');
      const c = classify(err);
      if ('unread' in c) {
        // No answer from the contract is not its refusal: say nothing about
        // the subject, and stop sending on this RPC for the run.
        console.error(`[keeper] ${pass} chain=${ctx.chainId} ${functionName}(${subject}) not simulated, the RPC did not answer: ${c.unread}`);
        this.noteUnread(key, 'the simulation of the call (the RPC did not answer)');
        return this.stop('rpc-unavailable', `the RPC did not answer the simulation of ${functionName} for ${describe(subject)}, so it sent nothing more`);
      }
      const reason = c.refused;
      if (reason === this.config.pausedRefusal) return this.stop(reason);
      if (this.config.races.has(reason)) return 'skipped';
      if (!this.config.unrecorded?.has(reason)) this.refused.set(key, reason);
      return reason;
    }
    this.sends += 1;
    const label = `[keeper] ${pass} chain=${ctx.chainId} ${functionName}(${subject})`;
    let hash: Hex;
    try {
      hash = (await ctx.wallet.writeContract({ address: ctx.diamond, abi, functionName, args, value, chain: undefined, account: ctx.wallet.account ?? null } as never)) as Hex;
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
        `the node ${refused ? 'refused' : 'did not answer'} its send of ${functionName} for ${describe(subject)} (${shortErr(err)})${refused ? ', so nothing went out' : ', which may still have gone out'}; a refusal like insufficient funds for ${this.config.spends} repeats every run until it is fixed`,
      );
    }
    console.log(`${label} value=${value} tx=${hash}`);
    try {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: this.config.receiptTimeoutMs });
      if (receipt.status !== 'success') {
        this.refused.set(key, `reverted on chain (tx ${hash})`);
        return `reverted on chain (tx ${hash})`;
      }
      this.receipt = receipt;
    } catch (err) {
      console.error(`${label} receipt not seen in time: ${shortErr(err)}`);
      this.maybeSent += 1;
      return this.stop('receipt-timeout', `it saw no receipt for ${functionName} for ${describe(subject)} (tx ${hash}) in time; it may still land`);
    }
    this.maybeSent += 1;
    this.landed.add(key);
    return 'landed';
  }
}
