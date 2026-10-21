// apps/keeper/src/rewardDayClose/fact.ts
//
// A read's result as the pass may use it: KNOWN, with its value, or UNKNOWN,
// with why. Every read the pass judges by returns one of these, never a
// default standing in for a failed read. The two rules that follow, applied
// everywhere:
//   - a precondition of an irreversible call (a close, a finalization) that
//     is unknown HOLDS the call, and the hold is said;
//   - a condition an alert names that is unknown is neither raised nor
//     cleared: the alert stands as it was until a read settles it.

export type Fact<T> = { known: true; value: T } | { known: false; why: string };

export const known = <T>(value: T): Fact<T> => ({ known: true, value });
export const unknown = (why: string): Fact<never> => ({ known: false, why });

/** The value when known, else `fallback`. Only for presentation (a log line),
 *  never for a judgement. */
export const shown = <T>(f: Fact<T>, fallback: T): T => (f.known ? f.value : fallback);

/** Per-day reads: every requested day has an entry. */
export type PerDay<T> = Map<number, Fact<T>>;

export const dayFact = <T>(m: PerDay<T>, d: number): Fact<T> => m.get(d) ?? unknown('not read');
