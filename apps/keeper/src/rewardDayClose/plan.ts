// apps/keeper/src/rewardDayClose/plan.ts
//
// The pass's PURE rules: which days a run works, when a day finalizes, what a
// finalized day's broadcast needs, what a landed transaction's receipt shows,
// and what is wrong with Base's lists. No reads, no writes: every input is a
// value the caller has read.

import type { Address, TransactionReceipt } from 'viem';
import { BROADCAST_LATE_AFTER_SEC, BROADCAST_RESEND_AFTER_SEC, BROADCAST_SENT_TOPICS, LOOKBACK_DAYS, REPORT_SENT_TOPIC } from './constants';

/** The elapsed days a run works, in the order it works them: the last
 *  `lookback` elapsed days, oldest first, then `owed`, a page of older days
 *  the ledger holds as not yet worked through, oldest first. The recent days
 *  come first because they are the ones still inside Base's grace: a backlog
 *  day worked ahead of them could spend the run's sends while a recent day's
 *  report runs out of time. Floored at day 0; empty on day 0. */
export function dayWindow(today: number, owed: readonly number[] = [], lookback = LOOKBACK_DAYS): number[] {
  const recent: number[] = [];
  for (let d = Math.max(0, today - lookback); d < today; d++) recent.push(d);
  const backlog = [...new Set(owed)].filter((d) => Number.isSafeInteger(d) && d >= 0 && d < Math.max(0, today - lookback));
  return [...recent, ...backlog.sort((a, b) => a - b)];
}

/** What Base's state says about one day, for finalization. */
export interface FinalizeInput {
  day: number;
  finalized: boolean;
  /** Base's own report for the day is recorded (`getChainReportSentAt != 0`). */
  ownReported: boolean;
  /** The contract's readiness (`isDayReadyToFinalize`). */
  contractReady: boolean;
  /** `getDailyFirstReportAt` (0 = no report yet). */
  firstReportAt: number;
  /** Base's own chain id: a list without it is never finalized against. */
  selfChainId: number;
  /** Base's expected-source list and which of them have reported this day. */
  expected: readonly number[];
  reported: ReadonlySet<number>;
  /** Expected chains whose report status could not be read this run: neither
   *  reported nor missing, and never counted toward full coverage. */
  unknown?: ReadonlySet<number>;
}

export type FinalizeDecision =
  | { kind: 'done' }
  | { kind: 'own-report-first' }
  | { kind: 'no-expected' }
  | { kind: 'self-not-expected' }
  | { kind: 'finalize'; missing: number[] }
  | { kind: 'wait'; missing: number[]; unknown: number[]; graceEndsAt: number | null };

/**
 * Whether to finalize a day now. Finalize when every expected chain has
 * reported, or when the grace since the day's first report has elapsed, and
 * in either case only when the contract agrees. Coverage is judged chain by
 * chain, never by the contract's report count, which a report from a chain
 * not on the list also raises.
 */
export function planFinalize(x: FinalizeInput, graceSec: number, nowSec: number): FinalizeDecision {
  if (x.finalized) return { kind: 'done' };
  if (!x.ownReported) return { kind: 'own-report-first' };
  if (x.expected.length === 0) return { kind: 'no-expected' };
  // Base's own interest would be left out of the day's total, irreversibly.
  if (!x.expected.includes(x.selfChainId)) return { kind: 'self-not-expected' };
  const unknown = x.expected.filter((c) => !x.reported.has(c) && x.unknown?.has(c) === true);
  const missing = x.expected.filter((c) => !x.reported.has(c) && x.unknown?.has(c) !== true);
  const graceEndsAt = x.firstReportAt > 0 ? x.firstReportAt + graceSec : null;
  const graceElapsed = graceEndsAt !== null && nowSec >= graceEndsAt;
  const complete = missing.length === 0 && unknown.length === 0;
  if ((complete || graceElapsed) && x.contractReady) return { kind: 'finalize', missing };
  return { kind: 'wait', missing, unknown, graceEndsAt };
}

/** One broadcast destination, as this run read it. */
export type DestinationState = 'received' | 'missing' | 'unread' | 'unserved';

/** This keeper's last send of a day covering one destination: when it went,
 *  and whether its receipt shows the message leaving for that destination
 *  (false: written before the send, or the send went out with no receipt
 *  seen, so whether it left is unknown). */
export interface SendMark {
  at: number;
  proven: boolean;
}

/** What to do for a finalized day's broadcast this run, per destination. */
export interface BroadcastPlan {
  /** Destinations to send to now. */
  send: number[];
  /** Of `send`, those this keeper sent the day to before (a re-send). */
  resend: number[];
  /** Destinations sent to, not read as holding the day, past the late mark
   *  since their last send: `missing` read as lacking it, `unread` unknown. */
  late: { chain: number; state: 'missing' | 'unread'; sentAt: number }[];
  /** Destinations sent to that this keeper does not serve: never confirmed. */
  unconfirmed: number[];
  /** Destinations this keeper does not serve whose last send is not shown to
   *  have left for them (its receipt was not seen): re-sent once the re-send
   *  interval has passed, since nothing else can say whether it went. */
  unproven: number[];
  /** Every destination holds the day, or was sent it and cannot be read. */
  done: boolean;
}

/**
 * The broadcast plan for a finalized day, judged destination by destination:
 * `sentTo` is this keeper's last send covering each (absent or null = never),
 * so a destination added after the day was sent is sent to like any other
 * never-sent one.
 *
 * A destination holding the day needs nothing. One never sent to is sent to,
 * whatever its read (the ingress applies a day once). One sent to and not
 * served cannot be confirmed: it is done once a send's receipt shows the
 * message leaving for it, and otherwise re-sent after
 * {@link BROADCAST_RESEND_AFTER_SEC}, the receipt being the only evidence this
 * keeper can have for it. One sent to and read as lacking it is late after
 * {@link BROADCAST_LATE_AFTER_SEC} and re-sent after the re-send interval; one
 * whose read failed is never re-sent blind, and is late (as unknown) past the
 * late mark. Lateness is measured from the last send and never depends on what
 * this run then sends, so a late destination is reported in the run that
 * re-sends.
 */
export function planBroadcast(dest: ReadonlyMap<number, DestinationState>, sentTo: ReadonlyMap<number, SendMark | null>, nowSec: number): BroadcastPlan {
  const plan: BroadcastPlan = { send: [], resend: [], late: [], unconfirmed: [], unproven: [], done: true };
  for (const [c, state] of dest) {
    if (state === 'received') continue;
    const mark = sentTo.get(c) ?? null;
    if (mark === null) {
      plan.send.push(c);
      plan.done = false;
      continue;
    }
    const since = nowSec - mark.at;
    if (state === 'unserved') {
      if (mark.proven) {
        plan.unconfirmed.push(c);
        continue;
      }
      plan.done = false;
      if (since >= BROADCAST_RESEND_AFTER_SEC) {
        plan.send.push(c);
        plan.resend.push(c);
      } else plan.unproven.push(c);
      continue;
    }
    plan.done = false;
    if (since >= BROADCAST_LATE_AFTER_SEC) plan.late.push({ chain: c, state, sentAt: mark.at });
    if (state === 'missing' && since >= BROADCAST_RESEND_AFTER_SEC) {
      plan.send.push(c);
      plan.resend.push(c);
    }
  }
  return plan;
}

/** The destinations a landed broadcast of day `day` sent a message to, read
 *  from the messenger's own events in its receipt: what the transaction did,
 *  not what the run expected it to do. `messengers` are the addresses the
 *  Diamond may have sent through (the one the run read, and the one it holds
 *  at the receipt's block, in case governance rotated it in between). Null
 *  when the receipt carries such an event from any other address, so what
 *  the send covered cannot be told; empty without a receipt. */
export function broadcastsLeft(receipt: TransactionReceipt | null, messengers: readonly Address[], day: number): Set<number> | null {
  const out = new Set<number>();
  if (receipt === null) return out;
  const known = new Set(messengers.map((m) => m.toLowerCase()));
  for (const log of receipt.logs) {
    const [sig, , dst, dayTopic] = log.topics;
    if (sig === undefined || dst === undefined || dayTopic === undefined || !BROADCAST_SENT_TOPICS.has(sig.toLowerCase())) continue;
    if (BigInt(dayTopic) !== BigInt(day)) continue;
    if (!known.has(log.address.toLowerCase())) return null;
    out.add(Number(BigInt(dst)));
  }
  return out;
}

/** Null when a landed close's receipt shows its report leaving through
 *  `checked`; otherwise the addresses its report events came from (empty when
 *  it carries none), so the caller can say the report left unchecked. Without
 *  a receipt nothing can be told, and null is returned. */
export function reportSentVia(receipt: TransactionReceipt | null, checked: Address): Address[] | null {
  if (receipt === null) return null;
  const from = [...new Set(receipt.logs.filter((l) => l.topics[0]?.toLowerCase() === REPORT_SENT_TOPIC).map((l) => l.address.toLowerCase() as Address))];
  return from.includes(checked.toLowerCase() as Address) ? null : from;
}

/** Base's expected-source list against the messenger's broadcast list. */
export interface Topology {
  /** Expected mirrors the send to every destination does not reach. */
  undeliverable: number[];
  /** Destinations whose reports Base refuses as unexpected. */
  unexpected: number[];
  /** Base itself is a destination. */
  self: boolean;
  /** Destinations listed more than once. */
  repeated: number[];
}

export function topologyOf(expected: readonly number[], destinations: readonly number[], self: number): Topology {
  return {
    undeliverable: expected.filter((c) => c !== self && !destinations.includes(c)),
    unexpected: destinations.filter((c) => !expected.includes(c)),
    self: destinations.includes(self),
    repeated: [...new Set(destinations.filter((c, i) => destinations.indexOf(c) !== i))],
  };
}

/** What is wrong with Base's lists, one sentence each (empty = nothing). */
export function topologyFaults(t: Topology, self: number): string[] {
  const out: string[] = [];
  if (t.undeliverable.length > 0) {
    // Not an outage in itself: the pass sends each finalized day to these
    // alone. What stands is that only that separate send reaches them, and a
    // day it cannot make is said for that day (broadcast.ts).
    out.push(
      `chain(s) ${t.undeliverable.join(', ')} are on Base's expected-source list but are not broadcast destinations, so the send to every destination does not reach them: each finalized day reaches them only by a separate send to each alone, which this keeper makes and pays for, and a day it cannot send them that way is said for that day`,
    );
  }
  const unexpected = t.unexpected.filter((c) => c !== self);
  if (unexpected.length > 0) {
    out.push(`chain(s) ${unexpected.join(', ')} are broadcast destinations but not on Base's expected-source list, so Base refuses their reports (SourceChainIdNotExpected) and every day finalizes without their interest`);
  }
  if (t.self) out.push(`Base itself (${self}) is a broadcast destination, so every broadcast pays for a message to itself that serves no one`);
  if (t.repeated.length > 0) out.push(`chain(s) ${t.repeated.join(', ')} appear more than once among the broadcast destinations, so every broadcast pays for and sends each of them more than once`);
  return out;
}
