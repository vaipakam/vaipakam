// apps/keeper/src/rewardDayClose/mirror.ts
//
// A mirror's run: read what Base says about this chain and its days, then
// close every elapsed day not yet reported here, when it is safe to.
//
// Safe means, for EVERY close (each sends a report once, stamped sent here
// for good):
//   - the reward clock here and on Base are known to match (a day number must
//     cover the same hours on both);
//   - the chain this Diamond names as Base reads, THIS run, as the canonical
//     reward chain (a non-canonical Diamond refuses the report; a role can
//     change, so it is never taken from a record, and a keeper that does not
//     serve Base closes no day); and
//   - the report channel to Base is wired to ACCEPT the report, every link
//     read this run on both ends (wire.ts): a report the receiving end
//     refuses is still sent and stamped sent here, its fee paid.
// Any of them unknown holds every close, and the alerts say which and why. A day's
// report is still sent when this chain is off Base's expected-source list
// (Base refuses it, and the run says so) and when Base has finalized the day
// (the B4 report's chain-wide figures still apply).
//
// For every window day, sent or not, a day Base finalized without this
// chain's report is stated as such, once. Base's outcome for a day is final
// only once it is finalized: until then a counted report can still be left
// out, so the day stays owed here.

import type { Address } from 'viem';
import { clockHold, mirrorClock, peerClock } from './clock';
import { ROLE_CANONICAL } from './constants';
import { closeDays, type BaseDays } from './close';
import type { ChainRun } from './deps';
import { known, unknown, type Fact, type PerDay } from './fact';
import type { MirrorFindings } from './findings';
import { expectedSources, readBaseDays } from './reads';
import type { Sender } from './sender';
import type { ClockFacts } from './clock';
import type { DayStore } from './store';
import { reportWire } from './wire';

export interface MirrorInput {
  window: readonly number[];
  /** Window days not yet reported here (read as such). */
  unclosed: readonly number[];
  launch: number;
  messenger: Address;
  baseChainId: number;
}

export async function runMirror(c: ChainRun, store: DayStore, sender: Sender, x: MirrorInput): Promise<{ m: MirrorFindings; clock: ClockFacts; closed: number[] }> {
  const base = await c.peers.peer(x.baseChainId);
  const baseDays: BaseDays = base === null ? 'unserved' : await readBaseDays(base, x.window, c.chainId, c.deps.sendDeadline);
  const listed = base === null ? null : await expectedSources(base, c.where);
  const baseClock = await peerClock(store, x.baseChainId, base, c.where);
  const clock = mirrorClock(c.chainId, x.launch, x.baseChainId, baseClock);
  const wire = await reportWire(c, base, x.messenger, x.baseChainId);
  // The chain this Diamond names as Base must be the canonical reward chain:
  // a report a non-canonical Diamond receives is refused there, and is sent
  // once and stamped sent here for good.
  const roleHold =
    !baseClock.known || baseClock.role === ROLE_CANONICAL
      ? null
      : baseClock.role === null
        ? `the reward role of chain ${x.baseChainId}, which this Diamond names as Base, is not known (${base === null ? 'this keeper does not serve that chain' : 'this run could not read it'}; a role is read afresh every run, since it can change)`
        : `chain ${x.baseChainId}, which this Diamond names as Base, is not the canonical reward chain (its role reads ${baseClock.role})`;
  const closeHold =
    clockHold(clock) ??
    roleHold ??
    (!wire.known ? `the report channel to Base could not be read whole: ${wire.why}` : wire.value.length > 0 ? 'the report channel to Base is not wired to accept a report' : null);

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
    // Base's outcome for this chain is final only once the day is finalized
    // (a report Base has counted can still be left out, if the chain leaves
    // the expected-source list before finalization), and learned here once
    // whether Base holds this chain's report is read too.
    if (!finalized.known) outcome.set(d, unknown(finalized.why));
    else if (!finalized.value) outcome.set(d, known(false));
    else outcome.set(d, counted.known ? known(true) : unknown(counted.why));
    // Finalized without this chain's report: excluded, known. Finalized with
    // it: included only if the chain was on Base's list when the day was
    // finalized, which Base does not expose (#2626), so not known, and never
    // said either way.
    if (!finalized.known || !finalized.value) excluded.set(d, finalized.known ? known(false) : unknown(finalized.why));
    else if (!counted.known) excluded.set(d, unknown(counted.why));
    else excluded.set(d, counted.value ? unknown("whether Base counted this chain's landed report into the finalized day is not readable on Base") : known(true));
  }

  const m: MirrorFindings = {
    baseChainId: x.baseChainId,
    baseServed: base !== null,
    notExpectedOnBase: listed === null ? 'unserved' : listed.known ? known(!listed.value.includes(c.chainId)) : listed,
    messenger: x.messenger,
    wire,
    closeHold,
    outcome,
    excluded,
    dispatched,
  };
  return { m, clock, closed: run.closed };
}
