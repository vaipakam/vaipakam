/**
 * How an inbox row came to exist — the `event_kind` column's non-event
 * values, shared by the Worker that writes them and the app that renders
 * them.
 *
 * It lives in `@vaipakam/lib` because both sides need the SAME string and
 * neither owns it. The alternative was the indexer exporting it and the app
 * re-declaring the literal with a comment pointing at the producer, which is
 * a drift waiting to happen: a rename on the writing side leaves the reader
 * silently matching nothing, and the failure is invisible — the row renders,
 * it just renders without the thing the provenance was for.
 */

/**
 * The row was derived by the #2101 loan-status repair rather than from an
 * event the indexer saw.
 *
 * NOT `null`, which the notifications table already uses for the cron-derived
 * calendar reminders. The distinction matters to a reader: a calendar row
 * says something the platform worked out from a date it knows, while this
 * one says the platform has just discovered something that already happened
 * and cannot say when.
 */
export const NOTIF_EVENT_KIND_RECONCILED = 'Reconciled';

/** Whether an inbox row is a correction — i.e. the platform found the
 *  outcome by checking rather than by being told, so it knows WHAT happened
 *  and not WHEN. Surfaces use this to say so; a surface that renders the
 *  outcome alone presents a discovery as an announcement. */
export function isReconciledNotification(
  eventKind: string | null | undefined,
): boolean {
  return eventKind === NOTIF_EVENT_KIND_RECONCILED;
}
