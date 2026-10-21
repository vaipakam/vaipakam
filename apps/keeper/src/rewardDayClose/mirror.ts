// apps/keeper/src/rewardDayClose/mirror.ts
//
// A mirror's run: read what Base says about this chain and its days, then
// close every elapsed day not yet reported here, when it is safe to.
//
// Safe means, for EVERY close (each sends a report once, stamped sent here
// for good):
//   - the reward clock here and on Base are known to match (a day number must
//     cover the same hours on both); and
//   - the messenger routes reports to the Diamond's Base (its own
//     `baseChainId`), known, not assumed.
// Either unknown holds every close, and the alerts say which and why. A day's
// report is still sent when this chain is off Base's expected-source list
// (Base refuses it, and the run says so) and when Base has finalized the day
// (the B4 report's chain-wide figures still apply).
//
// For every window day, sent or not, a day Base finalized without this
// chain's report is stated as such, once.

import type { Address } from 'viem';
import { clockHold, mirrorClock, peerClock } from './clock';
import { closeDays, type BaseDays } from './close';
import type { ChainRun } from './deps';
import { known, unknown, type Fact, type PerDay } from './fact';
import type { MirrorFindings } from './findings';
import { expectedSources, messengerRoute, readBaseDays } from './reads';
import type { Sender } from './sender';
import type { ClockFacts } from './clock';
import type { DayStore } from './store';

export interface MirrorInput {
  window: readonly number[];
  /** Window days not yet reported here (read as such). */
  unclosed: readonly number[];
  launch: number;
  messenger: Address;
  baseChainId: number;
}

export async function runMirror(c: ChainRun, store: DayStore, sender: Sender, x: MirrorInput): Promise<{ m: MirrorFindings; clock: ClockFacts; closed: number[] }> {
  const base = c.deps.peer(x.baseChainId);
  const baseDays: BaseDays = base === null ? 'unserved' : await readBaseDays(base, x.window, c.chainId, c.deps.sendDeadline);
  const listed = base === null ? null : await expectedSources(base, c.where);
  const clock = mirrorClock(c.chainId, x.launch, x.baseChainId, await peerClock(store, x.baseChainId, base, c.where));
  const route = await messengerRoute(c.deps.client, x.messenger, c.where);
  const closeHold =
    clockHold(clock) ??
    (!route.known ? "the messenger's report route is unread" : route.value !== x.baseChainId ? `the messenger routes reports to chain ${route.value}, not Base` : null);

  const run = closeHold === null ? await closeDays(c, store, sender, x.unclosed, { messenger: x.messenger, baseDays }) : { closed: [], dispatched: new Map() };
  // This run's unchecked dispatches, and the earlier ones still recorded.
  const dispatched = new Map([...(await store.dispatches(x.window)), ...run.dispatched]);

  const day = (d: number): { finalized: Fact<boolean>; counted: Fact<boolean> } => {
    if (baseDays === 'unserved') return { finalized: unknown('Base not served'), counted: unknown('Base not served') };
    const v = baseDays.get(d);
    return { finalized: v?.finalized ?? unknown('not read'), counted: v?.counted ?? unknown('not read') };
  };
  const outcome: PerDay<boolean> = new Map();
  const excluded: PerDay<boolean> = new Map();
  for (const d of x.window) {
    const { finalized, counted } = day(d);
    // Counted, or finalized without it: Base has recorded this chain's
    // outcome. Known only once both reads that decide it are in.
    if (counted.known && counted.value) outcome.set(d, known(true));
    else if (counted.known && finalized.known) outcome.set(d, known(finalized.value));
    else outcome.set(d, unknown(!counted.known ? counted.why : finalized.known ? 'not read' : finalized.why));
    if (counted.known && counted.value) excluded.set(d, known(false));
    else if (counted.known && finalized.known) excluded.set(d, known(finalized.value));
    else excluded.set(d, unknown('not read'));
  }

  const m: MirrorFindings = {
    baseChainId: x.baseChainId,
    baseServed: base !== null,
    notExpectedOnBase: listed === null ? 'unserved' : listed.known ? known(!listed.value.includes(c.chainId)) : listed,
    messenger: x.messenger,
    route,
    closeHold,
    outcome,
    excluded,
    dispatched,
  };
  return { m, clock, closed: run.closed };
}
