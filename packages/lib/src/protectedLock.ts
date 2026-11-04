/**
 * #3088 — the one age limit for an emergency LOCK sent from Telegram, shared
 * by the agent (which records the request) and the keeper (which acts on it).
 *
 * A request is measured from the moment the owner SENT it (the Telegram
 * message's own date), never from when it reached a server: a LOCK delivered
 * late, after an outage, must not read as fresh and cancel a payout or an
 * unlock the owner has since moved past.
 */

/** A LOCK older than this is not acted on: the agent does not record it, and
 *  the keeper drops a recorded one and tells the chat. */
export const LOCK_REQUEST_TTL_SEC = 60 * 60;

/** Whether a LOCK sent at `sentAtSec` is too old to act on at `nowSec`. A
 *  request with no send time is treated as too old: its age cannot be
 *  known. Pure. */
export function lockRequestIsStale(sentAtSec: number | null, nowSec: number): boolean {
  return sentAtSec === null || nowSec - sentAtSec > LOCK_REQUEST_TTL_SEC;
}
