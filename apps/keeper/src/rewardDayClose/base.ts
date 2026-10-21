// apps/keeper/src/rewardDayClose/base.ts
//
// Base's run, after its own closes: FINALIZE each day whose own report is
// recorded, when every chain on the expected-source list has reported or the
// grace window since the day's first report has elapsed, and only when the
// contract agrees (`isDayReadyToFinalize`); then BROADCAST each finalized day
// (broadcast.ts).
//
// Coverage is per CHAIN, never a report COUNT: a count can reach the
// expected number while an expected chain is still missing (a report from a
// chain not on the list counts too). A finalization is irreversible, so it is
// HELD, and the hold said, while any of its preconditions is not known:
// Base's expected-source list unread, or the reward clock of an expected
// mirror not known to match Base's. An empty list, or one without Base, is
// never finalized against.
//
// Each step reads before it sends, and the judgement of every day (its wait,
// its broadcast plan) is made whether or not the run still has sends left, so
// what the alerts say never depends on how far the sends got.

import type { Address } from 'viem';
import { baseClock, clockHold, peerClock, type ClockFacts, type PeerClock } from './clock';
import { graceWarningSec, REASON_FINALIZED } from './constants';
import type { ChainRun } from './deps';
import { dayFact, type Fact, type PerDay } from './fact';
import type { BaseFindings, Wait } from './findings';
import { broadcastDays } from './broadcast';
import { recordZeroed } from './notices';
import { PastRunDeadline } from '../batchRead';
import { shortErr } from './errors';
import { planFinalize, topologyOf, type BroadcastPlan } from './plan';
import { broadcastDestinations, expectedSources, peerSentAt, readDays, readReported } from './reads';
import type { Sender } from './sender';
import type { DayStore } from './store';

export interface BaseInput {
  window: readonly number[];
  /** Per window day, Base's own report recorded (read, or closed this run). */
  ownReported: PerDay<boolean>;
  messenger: Address;
  graceSec: number;
  launch: number;
  nowSec: number;
}

export async function runBase(c: ChainRun, store: DayStore, sender: Sender, x: BaseInput): Promise<{ b: BaseFindings; clock: ClockFacts | null; finalizedNow: number; broadcastNow: number }> {
  const expected: Fact<number[]> = await expectedSources({ diamond: c.diamond, client: c.deps.client }, c.where);
  const destinations = await broadcastDestinations(c.deps.client, x.messenger, c.where);
  const topology = expected.known && destinations.known ? topologyOf(expected.value, destinations.value, c.chainId) : null;

  // Every expected mirror must be known to run Base's reward clock.
  let clock: ClockFacts | null = null;
  if (expected.known) {
    const mirrors = new Map<number, PeerClock>();
    for (const m of expected.value) {
      // eslint-disable-next-line no-await-in-loop
      if (m !== c.chainId) mirrors.set(m, await peerClock(store, m, c.deps.peer(m), c.where));
    }
    clock = baseClock(x.launch, mirrors);
  }
  const finalizeHold = !expected.known ? "Base's expected-source list could not be read" : clockHold(clock!);
  // The broadcast needs both lists: the destinations it sends to, and the
  // expected mirrors, which are owed the day too.
  const broadcastHold = !destinations.known
    ? "the reward messenger's broadcast destinations could not be read (the messenger is unset, too old to list them, or the read failed)"
    : !expected.known
      ? "Base's expected-source list could not be read"
      : null;

  // A block no later than the reads below: a day they show open was open
  // from it, so its finalization's events lie after it.
  let seenAt: bigint | null = null;
  try {
    seenAt = await c.deps.client.getBlockNumber();
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${c.where}: block number unread; open days keep their last open-seen block: ${shortErr(err)}`);
  }
  const ready = await readDays<readonly [boolean, number]>(c, x.window, 'isDayReadyToFinalize');
  const firstAt = await readDays<bigint>(c, x.window, 'getDailyFirstReportAt');
  const isFinalized = (d: number) => {
    const r = dayFact(ready, d);
    return r.known ? Number(r.value[1]) === REASON_FINALIZED : null;
  };
  const open = x.window.filter((d) => isFinalized(d) === false);
  for (const d of x.window) if (isFinalized(d) === null) sender.noteUnread(`finalize:${d}`, 'whether the day is finalized or ready');
  const finalized = new Set(x.window.filter((d) => isFinalized(d) === true));
  const reported = expected.known ? await readReported(c, open, expected.value) : new Map<number, { reported: Set<number>; unknown: Set<number> }>();

  const judged = new Set<number>();
  const waiting = new Map<number, Wait>();
  let finalizedNow = 0;
  for (const d of open) {
    const own = dayFact(x.ownReported, d);
    const first = dayFact(firstAt, d);
    const r = dayFact(ready, d);
    // A day is judged only on known facts; anything unread leaves it for the
    // next run, its alerts standing as they were.
    if (!expected.known || !own.known || !first.known || !r.known) {
      // An unread list is the run's finalize hold, said as such.
      const what = [!own.known && "whether Base has closed it", !first.known && 'when its first report landed'].filter(Boolean).join(' and ');
      if (expected.known && what) sender.noteUnread(`finalize:${d}`, what);
      continue;
    }
    judged.add(d);
    const decision = planFinalize(
      {
        day: d,
        finalized: false,
        ownReported: own.value,
        selfChainId: c.chainId,
        contractReady: Boolean(r.value[0]),
        firstReportAt: Number(first.value),
        expected: expected.value,
        reported: reported.get(d)?.reported ?? new Set(),
        unknown: reported.get(d)?.unknown ?? new Set(expected.value),
      },
      x.graceSec,
      x.nowSec,
    );
    let pending: { missing: number[]; unknown: number[]; graceEndsAt: number | null } | null = null;
    if (decision.kind === 'finalize') {
      // eslint-disable-next-line no-await-in-loop
      const landed = finalizeHold === null && (await sender.call('finalize', d, 'finalizeDay', [BigInt(d)], 0n)) === 'landed';
      if (landed) {
        finalizedNow += 1;
        finalized.add(d);
      } else pending = { missing: decision.missing, unknown: [], graceEndsAt: Number(first.value) > 0 ? Number(first.value) + x.graceSec : null };
    } else if (decision.kind === 'wait') pending = decision;
    if (pending === null || pending.missing.length + pending.unknown.length === 0) continue;
    const nearEnd = pending.graceEndsAt !== null && pending.graceEndsAt - x.nowSec <= graceWarningSec(x.graceSec);
    // eslint-disable-next-line no-await-in-loop
    if (nearEnd) waiting.set(d, { ...pending, sent: await peerSentAt(c.deps, pending.missing, d, c.where) });
  }
  // Each open day's latest open-seen block; a day finalized since keeps the
  // block it was last seen open from, which its events lie after.
  const openSeen = new Map<number, bigint>();
  try {
    for (const [d, b] of await store.openSeen(x.window)) openSeen.set(d, BigInt(b));
    if (seenAt !== null) {
      for (const d of open) {
        openSeen.set(d, seenAt);
        // eslint-disable-next-line no-await-in-loop
        await store.saveOpenSeen(d, seenAt);
      }
    }
  } catch (err) {
    console.error(`[keeper] rewardDayClose ${c.where}: open-seen blocks unread or unsaved: ${shortErr(err)}`);
  }
  if (expected.known) await recordZeroed(c, store, x.window.filter((d) => finalized.has(d)), expected.value, openSeen);

  let plans = new Map<number, BroadcastPlan>();
  let broadcastNow = 0;
  if (broadcastHold === null && destinations.known && expected.known) {
    const r = await broadcastDays(c, store, sender, {
      days: x.window.filter((d) => finalized.has(d)),
      current: destinations.value,
      mirrors: expected.value.filter((m) => m !== c.chainId),
      messenger: x.messenger,
      nowSec: x.nowSec,
    });
    plans = r.plans;
    broadcastNow = r.sent;
  }

  const b: BaseFindings = { expected, destinations, topology, finalizeHold, broadcastHold, judged, waiting, finalized, broadcast: plans, noticed: new Set() };
  return { b, clock, finalizedNow, broadcastNow };
}
