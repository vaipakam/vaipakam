/**
 * THE TWO DATABASES THE #2214 CUTOVER IS BETWEEN, pinned by id as well as
 * name, in one place because three tools need the same pair and a copy in
 * each is a copy that can drift.
 *
 * WHY BOTH FIELDS. A name is a label the account can reassign: delete a
 * database and recreate it under the same name and every name-keyed lookup
 * resolves to different data, silently. An id cannot be reused. Review
 * found this twice from opposite directions — the carry tool would have
 * mirrored over an unrelated account database that happened to be one end
 * by name (#2267 r3), and the live-binding probe would have passed a
 * rollback in which every Worker was attached to a REPLACEMENT database
 * wearing the predecessor's name while the retained data sat elsewhere
 * (#2267 r23). Same defect, two tools, one cause.
 *
 * WHY NOT READ THE PAIR FROM `apps/indexer/wrangler.jsonc`. That binding
 * says what the Workers are attached to right now, and across a cutover
 * that is precisely the thing in motion — during the barrier it says
 * nothing at all, which is the window in which these tools run (#2267
 * r22). The endpoints of the move are not in motion: they are what the
 * move is between.
 *
 * DRIFT IS STILL CAUGHT, in the place that owns the question:
 * `check-d1-name-consistency` validates `SUCCESSOR.name` against what
 * every binding and every `wrangler d1` command agrees on, so a tree where
 * the Workers bind one database and these tools would act on another is
 * red in CI.
 *
 * When the predecessor is finally deleted, this module and the tools that
 * read it go together.
 */

/** The database being moved to — the shared one, after the cutover. */
export const SUCCESSOR = {
  name: 'vaipakam-warm',
  id: 'e5e927cf-56c3-42c7-9820-179a235cc84f',
};

/** The database being left behind, retained as the rollback target. */
export const PREDECESSOR = {
  name: 'vaipakam-archive',
  id: '3cffebf5-b652-4da7-953c-9e1d143ad2fe',
};

/**
 * Resolve a database NAME to the pinned pair, or `null` if it is neither.
 *
 * Callers use this instead of asking the account what owns a name. The
 * difference is the whole point: an account lookup answers "what is called
 * this today", and this answers "which of the two databases this move is
 * between did you mean" — which is the question every caller actually has.
 */
export function knownDatabase(name) {
  for (const db of [SUCCESSOR, PREDECESSOR]) if (db.name === name) return db;
  return null;
}
