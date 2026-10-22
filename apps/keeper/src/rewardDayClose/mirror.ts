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
// out, so the day stays owed here; while it cannot be read, the day stays
// owed and the run says which read failed.

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

  const day = (d: number): { finalized: Fact<boolean>; counted: Fact<boolean>; included: Fact<boolean> | null } => {
    if (baseDays === 'unserved') return { finalized: unknown('Base not served'), counted: unknown('Base not served'), included: unknown('Base not served') };
    const v = baseDays.get(d);
    return { finalized: v?.finalized ?? unknown('not read'), counted: v?.counted ?? unknown('not read'), included: v === undefined ? unknown('not read') : v.included };
  };
  const outcome: PerDay<boolean> = new Map();
  const excluded: PerDay<boolean> = new Map();
  const landedNotCounted = new Set<number>();
  for (const d of x.window) {
    const { finalized, counted, included } = day(d);
    // Base's outcome for this chain is final only once the day is finalized
    // (a report Base has counted can still be left out, if the chain leaves
    // the expected-source list before finalization), and learned here once
    // whether Base holds this chain's report is read too.
    // On a Base that keeps the inclusion record (#2626), a landed report's
    // outcome is learned only once that record is read too: settling the day
    // without it would drop the one statement that says the report was left
    // out. A Base that answered it keeps no such record settles as before.
    if (!finalized.known) outcome.set(d, unknown(finalized.why));
    else if (!finalized.value) outcome.set(d, known(false));
    else if (!counted.known) outcome.set(d, unknown(counted.why));
    else if (counted.value && included !== null && !included.known) outcome.set(d, unknown(included.why));
    else outcome.set(d, known(true));
    // An outcome left unread keeps the day owed (run.ts), so it is said, like
    // every other step a failed read holds. Unserved, there is none to learn.
    if (base !== null && !outcome.get(d)!.known) {
      sender.noteUnread(
        `outcome:${d}`,
        !finalized.known ? 'whether Base has finalized the day' : !counted.known ? "whether Base holds this chain's report for the day" : "whether Base included this chain's report in the finalized day",
      );
    }
    // Finalized without this chain's report: excluded, known. Finalized with
    // it: included only if the chain was on Base's list when the day was
    // finalized. A Base built with #2626 records that; one built before it
    // answers that it keeps no such record, so there it is not known, and
    // never said either way.
    if (!finalized.known || !finalized.value) excluded.set(d, finalized.known ? known(false) : unknown(finalized.why));
    else if (!counted.known) excluded.set(d, unknown(counted.why));
    else if (!counted.value) excluded.set(d, known(true));
    else if (included === null) excluded.set(d, unknown("whether Base counted this chain's landed report into the finalized day is not readable on a Base built before #2626"));
    else if (!included.known) excluded.set(d, unknown(included.why));
    else {
      excluded.set(d, known(!included.value));
      if (!included.value) landedNotCounted.add(d);
    }
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
    landedNotCounted,
    dispatched,
  };
  return { m, clock, closed: run.closed };
}
