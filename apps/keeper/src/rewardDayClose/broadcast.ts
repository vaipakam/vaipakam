// apps/keeper/src/rewardDayClose/broadcast.ts
//
// Step 3 on Base: BROADCAST each finalized day to the destinations it is
// owed (`broadcastGlobal`, the quoted fee, paid exactly), and confirm
// delivery by reading each destination this keeper also serves
// (`getKnownGlobalInterestNumeraire18(d).isSet` there).
//
// The destinations a day is owed: every one it has had while worked, the
// messenger's current list, and every mirror on Base's expected-source list,
// listed as a destination or not. Off the list, a destination the contract
// gives no standing in the day (it had no part in it) is owed nothing.
//
// Every judgement is per destination, against the last send that covered it
// (planBroadcast). When every listed destination needs the day it goes out in
// one send to all; otherwise each is sent it alone (`broadcastGlobalTo`), so a
// lane that delivered is not paid again, falling back to the send to all when
// the day or the messenger cannot take a single-destination send (the mirror
// ingress is idempotent, so a re-send cannot double-apply).
//
// A send's time is recorded, for the destinations it is meant to cover,
// BEFORE it goes out, and kept unless nothing went out, so a send whose
// receipt was not seen (it may have landed, paying every lane it covered) is
// not repeated before the re-send interval. A send that landed is recorded
// from its receipt, by the messenger's own per-destination events: the send
// to all reaches the list as it stands when the transaction runs, not as this
// run read it.

import type { Address } from 'viem';
import { NO_SELECTOR, NO_STANDING, RESEND_TO_ALL } from './constants';
import type { ChainRun } from './deps';
import { broadcastsLeft, planBroadcast, type BroadcastPlan, type SendMark } from './plan';
import { destinationStates, messengerAt, quote } from './reads';
import type { CallResult, Sender } from './sender';
import type { DayStore } from './store';

export interface BroadcastInput {
  /** Finalized window days, in the window's order. */
  days: readonly number[];
  /** The messenger's destination list as read. */
  current: readonly number[];
  /** Expected mirrors (Base's list, Base itself left out). */
  mirrors: readonly number[];
  messenger: Address;
  nowSec: number;
}

/** Judge every finalized day's broadcast, and send what the plans call for
 *  while the run may send. Returns each day's plan as judged before this
 *  run's sends, and how many days a send went out for. */
export async function broadcastDays(c: ChainRun, store: DayStore, sender: Sender, x: BroadcastInput): Promise<{ plans: Map<number, BroadcastPlan>; sent: number }> {
  const plans = new Map<number, BroadcastPlan>();
  let sent = 0;
  const marks = await store.broadcasts(x.days);
  // Chains that may be owed a day though neither list names them now (a
  // mirror taken off both after the day was finalized, before this keeper
  // first saw it): every chain this keeper serves, and every destination any
  // window day has had. The contract's own day standing decides each.
  const known = new Set([...(c.deps.served ?? []), ...[...marks.values()].flatMap((m) => Object.keys(m.sentTo).map(Number))]);
  known.delete(c.chainId);
  for (const d of x.days) {
    const sentTo = new Map<number, SendMark | null>(Object.entries(marks.get(d)?.sentTo ?? {}).map(([k, t]) => [Number(k), t]));
    const noStanding = new Set(marks.get(d)?.noStanding ?? []);
    const save = () => store.saveBroadcast(d, sentTo, noStanding);
    // The record only grows: a mirror taken off the list after a send that
    // never reached it still lacks the day; one added after the day was sent
    // has never been sent it.
    const fresh = [...new Set([...x.current, ...x.mirrors])].filter((k) => !sentTo.has(k));
    for (const k of fresh) sentTo.set(k, null);
    let changed = fresh.length > 0;
    for (const k of known) {
      if (sentTo.has(k) || noStanding.has(k)) continue;
      // eslint-disable-next-line no-await-in-loop
      const q = await quote(c.deps.client, c.diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(k)]);
      if ('refused' in q && q.refused === NO_STANDING) {
        noStanding.add(k);
        changed = true;
        continue;
      }
      // Standing, or not known: owed until a read says otherwise. A Diamond
      // that routes no single-destination broadcast cannot say (its standing
      // read is that send's quote) and cannot send the day to a chain on
      // neither list either: the chain stays owed, and the send's refusal
      // says it cannot be reached, holding the day until it can.
      if ('unread' in q) sender.noteUnread(`broadcast:${d}`, `whether chain ${k} has standing in the day`);
      sentTo.set(k, null);
      changed = true;
    }
    // eslint-disable-next-line no-await-in-loop
    if (changed) await save();
    // eslint-disable-next-line no-await-in-loop
    const dest = await destinationStates(c, [...sentTo.keys()].sort((a, b) => a - b), d);
    for (const [k, state] of dest) {
      if (state === 'received' || x.current.includes(k)) continue;
      // eslint-disable-next-line no-await-in-loop
      const q = await quote(c.deps.client, c.diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(k)]);
      if ('refused' in q && q.refused === NO_STANDING) dest.delete(k);
    }
    const plan = planBroadcast(dest, sentTo, x.nowSec);
    plans.set(d, plan);
    if (plan.done || plan.send.length === 0 || sender.stopped) continue;
    const before = sender.maybeSent;
    // eslint-disable-next-line no-await-in-loop
    await deliver(c, sender, x, d, plan.send, sentTo, save);
    if (sender.maybeSent > before) sent += 1;
  }
  return { plans, sent };
}

/**
 * One send of day `d`, meant to cover `covered`: their send is recorded,
 * unproven, before it goes out, and put back unless a transaction went out.
 * One that went out with no receipt seen may have landed, so it counts as
 * made, unproven. One that landed is recorded from its receipt: the
 * destinations its messages left for are marked proven, whether or not this
 * run expected them, and a covered one it did not send to is put back.
 */
async function sendCovering(
  c: ChainRun,
  sender: Sender,
  messenger: Address,
  d: number,
  covered: readonly number[],
  sentTo: Map<number, SendMark | null>,
  save: () => Promise<unknown>,
  send: () => Promise<CallResult>,
): Promise<CallResult> {
  const prior = covered.map((k) => [k, sentTo.get(k) ?? null] as const);
  const before = sender.maybeSent;
  const at = Math.floor(Date.now() / 1000);
  for (const k of covered) sentTo.set(k, { at, proven: false });
  await save();
  const r = await send();
  if (sender.maybeSent === before) {
    for (const [k, t] of prior) sentTo.set(k, t);
    await save();
  } else if (r === 'landed') {
    const receipt = sender.receipt;
    const atBlock = receipt === null ? null : await messengerAt(c, receipt.blockNumber);
    const left = broadcastsLeft(receipt, atBlock?.known ? [messenger, atBlock.value] : [messenger], d);
    if (left === null) {
      // Sent through a messenger this run cannot name: the send counts as
      // made, unproven, as one whose receipt was not seen.
      console.error(`[keeper] rewardDayClose ${c.where} broadcast of day ${d} landed through a messenger this run cannot name; its destinations are recorded as sent, unproven`);
    } else {
      for (const [k, t] of prior) if (!left.has(k)) sentTo.set(k, t);
      for (const k of left) sentTo.set(k, { at, proven: true });
      await save();
    }
  }
  return r;
}

/**
 * Deliver day `d` to `targets`, by which destinations need it: one send to
 * all when every listed destination does; otherwise each target alone, a
 * target on the list falling back to the send to all where the day or the
 * messenger cannot take a single-destination send; a target off the list is
 * reachable only alone, and when the contract will not, the run says so.
 */
async function deliver(c: ChainRun, sender: Sender, x: BroadcastInput, d: number, targets: readonly number[], sentTo: Map<number, SendMark | null>, save: () => Promise<unknown>): Promise<void> {
  const key = `broadcast:${d}`;
  let toAll = x.current.length > 0 && x.current.every((k) => targets.includes(k));
  const said: string[] = [];
  for (const k of toAll ? targets.filter((t) => !x.current.includes(t)) : targets) {
    if (sender.stopped) break;
    // eslint-disable-next-line no-await-in-loop
    const q = await quote(c.deps.client, c.diamond, 'quoteBroadcastGlobalTo', [BigInt(d), BigInt(k)]);
    if ('unread' in q) {
      sender.noteUnread(key, `the fee of the send to chain ${k} alone`);
      continue;
    }
    const r =
      'refused' in q
        ? q.refused
        : // eslint-disable-next-line no-await-in-loop
          await sendCovering(c, sender, x.messenger, d, [k], sentTo, save, () => sender.call('broadcast', d, 'broadcastGlobalTo', [BigInt(d), BigInt(k)], q.fee));
    if (r === 'landed' || r === 'skipped') continue;
    if (RESEND_TO_ALL.has(r) && x.current.includes(k)) toAll = true;
    else if (r === NO_SELECTOR)
      said.push(`chain ${k} is not a broadcast destination and this Diamond routes no single-destination broadcast, so whether it is owed the day cannot be read and no send can reach it`);
    else if (RESEND_TO_ALL.has(r)) said.push(`chain ${k} is not a broadcast destination and the Diamond will not send the day to it alone (${r})`);
    else if ('refused' in q) said.push(`the Diamond would not quote the send to chain ${k} (${q.refused})`);
    else said.push(`the send to chain ${k} was refused (${r})`);
  }
  // A single-destination refusal the send to all answers is not a refusal of
  // the day: what stands is what that send says, plus what no send could.
  sender.refused.delete(key);
  if (toAll && !sender.stopped) {
    await sendCovering(c, sender, x.messenger, d, x.current, sentTo, save, async () => {
      const q = await quote(c.deps.client, c.diamond, 'quoteBroadcastGlobal', [BigInt(d)]);
      if ('unread' in q) {
        sender.noteUnread(key, 'the fee of the send to every destination');
        return 'skipped';
      }
      if ('refused' in q) {
        sender.refused.set(key, `the Diamond would not quote the broadcast fee (${q.refused})`);
        return q.refused;
      }
      return sender.call('broadcast', d, 'broadcastGlobal', [BigInt(d)], q.fee);
    });
  }
  const all = sender.refused.get(key);
  if (all !== undefined || said.length > 0) sender.refused.set(key, [all, ...said].filter(Boolean).join('; '));
}
