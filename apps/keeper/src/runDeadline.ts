/**
 * The one rule for a run that has a deadline (#2497 r18–r19).
 *
 * Every pass runs with a {@link PassTick.deadlineMs}: its scheduled minute plus
 * its own cadence, less a margin. The two places a run spends time on the
 * network — a batched chain read (`batchRead.ts`) and a transaction send
 * (`submissionQueue.ts`) — both take that deadline and refuse past it, so a
 * pass needs no deadline check of its own in any read or send loop: a read past
 * the deadline returns every entry unread, and a send past it is refused before
 * anything is signed. What a run did not reach waits for the next run.
 *
 * Until r19 each pass checked the deadline in the phases a review had named,
 * and each round found the next unbounded phase. One rule at the two seams
 * removes the class.
 */

/** Refused because the run's deadline has passed. Nothing was issued. */
export class RunDeadlinePassed extends Error {
  constructor(what: string) {
    super(`${what}: past the run deadline — left for the next run`);
    this.name = 'RunDeadlinePassed';
  }
}

/** Whether `err`, or any cause under it (viem wraps the queue's refusal in
 *  its contract error), is the deadline's refusal. */
export function isRunDeadlinePassed(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof RunDeadlinePassed) return true;
  }
  return false;
}

/** Whether a run with `deadlineMs` is out of time. */
export function pastDeadline(deadlineMs: number, nowMs: number = Date.now()): boolean {
  return nowMs >= deadlineMs;
}
