// apps/keeper/src/rewardDayClose/clock.ts
//
// Reward-clock alignment. A day number must cover the same hours on every
// chain, or a report is summed into Base's day with interest from other
// hours, irreversibly. So a mirror closes no day, and Base finalizes no day,
// unless every clock involved is KNOWN to match: a clock that differs holds
// them, and so does a clock that is not known. Alignment is never assumed.

import type { DayStore } from './store';
import type { PeerReader } from './deps';
import { launchOf, roleOf } from './reads';

/** A peer's reward-clock launch: read now, or as last read (`lastRead`) when
 *  this run's read failed; or unknown, with why. `role` is the peer's reward
 *  role as read with it (null = not known for its current Diamond). */
export type PeerClock = { known: true; launch: number; lastRead: boolean; role: number | null } | { known: false; why: string };

/**
 * A peer chain's reward-clock launch. Read now when it can be, and recorded
 * with the peer Diamond it was read from, so a mismatch once seen is never
 * forgotten because the peer stops answering. Unknown when no clock is known
 * for the peer's CURRENT Diamond: never read, or the peer now names another
 * Diamond than the one last read (recorded at once as that Diamond with its
 * clock unread, since a fresh Diamond may run another clock, so the hold
 * survives the peer ceasing to be served). For a peer this keeper does not
 * serve, its current Diamond is unknown and the last record stands.
 */
export async function peerClock(store: DayStore, peerChain: number, p: PeerReader | null, where: string): Promise<PeerClock> {
  let fresh: number | null = null;
  if (p !== null) {
    const [now, role] = await Promise.all([launchOf(p, where), roleOf(p, where)]);
    if (role.known) fresh = role.value;
    if (now.known) {
      const diamond = p.diamond.toLowerCase();
      // A role unread now stands as last read for the same Diamond only.
      const last = role.known ? null : await store.clock(peerChain);
      const r = role.known ? role.value : last?.diamond?.toLowerCase() === diamond ? (last.role ?? null) : null;
      await store.saveClock(peerChain, { diamond, launch: now.value, role: r });
      return { known: true, launch: now.value, lastRead: false, role: r };
    }
  }
  const rec = await store.clock(peerChain);
  if (rec === null) {
    return { known: false, why: p === null ? 'this keeper does not serve it and has never read its clock' : 'its clock has never been read (the read failed)' };
  }
  if (p !== null && rec.diamond?.toLowerCase() !== p.diamond.toLowerCase()) {
    await store.saveClock(peerChain, { diamond: p.diamond.toLowerCase(), launch: null, role: null });
    return { known: false, why: `it now names Diamond ${p.diamond}, not the one whose clock this keeper last read, and the new clock has not been read` };
  }
  if (rec.launch === null || !Number.isSafeInteger(rec.launch)) {
    return { known: false, why: `its Diamond (${rec.diamond}) changed since its clock was last read, and the new clock has not been read` };
  }
  // A role read this run supersedes the recorded one, whatever the clock read
  // did: a peer read as no longer canonical is never taken as canonical.
  if (fresh !== null && fresh !== rec.role) await store.saveClock(peerChain, { ...rec, role: fresh });
  return { known: true, launch: rec.launch, lastRead: true, role: fresh ?? rec.role ?? null };
}

/** The run's judgement of clock alignment, for its holds and its alerts. */
export interface ClockFacts {
  /** Base's launch, when known. */
  base: number | null;
  /** Chains whose known clock differs from Base's. */
  differ: { chain: number; launch: number; lastRead: boolean }[];
  /** Peers whose clock is not known, with why. */
  unknown: { chain: number; why: string }[];
  /** Some clock was judged from its last read (this run's read failed), so a
   *  match is not a read showing a fix. */
  stale: boolean;
}

/** A mirror's alignment with Base: its own launch against Base's. */
export function mirrorClock(self: number, launch: number, baseChain: number, base: PeerClock): ClockFacts {
  if (!base.known) return { base: null, differ: [], unknown: [{ chain: baseChain, why: base.why }], stale: false };
  return { base: base.launch, differ: base.launch === launch ? [] : [{ chain: self, launch, lastRead: false }], unknown: [], stale: base.lastRead };
}

/** Base's alignment with every expected mirror. */
export function baseClock(launch: number, mirrors: ReadonlyMap<number, PeerClock>): ClockFacts {
  const f: ClockFacts = { base: launch, differ: [], unknown: [], stale: false };
  for (const [chain, c] of mirrors) {
    if (!c.known) {
      f.unknown.push({ chain, why: c.why });
      continue;
    }
    if (c.lastRead) f.stale = true;
    if (c.launch !== launch) f.differ.push({ chain, launch: c.launch, lastRead: c.lastRead });
  }
  return f;
}

/** Why nothing clock-dependent may go ahead (null = the clocks are known to match). */
export function clockHold(f: ClockFacts): string | null {
  if (f.differ.length > 0) return `chain(s) ${f.differ.map((x) => x.chain).join(', ')} run a reward clock different from Base's`;
  if (f.unknown.length > 0) return `the reward clock of chain(s) ${f.unknown.map((x) => x.chain).join(', ')} is not known`;
  return null;
}
