/**
 * The one rule for a run that has a deadline (#2497 r18–r21).
 *
 * Every pass runs with a {@link PassTick.deadlineMs}: its scheduled minute plus
 * its own cadence, less a margin. The two places a run touches the network
 * both refuse past it: the read client (`keeperClient.ts`) refuses every
 * request at its transport — a read, a simulation, a multicall, a log scan,
 * a receipt poll — and the submission queue (`submissionQueue.ts`) refuses a
 * send before anything is signed. So a pass needs no deadline check of its
 * own in any read or send loop, and none in a loop written later: a batched
 * read past the deadline returns every entry unread (`batchRead.ts`), any
 * other request rejects with {@link RunDeadlinePassed}, and a send past it is
 * never signed. What a run did not reach waits for the next run.
 *
 * Until r19 each pass checked the deadline in the phases a review had named,
 * and each round found the next unbounded phase; r20 and r21 then found the
 * raw reads the batched reader did not cover. Binding the transport removes
 * the class, because there is no read that does not go through it.
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
