// apps/keeper/src/rewardZeroedDay/plan.ts
//
// The zeroed-day pass's pure rule: given what a run read about one
// deliberately zeroed reward day on a mirror, what to do with it now. No reads
// and no sends: `index.ts` feeds this with what it read and carries out the
// step it names.

import type { ScannedEntry } from '../rewardEntries';

/** What a run read about one zeroed day. */
export interface ZeroedDayState {
  day: number;
  /** When this mirror's own interest close for the day ran (0: not yet). */
  closeSentAt: bigint;
  /** Whether the day's pool stamp (the quote's numerator) is installed. */
  stamped: boolean;
  /** The quote accumulation (`getCompQuoteAccum`). */
  accum: { cursorLender: bigint; cursorBorrower: bigint; accumLender: bigint; accumBorrower: bigint; consLender: bigint; consBorrower: bigint; sentAt: bigint };
  /** The day's frozen lapse clock (`getDayLapseClock`). */
  clock: { finalizedAt: bigint; scheduleVersion: number; lapseWindowSeconds: bigint };
  /** The day's compensation credit (`getDayCompensation`). */
  comp: { compensated: boolean; provisional: boolean; lenderPool: bigint; borrowerPool: bigint };
  resolvedZero: boolean;
  /** The lapse loss record (`getLapsedDayLoss`). */
  loss: { recorded: boolean; partialFigure: boolean };
  /** The short-lapse deadline (`getShortLapseDeadline`), read only for a
   *  compensated day. */
  shortDeadline: bigint | null;
}

export type ZeroedDayStep =
  /** Accumulate the quote to completion, then dispatch it toward Base. */
  | { kind: 'quote' }
  /** A full-lapsed day whose loss record is partial: accumulate to
   *  completion so the record becomes exact; dispatch is refused after a
   *  lapse, so none is sent. */
  | { kind: 'refine' }
  /** Retire a never-compensated day past its frozen expiry. */
  | { kind: 'lapse'; expiry: bigint }
  /** Retire a compensated day still funded below its quote past its
   *  deadline. */
  | { kind: 'short-lapse'; deadline: bigint }
  /** Nothing to send now; why, for the run's line. */
  | { kind: 'wait'; why: string }
  /** Terminal: nothing ever again. */
  | { kind: 'done' };

/** The step `s` calls for at chain time `now`. */
export function zeroedDayStep(s: ZeroedDayState, now: bigint): ZeroedDayStep {
  if (s.resolvedZero) return { kind: 'done' };
  if (s.loss.recorded) return s.loss.partialFigure ? quotable(s, { kind: 'refine' }) : { kind: 'done' };
  const clockOk = s.clock.finalizedAt > 0n && s.clock.scheduleVersion > 0;
  if (s.comp.compensated) {
    if (s.comp.provisional) return { kind: 'wait', why: 'its compensation credit is provisional, awaiting its broadcast' };
    if (s.accum.sentAt === 0n) return quotable(s, { kind: 'quote' });
    const short = s.comp.lenderPool < s.accum.accumLender || s.comp.borrowerPool < s.accum.accumBorrower;
    if (!short) return { kind: 'done' };
    if (!clockOk) return { kind: 'wait', why: 'funded below its quote, with no lapse clock to time a short lapse' };
    if (s.shortDeadline === null) return { kind: 'wait', why: 'funded below its quote; its short-lapse deadline was not read' };
    if (now <= s.shortDeadline) return { kind: 'wait', why: `funded below its quote; short lapse after ${s.shortDeadline}` };
    return { kind: 'short-lapse', deadline: s.shortDeadline };
  }
  if (clockOk && s.closeSentAt !== 0n) {
    const expiry = s.clock.finalizedAt + s.clock.lapseWindowSeconds;
    if (now > expiry) return { kind: 'lapse', expiry };
  }
  if (s.accum.sentAt === 0n) return quotable(s, { kind: 'quote' });
  if (!clockOk) return { kind: 'wait', why: 'quoted, with no lapse clock (version 0 or unset): it lapses only once a broadcast installs one' };
  return { kind: 'wait', why: `quoted; awaiting compensation, or a lapse after ${s.clock.finalizedAt + s.clock.lapseWindowSeconds}` };
}

/** The quote surface's own preconditions, said rather than sent into. */
function quotable(s: ZeroedDayState, step: ZeroedDayStep): ZeroedDayStep {
  if (s.closeSentAt === 0n) return { kind: 'wait', why: 'its local interest close has not run' };
  if (!s.stamped) return { kind: 'wait', why: 'its pool stamp is not installed' };
  return step;
}

/**
 * Whether a side's accumulation can still complete by paging the covering ids
 * past its cursor: what it has conserved must be exactly what the covering ids
 * at or below the cursor add up to. Any other figure means the cursor was moved
 * past covering ids that were never submitted (the accumulator is
 * permissionless), and only the administrator's reset frees the side. Null when
 * the side can complete; otherwise what is off.
 */
export function accumulationWedge(cover: readonly ScannedEntry[], cursor: bigint, conserved: bigint): string | null {
  const behind = cover.filter((e) => e.id <= cursor).reduce((a, e) => a + e.perDayNumeraire18, 0n);
  if (behind === conserved) return null;
  return `its cursor sits at entry ${cursor} with ${conserved} conserved, where the covering entries up to it add up to ${behind}`;
}
