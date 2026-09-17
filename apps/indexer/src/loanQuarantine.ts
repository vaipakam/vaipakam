/**
 * Memory of the loan rows a reconciliation pass could not settle (#2212).
 *
 * The pass examines one or three rows a turn and reports, for that turn, the
 * rows it could not settle. #2211 used that report directly to withhold
 * reminders — which narrowed the window without closing it, because on the
 * NEXT turn the row is not in the report at all: the exclusion is empty for
 * its id and the unretractable reminder is minted anyway.
 *
 * The aliasing is the defect. "What this pass examined" is not "what is
 * currently unsettled", and any fix reading only the current pass carries it
 * — including the cruder one of deferring the whole sweep whenever the
 * report is dirty, which fails identically and costs every healthy loan on
 * the chain its reminders as well.
 *
 * So the unsettled state is remembered until a later pass settles it. Two
 * halves, and the second is the one to get right: a marker that is never
 * cleared silently withholds a healthy loan's reminders forever, which is the
 * mirror image of the defect this fixes.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ReconcileReport } from './loanReconcile';

/**
 * How long a row may sit quarantined before it stops being a blip.
 *
 * Not an expiry — nothing is released on a timer, because time does not
 * settle a row against the chain. It is the threshold at which the operator
 * is told, since a row unsettled for this long is a ghost nobody has
 * resolved rather than an RPC having a bad minute.
 */
export const QUARANTINE_STALE_SECONDS = 6 * 60 * 60;

/**
 * How many held rows to NAME in one warning.
 *
 * A cap is needed — a chain with hundreds of held rows must not emit a
 * hundred-line log line — but the cap is why the TOTAL is counted separately.
 * Naming twenty and saying nothing else would let everything behind them
 * suppress reminders while never appearing anywhere.
 */
export const STALE_REPORT_LIMIT = 20;

/**
 * How many held ids to NAME in one warning, described or not.
 *
 * The roll call exists because a held id that appears nowhere suppresses
 * reminders with nothing anywhere saying which position it concerns (#2231
 * r5). One revision then read and named EVERY held id with no bound at all,
 * which trades that defect for a worse one (#2231 r7 `4035821168`): rows
 * materialised, memory, CPU and log bytes all growing with the size of the
 * problem, so the report fails exactly on the chain that most needs it — and
 * it fails inside the invocation that must still write the scan cursor.
 *
 * A bound is therefore not optional. What IS optional is whether crossing it
 * is silent, and it must not be: past this many, the report says how many
 * more are held — the count is EXACT, taken in the same statement via
 * `COUNT(*) OVER ()` rather than inferred from a truncated page — and gives
 * the query that lists them. "More than I will name here, and here is how to
 * see them" is an honest bound; a page that stops without saying so is the
 * silent truncation this whole module exists to avoid.
 *
 * The number is a judgement about one log line, not a protocol constant:
 * 200 ids is roughly 1.5 KB, which a log surface carries intact, and a chain
 * holding more than 200 has a systemic fault where the exact roster matters
 * less than the magnitude does.
 */
export const STALE_ROLL_CALL_LIMIT = 200;

/** Which of the four ways a row failed to settle. Kept, not flattened. */
export type QuarantineReason = 'unread' | 'write-failed' | 'orphan' | 'unknown-status';

/** Every row this pass could not settle, each with WHY. */
export function unsettledRows(report: ReconcileReport): { loanId: number; reason: QuarantineReason }[] {
  return [
    ...report.unread.map((loanId) => ({ loanId, reason: 'unread' as const })),
    ...report.writeFailed.map((loanId) => ({ loanId, reason: 'write-failed' as const })),
    ...report.unresolvable.map((loanId) => ({ loanId, reason: 'orphan' as const })),
    ...report.unknownStatus.map((u) => ({ loanId: u.loanId, reason: 'unknown-status' as const })),
  ];
}

/**
 * Rows this pass DID settle, and which may therefore be released.
 *
 * Everything it examined, minus everything it could not settle. A repaired
 * row is settled (it is terminal now); a row another writer terminalized is
 * settled for the same reason; a row examined and found genuinely running is
 * settled, which is the ordinary case and the one that releases a transient
 * read failure from quarantine on the next lap.
 *
 * Derived by subtraction rather than listed, deliberately: a new failure
 * bucket added to the report would otherwise be released here by default —
 * marked unsettled by one function and cleared by the other, on the same
 * pass, with nothing failing. Subtraction makes the new bucket quarantine
 * correctly the moment `unsettledRows` knows about it.
 */
export function settledRows(report: ReconcileReport): number[] {
  const unsettled = new Set(unsettledRows(report).map((r) => r.loanId));
  return [
    ...new Set([
      ...report.examined.filter((id) => !unsettled.has(id)),
      ...report.repaired.map((r) => r.loanId),
      ...report.superseded,
    ]),
  ].filter((id) => !unsettled.has(id));
}

/**
 * The quarantine writes for one pass, as statements.
 *
 * Statements rather than awaited calls so the whole set commits as ONE D1
 * transaction: the marks and the releases describe a single pass's findings,
 * and half of them landing would leave a row released by a pass that also
 * found it unsettled, or vice versa.
 *
 * **What this does NOT get, stated rather than implied:** they cannot ride
 * the repairs' own transactions. Each repair commits during the pass, while
 * this set is derived from the report the pass produces at the END — so the
 * two are necessarily separate commits. If the isolate dies in between, the
 * quarantine for that pass is lost.
 *
 * That is bounded and self-healing rather than silent: the row is still
 * unsettled, so the next time the rotation examines it the mark is written
 * again. The exposure is one rotation's worth of reminders for a row the
 * platform has not confirmed — which is strictly better than the per-pass
 * exclusion this replaces, and not a guarantee, and the difference is worth
 * a reader's time.
 */
export function quarantineStatements(
  db: D1Database,
  chainId: number,
  report: ReconcileReport,
  nowSec: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const { loanId, reason } of unsettledRows(report)) {
    // `first_seen_at` is deliberately NOT in the update list. It is the
    // operator's whole signal — minutes means a transient read, days means a
    // ghost nobody resolved — and an upsert that refreshed it on every
    // re-observation would erase exactly that.
    statements.push(
      db
        .prepare(
          `INSERT INTO loan_reconcile_quarantine
             (chain_id, loan_id, reason, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, loan_id) DO UPDATE SET
             reason = excluded.reason,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(chainId, loanId, reason, nowSec, nowSec),
    );
  }
  // ONE STATEMENT PER ROW, not an interpolated `IN (...)` list. The pass
  // examines one or three rows a turn, so the list is a handful and the
  // saving is nil — while an interpolated statement leaves the reach of the
  // #1149 SQL-vs-schema guard, which reads static prepare sites. Paying a
  // guard's worth of coverage for nothing is a bad trade, and the guard's
  // own escape hatch ("raise the pin with a test covering the dynamic
  // shape") is for cases that cannot be written statically. This can.
  for (const loanId of settledRows(report)) {
    // `RETURNING first_seen_at`, so this release can be DISCLOSED when it is
    // worth disclosing (#2231 r7 `4035821181`).
    //
    // The overwhelming majority of these deletes are no-ops against a marker
    // that was never there, and the rest are the healthy case the module is
    // built around: a read failed, the row was held for a lap, this pass
    // settled it. Announcing those would bury the ones that matter.
    //
    // What a returned row gives is the one fact that separates them —
    // `first_seen_at`. A marker held past the stale threshold has been named
    // in the operator's report on every pass since, and this delete is the
    // last thing that ever happens to it. `discloseSettledReleases` below
    // decides; the statement only has to bring back what that decision needs,
    // which it does at no extra cost, inside a batch that already ran.
    statements.push(
      db
        .prepare(
          `DELETE FROM loan_reconcile_quarantine
            WHERE chain_id = ? AND loan_id = ?
            RETURNING loan_id, reason, first_seen_at`,
        )
        .bind(chainId, loanId),
    );
  }
  return statements;
}

/** One released marker, as the batch hands it back. */
interface ReleasedMarker {
  loan_id: number;
  reason: string;
  first_seen_at: number;
}

/**
 * Say which LONG-HELD markers a pass's own settle released (#2231 r7
 * `4035821181`).
 *
 * The finding this answers is correct on the facts and wrong on the remedy,
 * and the difference is worth stating because the remedy was "prevent this".
 *
 * THE FACTS. A held marker is deleted by the ordinary settle path as soon as
 * the rotation examines its id and gets an answer — including when the id has
 * come round again and the answer is about a DIFFERENT position from the one
 * the marker was made for. That is a release on a reused id, it is not the
 * terminal sweep, and until now it was silent.
 *
 * WHY IT IS NOT PREVENTED. Preventing it would be the mirror-image bug this
 * module opens by naming: a marker that is never cleared withholds a healthy
 * loan's reminders forever. The rotation examined the id and READ THE CHAIN
 * for it — which is evidence about what that id is right now, and the only
 * sound evidence available anywhere in this file. Every release basis that
 * was removed (#2222) was a STORED column standing in for a chain read; this
 * is the chain read itself. Blocking it would suspend reminders for a live,
 * settled position on the strength of a finding about a position that no
 * longer exists, pending a person who may never come.
 *
 * WHAT IS TRUE, AND SO IS SAID. The release erases an unresolved finding
 * about whatever bore that id before, and nothing here can tell whether there
 * WAS an earlier position — that is the identity question the platform cannot
 * answer. So a release of a marker held past the stale threshold is reported:
 * those are the ones a person has been reading about on every pass, and this
 * is the last thing that happens to them.
 *
 * A marker younger than the threshold is not reported, for the same reason it
 * was never reported while it was held.
 *
 * Reads the batch results and needs no index arithmetic: only the deletes
 * carry `RETURNING`, so a result with rows IS a release. Degrades to silence
 * rather than throwing if a driver hands back no `results` — this is a log,
 * and it must never be the reason a pass fails.
 */
export function discloseSettledReleases(
  chainId: number,
  results: unknown,
  nowSec: number,
): void {
  if (!Array.isArray(results)) return;
  const cutoff = nowSec - QUARANTINE_STALE_SECONDS;
  const stale: ReleasedMarker[] = [];
  for (const entry of results) {
    const rows = (entry as { results?: unknown } | null)?.results;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = row as Partial<ReleasedMarker>;
      if (typeof r.loan_id !== 'number' || typeof r.first_seen_at !== 'number') continue;
      if (r.first_seen_at <= cutoff) {
        stale.push({ loan_id: r.loan_id, reason: String(r.reason ?? 'unknown'), first_seen_at: r.first_seen_at });
      }
    }
  }
  if (stale.length === 0) return;
  const described = stale
    .map(
      (r) =>
        `loan ${r.loan_id} (${r.reason}, held ` +
        `${Math.floor((nowSec - r.first_seen_at) / 3600)}h)`,
    )
    .join('; ');
  console.warn(
    `[loanQuarantine] chain ${chainId}: released ${stale.length} long-held ` +
      `entr${stale.length === 1 ? 'y' : 'ies'} because this pass examined the ` +
      `id and the chain answered: ${described}. This is the soundest release ` +
      `the platform makes — a chain read about the id, not a stored column ` +
      `standing in for one — and reminders for that id resume, correctly. It ` +
      `is stated because these are the entries the stale report has been ` +
      `naming, and this is the last thing that happens to them: if the id had ` +
      `come round again, the answer is about the position bearing it NOW and ` +
      `the earlier unresolved finding is gone with it. Nothing here can tell ` +
      `whether there was an earlier position (#2222).`,
  );
}

/**
 * Release every held row whose loan is no longer live (#2213 r15
 * `4013952990`).
 *
 * THE DURABLE CLEANUP PATH, and the reason the close-out no longer needs one.
 * A row is released at close-out, in the same batch as the rest of it — except
 * when the table's existence could not be established, where naming it would
 * fail that batch. r14 answered that with a single follow-up delete, and a
 * single retry is not a retry path: if it also failed, the loan was terminal
 * by then, had left the set the reconciliation rotation selects from, and its
 * row was held and reported stale forever.
 *
 * Sweeping instead of retrying closes the whole class rather than that one
 * door. A release missed for ANY reason — an unknown probe, a failed
 * statement, a tick that died between the two — is picked up here on the next
 * pass, because the condition is a fact about the row rather than a memory of
 * what went wrong.
 *
 * Releasing is right, not merely tidy: the reminder surfaces select live rows,
 * so a held row for a terminal loan withholds nothing and only clutters the
 * stale report — burying the rows that DO need a person.
 *
 * One statement, static, no interpolation (the #1149 guard reads prepare
 * sites), and no per-row work regardless of how many rows accumulated.
 */
export async function releaseTerminalQuarantine(
  db: D1Database,
  chainId: number,
): Promise<void> {
  // WHY THIS IS `EXISTS(ended)` AND NOT `NOT EXISTS(still running)` (#2213
  // r30 `4017166980`, refuted with a caveat — see below and #2222).
  //
  // The two look equivalent and differ on exactly one case: a quarantine
  // entry whose `loans` row is absent. Releasing those would be wrong, and
  // the sibling test pins it: an ORPHAN — the chain denying a loan the
  // platform fabricated — may legitimately have no row in D1 either, and it
  // is the single most important thing this table keeps visible. Nothing
  // proves it ended, so it stays held and stays in the stale report, which is
  // where a person needs to see it. A blanket release would delete precisely
  // the rows the quarantine exists to surface, and do it silently.
  //
  // WHAT IT DELIBERATELY DOES NOT DO IS INFER A REUSED ID (#2222, #2231 r1-r4).
  //
  // Once an operator resolves an orphan the documented way — by deleting the
  // fabricated `loans` row — this entry matches nothing and lingers. That is
  // not inert: `quarantineExclusionSql` matches on `(chain_id, loan_id)`
  // alone, so a lingering entry withholds reminders from WHATEVER loan later
  // bears that id.
  //
  // Three revisions of this PR tried to detect that automatically — "release
  // when a loan with this id started after the finding" — and review found a
  // different unsound input each round, four in total:
  //
  //   - `loans.start_at` can be a LOCAL CLOCK reading, because ingest stamps
  //     `Date.now()` when a block-timestamp lookup fails.
  //   - A recorded block boundary goes STALE whenever the marker is rewritten
  //     by a path that cannot also rewrite it.
  //   - Block heights RESET on a test-network wipe, so a legitimate
  //     replacement can sit below the boundary.
  //   - `loans.start_block` itself can be REORG RESIDUE: the scan's fallback
  //     head is documented as unsafe, the cursor never revisits a
  //     reorganised-out block, and the row "stays wrong for good".
  //
  // Each fix exposed the next, which is the signal to stop. The inference is
  // being asked to establish that two positions are different using stored
  // data the platform cannot vouch for, and no column available here is sound
  // for it. So the release stays on the one thing that IS established — the
  // loan ended — and the ambiguity is REPORTED to a person instead, by
  // `reportStaleQuarantine` naming the loan a held id now points at. A
  // suppression a person can see and clear is worth more than an automatic
  // release built on evidence that has been wrong four different ways.
  // `RETURNING`, so THIS sweep discloses its own action (#2231 r6
  // `4035682797`).
  //
  // The condition above is an identity assumption — it takes the stored
  // loan row bearing this id to be the position the finding was about — and
  // the report below states that. But the report cannot be the surface that
  // discloses it, because this sweep runs FIRST and the report returns early
  // when nothing is left held. In the exact case worth disclosing — a
  // replacement loan that started and ended, erasing a finding about the
  // position before it — the sweep empties the table and the operator is told
  // nothing at all.
  //
  // Whoever exercises an unverifiable assumption is the one who reports it.
  // `RETURNING` makes that free: same single statement, same one subrequest,
  // and the ids come back instead of a count nobody can audit. Not a new bet
  // on D1 — `consumeTelegramLinkCode` has run `DELETE … RETURNING` on this
  // same database since the handshake was built.
  const released = await db
    .prepare(
      `DELETE FROM loan_reconcile_quarantine
        WHERE chain_id = ?
          AND EXISTS (
            SELECT 1 FROM loans l
             WHERE l.chain_id = loan_reconcile_quarantine.chain_id
               AND l.loan_id  = loan_reconcile_quarantine.loan_id
               AND l.status NOT IN ('active', 'fallback_pending')
          )
        RETURNING loan_id`,
    )
    .bind(chainId)
    .all<{ loan_id: number }>();
  const ids = (released.results ?? []).map((r) => r.loan_id);
  if (ids.length === 0) return;
  console.warn(
    `[loanQuarantine] chain ${chainId}: released ${ids.length} held ` +
      `entr${ids.length === 1 ? 'y' : 'ies'} whose stored loan row is ` +
      `terminal: ${ids.join(', ')}. Ordinarily this is the entry's own loan ` +
      `closing, and releasing it is correct. It is stated because the ` +
      `condition is an identity assumption the platform cannot verify: it ` +
      `takes the stored row bearing an id to be the position the finding was ` +
      `about, and a REPLACEMENT loan that started and ended under the same id ` +
      `satisfies it just as well — releasing a finding about the position ` +
      `before it. Nothing here distinguishes the two; every column that might ` +
      `has proved unsound (#2222). If one of these ids was under ` +
      `investigation, it is no longer held.`,
  );
}

/**
 * Tell the operator about rows that have been quarantined too long.
 *
 * The quarantine is silent by design in the ordinary case: a read fails, the
 * row is held back for a lap, the next lap settles it, nobody needs to know.
 * What must NOT be silent is a row that stays — that is a position the
 * platform is still publishing as open while the chain says otherwise, or
 * cannot say at all.
 *
 * (An earlier version of this sentence said "and no amount of retrying will
 * resolve it". That is the retired claim the report below is careful NOT to
 * make, and it survived HERE while being corrected twice in the release note
 * — the fourth place it lived. A row can cross the threshold without having
 * been re-examined at all, and may settle the moment it is.)
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT CLAIM (#2213 r1 `4011674991`,
 * `4011675003`):
 *
 * 1. **It does not say a source "has not recovered."** A row can cross the
 *    threshold without having been looked at again: the rotation examines a
 *    few rows a turn, so on a chain with more loans than a lap can cover in
 *    six hours, `first_seen_at` being old says nothing about whether the
 *    original failure persists. `last_seen_at` is what separates those, so
 *    both are reported and the wording is left to the evidence.
 * 2. **It does not imply that the rows it names are all of them.** A listing
 *    capped at 20 and ordered oldest-first returns the SAME twenty every
 *    time, so anything behind them would suppress reminders indefinitely
 *    while never being named. The total is counted separately and the
 *    overflow is stated, so "20 shown" can never read as "20 exist".
 */
export async function reportStaleQuarantine(
  db: D1Database,
  chainId: number,
  nowSec: number,
): Promise<void> {
  const cutoff = nowSec - QUARANTINE_STALE_SECONDS;
  // ONE QUERY, WHATEVER THE DATA SAYS (#2231 r6 `4035682768`).
  //
  // This was three statements — a count, a capped detail page, and, only when
  // the page overflowed, a roll call of the ids behind it. That last one is
  // the defect: a report whose cost DEPENDS ON THE DATA, under a ceiling
  // whose overrun does not merely drop the report but aborts the invocation
  // before the scan cursor is written. The pass that pays the extra
  // subrequest is by definition the pass with the most held rows — the one
  // least able to afford it, and the one whose failure freezes the chain.
  //
  // Selecting every held row once removes the dependency instead of
  // re-budgeting for it: the count is the row count, the described page is
  // the first `STALE_REPORT_LIMIT` of them, and the roll call is the rest.
  // Constant cost, and one subrequest LESS than the old no-overflow case.
  //
  // AND THE ROWS ARE BOUNDED, which the first version of this was not
  // (#2231 r7 `4035821168`). Folding three statements into one fixed the
  // ROUND-TRIP count and left the VOLUME growing with the size of the
  // problem — so the report would fail on exactly the chain that most needs
  // it, inside the invocation that must still write the scan cursor. Those
  // are two different costs and only one of them had been addressed.
  //
  // `COUNT(*) OVER ()` is what makes the bound honest rather than a silent
  // truncation: the total comes back EXACT in the same statement, so the
  // report can say how many it is not naming. A `LIMIT` alone would have to
  // infer "there are more" from a full page and could never say how many.
  //
  // THE LOAN THE HELD ID POINTS AT NOW, carried alongside (#2231 r4).
  //
  // A held entry withholds reminders from whatever loan currently bears its
  // id, and the platform cannot soundly establish whether that loan is the
  // one the finding was about — four different columns were tried and each
  // can be substituted, reset, gone stale or left behind by a reorg. What it
  // CAN do is say what it sees and let a person judge, which is the whole
  // reason this report exists. Without this, an operator reading the report
  // has no way to tell a finding still doing its job from one suppressing a
  // position it was never about.
  //
  // A LEFT JOIN, so an entry whose loan row is absent — the orphan, the case
  // that lingers — is still listed, with nothing claimed about it.
  const rows = await db
    .prepare(
      `SELECT q.loan_id, q.reason, q.first_seen_at, q.last_seen_at,
              l.status AS loan_status, l.start_block AS loan_start_block,
              COUNT(*) OVER () AS held_total
         FROM loan_reconcile_quarantine q
         LEFT JOIN loans l
           ON l.chain_id = q.chain_id AND l.loan_id = q.loan_id
        WHERE q.chain_id = ? AND q.first_seen_at <= ?
        ORDER BY q.first_seen_at ASC
        LIMIT ?`,
    )
    .bind(chainId, cutoff, STALE_ROLL_CALL_LIMIT)
    .all<{
      loan_id: number;
      reason: string;
      first_seen_at: number;
      last_seen_at: number;
      loan_status: string | null;
      loan_start_block: number | null;
      held_total: number;
    }>();
  const held = rows.results ?? [];
  if (held.length === 0) return;
  // The EXACT total, from the window function — not `held.length`, which is
  // capped, and not a separate count, which would put the cost back.
  const n = held[0].held_total;
  const shown = held.slice(0, STALE_REPORT_LIMIT);
  const described = shown
    .map((r) => {
      const heldHours = Math.floor((nowSec - r.first_seen_at) / 3600);
      // WHAT THIS COLUMN ACTUALLY IS: the last time an unsettled sighting was
      // successfully WRITTEN — not the last time a pass looked (#2213 r23
      // `4015375760`).
      //
      // The two come apart exactly when the upsert batch fails, which is a
      // case this PR made reachable and then reported on: the pass examined
      // the row minutes ago, only recording it failed, so the column keeps an
      // older value. Calling that "last examined" then tells an operator the
      // row is merely waiting for the rotation — the one reading that sends
      // them away from a row whose bookkeeping is broken.
      const sinceRecorded = Math.floor((nowSec - r.last_seen_at) / 3600);
      // STATED, NEVER INFERRED. "no loan row" is the orphan an operator may
      // already have resolved by deleting it; a row that IS there is what the
      // id currently points at, and naming its state and start block is what
      // lets a person decide whether this entry is still about that position.
      // The platform draws no conclusion from either — see the release above.
      // STORED, NOT VERIFIED, and the wording has to carry that (#2231 r5
      // `4035554505`). A `loans` row can be residue from a scan against the
      // documented-unsafe fallback head — the very unsoundness that removed
      // the automatic release — so presenting it as what the id "now holds"
      // would invite an operator to clear a marker on the same evidence the
      // platform just refused to act on. It is what the platform has written
      // down, and whether it is canonically true is exactly what is unknown.
      const points =
        r.loan_status === null
          ? 'no stored loan row for this id'
          : `stored row for this id: ${r.loan_status}, from block ` +
            `${r.loan_start_block ?? '?'} (UNVERIFIED — may be stale or ` +
            `reorg residue; canonical identity unknown)`;
      return (
        `loan ${r.loan_id} (${r.reason}, held ${heldHours}h, ` +
        `last recorded unsettled ${sinceRecorded}h ago at ${r.last_seen_at}; ` +
        `${points})`
      );
    })
    .join('; ');
  // EVERY HELD ID IS NAMED, not just the first page (#2231 r5 `4035554496`).
  // This report is now the ONLY surface that discloses a suppression — the
  // automatic release was removed because its evidence was unsound — so a
  // page that stopped at twenty left every id past it suppressing reminders
  // with nothing ever saying which. Ids are short; the detail is capped, the
  // roll call is not.
  //
  // WHAT IT DOES NOT SAY IS "described next tick" (#2231 r6 `4035682787`).
  // It said exactly that for one round, and it was a promise nothing keeps:
  // the described page is the OLDEST entries and there is no rotation, so the
  // same twenty are described every tick and these ids stay identifier-only
  // until an entry ahead of them is resolved. An operator waiting for detail
  // that will never arrive is worse off than one told to go and get it — so
  // the report says what actually makes them described, which is also the
  // thing the operator should be doing anyway.
  let overflow = '';
  if (n > shown.length) {
    const named = held.slice(STALE_REPORT_LIMIT);
    const ids = named.map((r) => r.loan_id).join(', ');
    // PAST THE ROLL CALL'S OWN BOUND, SAY SO AND HAND OVER THE QUERY. The
    // count is exact even here, so this is a stated limit rather than a page
    // that quietly ended (#2231 r7 `4035821168`).
    const unnamed = n - held.length;
    const beyond =
      unnamed > 0
        ? ` — and ${unnamed} further held entr${unnamed === 1 ? 'y' : 'ies'} ` +
          `NOT named here, because this report is bounded at ` +
          `${STALE_ROLL_CALL_LIMIT} ids and will not grow with the fault. ` +
          `List them with: SELECT loan_id FROM loan_reconcile_quarantine ` +
          `WHERE chain_id = ${chainId} AND first_seen_at <= ${cutoff} ` +
          `ORDER BY first_seen_at ASC`
        : '';
    overflow =
      ` (+${n - shown.length} more, each also holding reminders back; ` +
      `${named.length} of them named here but NOT described: ${ids} — the ` +
      `detail above is the oldest ${STALE_REPORT_LIMIT} and does not rotate, ` +
      `so these stay identifier-only until an entry ahead of them is ` +
      `resolved${beyond})`;
  }
  console.warn(
    `[loanQuarantine] chain ${chainId}: ${n} loan(s) held back from reminders ` +
      `for over ${QUARANTINE_STALE_SECONDS / 3600}h — ${described}${overflow}. ` +
      `A row recorded recently is still failing; one recorded long ago is ` +
      `either waiting for the rotation to reach it or being examined and not ` +
      `written — the quarantine WRITE failure above says which, and this ` +
      `column cannot. An orphan needs a person either way — and because a held ` +
      `entry withholds reminders from whatever loan now bears its id, an entry ` +
      `whose id is held by a loan the finding was plainly not about is a ` +
      `position going without reminders. The platform does not release those ` +
      `automatically: every way it could establish "this is a different loan" ` +
      `from stored data has proved unsound (#2222). Clearing one is a ` +
      `deliberate act, and MUST name the exact entry that was read — a pass ` +
      `between your reading this and running it can re-observe the id as ` +
      `unsettled, and an unconditional delete would then drop that fresh ` +
      `finding instead: DELETE FROM loan_reconcile_quarantine WHERE ` +
      `chain_id = <chain> AND loan_id = <id> AND last_seen_at = <the value ` +
      `shown above for that row>. If it deletes nothing, the entry changed ` +
      `under you and wants re-reading. Note also that an entry IS released ` +
      `automatically when a stored loan with its id is terminal, and that too ` +
      `is an identity assumption the platform cannot verify — a replacement ` +
      `that started and ended would release a finding about the position ` +
      `before it (#2222).`,
  );
}


/* ────────────────────────────────────────────────────────────────────────────
 * The table's NAME, its availability probe, and the exclusion fragment.
 *
 * Moved here from `@vaipakam/lib/reminderEligibility` in #2213 r22
 * (`4015173433`). They were in the shared package while both reminder lanes
 * consulted the quarantine; this PR moved the periodic lane to asking the
 * chain directly, which left an indexer-owned D1 table name and SQL fragment
 * sitting in a package module whose only other contents were chain-state
 * arithmetic the agent reads. Every consumer of these three is in this Worker.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The table the memory lives in. Named once so a rename cannot half-land. */
export const QUARANTINE_TABLE = 'loan_reconcile_quarantine';

/**
 * A `WHERE`-clause fragment excluding quarantined loans.
 *
 * Correlates on the OUTER query's own columns, so the caller passes the alias
 * its `loans` table is selected under. No binds, so it composes with any
 * parameter list.
 *
 * Belongs in SQL rather than a post-select filter: every caller applies a
 * `LIMIT`, and a quarantined row filtered afterwards has already occupied a
 * slot that an eligible row behind it needed.
 */
export function quarantineExclusionSql(loansAlias = 'loans'): string {
  return `NOT EXISTS (
            SELECT 1 FROM ${QUARANTINE_TABLE} q
             WHERE q.chain_id = ${loansAlias}.chain_id
               AND q.loan_id = ${loansAlias}.loan_id
          )`;
}

/** The single D1 method the probe needs, so this stays runtime-agnostic. */
export interface QuarantineProbeDb {
  prepare(query: string): { first<T>(): Promise<T | null> };
}

/**
 * Whether the quarantine memory is there — or whether the question failed.
 *
 * THREE ANSWERS, not two (#2213 r13 `4013570995`). `'absent'` and `'unknown'`
 * were one value until this round, and collapsing them is the same defect the
 * agent's cursor read had: a transient failure looked like a definite "the
 * table is not there", so the sweep dropped the exclusion, announced that the
 * migration was missing, and minted unretractable reminders for exactly the
 * loans being held back.
 *
 * The two callers then take OPPOSITE safe directions from `'unknown'`, which
 * is why this returns the fact rather than a boolean:
 *
 * - The reminder sweep DEFERS. It is about to send something it cannot
 *   retract, so an unanswered question is not permission.
 * - A close-out batch OMITS the release, exactly as it does for `'absent'`.
 *   Naming a table that might not exist would fail the whole batch, and that
 *   batch advances the chain cursor — so the cautious direction there is to
 *   write less, not to stop.
 */
export type QuarantineAvailability = 'present' | 'absent' | 'unknown';

/**
 * Build a "has migration 0049 landed on this database?" probe.
 *
 * A FACTORY because the answer is cached per isolate and each Worker must
 * hold its own — a module-level cache shared by import would be fine today
 * and wrong the moment two databases are involved.
 *
 * **Why a probe and not a caught error.** The canonical deploy scripts
 * publish a Worker BEFORE applying its D1 migrations (#2214), so there is a
 * guaranteed window where this code runs against a database without the
 * table. "Does this table exist" has a definite answer; "was that failure a
 * missing table" is a guess about an error message, and a failure classifier
 * narrowed round after round cannot be sharpened into correctness.
 *
 * **A PRESENT is cached for the life of the isolate.** A table does not
 * un-exist, so the steady-state cost is one read per isolate.
 *
 * **An ABSENT or an UNKNOWN is cached for the life of one PASS** (#2213 r28
 * `4016565774`). Neither used to be cached at all, on the reasoning that
 * caching an absence would leave this isolate ignoring the quarantine after
 * the migration landed, until it happened to recycle. That reasoning is right
 * about an isolate-lifetime cache and it bought an unbounded one instead:
 * during the guaranteed deploy-before-migration window (#2214) EVERY terminal
 * event re-probed, and a normal close-out can reach the helper twice — once in
 * its own handler and again through the deferred `LoanStatusChanged` cleanup.
 * A backfill with enough close-outs then spends the Worker's subrequest
 * allowance on identical `sqlite_master` reads and aborts before advancing the
 * cursor, which is the rollout freeze this guard exists to prevent.
 *
 * A pass is the right scope because it bounds both errors: at most one probe
 * per pass however many close-outs it carries, and at most one pass of
 * ignoring a migration that has just landed.
 *
 * `beginPass()` both OPENS that scope and clears it, and the opening half is
 * load-bearing: a caller that never calls it never caches a negative at all,
 * and so keeps the pre-r28 behaviour exactly. Written the other way round —
 * caching by default, `beginPass()` merely clearing — a lane that forgot the
 * call would latch `absent` for the life of its isolate and go on ignoring
 * the quarantine long after the migration landed, which is the failure the
 * no-caching rule was protecting against in the first place. Forgetting is
 * now a missed optimisation rather than a stale answer.
 */
export interface QuarantineAvailabilityProbe {
  (db: QuarantineProbeDb): Promise<QuarantineAvailability>;
  /** Forget a cached `absent`/`unknown`; a cached `present` survives. */
  beginPass(): void;
}

export function createQuarantineAvailability(): QuarantineAvailabilityProbe {
  let seen = false;
  let passOpen = false;
  let thisPass: QuarantineAvailability | null = null;
  const probe = async (db: QuarantineProbeDb): Promise<QuarantineAvailability> => {
    if (seen) return 'present';
    if (thisPass !== null) return thisPass;
    try {
      const row = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${QUARANTINE_TABLE}'`,
        )
        .first<{ name: string }>();
      if (row) {
        seen = true;
        return 'present';
      }
      if (passOpen) thisPass = 'absent';
      return 'absent';
    } catch {
      // STILL DOES NOT THROW. Its callers are a reminder sweep and a close-out
      // batch, and making either fail because the QUESTION failed would turn a
      // database hiccup into a stalled chain cursor or a dropped sweep. What
      // changed in r13 is that the answer is no longer a confident "absent":
      // the caller is told the question failed and decides for itself.
      if (passOpen) thisPass = 'unknown';
      return 'unknown';
    }
  };
  probe.beginPass = () => {
    passOpen = true;
    thisPass = null;
  };
  return probe as QuarantineAvailabilityProbe;
}
