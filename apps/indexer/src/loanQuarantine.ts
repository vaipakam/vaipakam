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
 * more are held — an EXACT count, from its own statement rather than
 * inferred from a truncated page — and gives the query that lists them.
 * "More than I will name here, and here is how to see them" is an honest
 * bound; a page that stops without saying so is the silent truncation this
 * whole module exists to avoid.
 *
 * The number is a judgement about one log line, not a protocol constant:
 * 200 ids is roughly 1.5 KB, which a log surface carries intact, and a chain
 * holding more than 200 has a systemic fault where the exact roster matters
 * less than the magnitude does.
 */
export const STALE_ROLL_CALL_LIMIT = 200;

/**
 * How many markers the terminal sweep clears in ONE pass.
 *
 * NOT `STALE_ROLL_CALL_LIMIT`, and the difference is a hard limit rather than
 * a judgement (#2231 r16 `4037430369`). The sweep's delete names its ids, and
 * **D1 caps a statement at 100 bound parameters** — a fact this repository
 * already paid for once: `loadLoanParties` carries the same note, from
 * Codex #1292, and settled on 90 ids plus the chain bind.
 *
 * At 200 the statement would throw. Worse, it would throw the SAME way on
 * every pass: the roster is `ORDER BY loan_id`, so the identical oversized
 * prefix comes back each time and none of those markers is ever released —
 * a sweep that appears to run and silently achieves nothing, which is the
 * failure mode the quarantine exists to avoid rather than create.
 *
 * 90 for the same reason the existing site chose it: it leaves room for the
 * chain bind and for a statement to grow a condition without anyone having to
 * recompute the ceiling.
 */
export const QUARANTINE_SWEEP_BATCH = 90;

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
/**
 * A fresh token for one observation, for the report's guarded clear.
 *
 * `last_seen_at` used to serve, and cannot: it is whole seconds, so two
 * observations inside one second leave it identical and the operator's
 * compare-and-delete removes a finding it never saw (#2231 r11
 * `4036569620`). See migration 0053 for why a counter is not the answer
 * either, and why eight hex characters are enough.
 */
function observationToken(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function quarantineStatements(
  db: D1Database,
  chainId: number,
  report: ReconcileReport,
  nowSec: number,
  /**
   * Whether 0053's guard column is known to be there (#2231 r12
   * `4036719800`).
   *
   * DEFAULTS TO THE LEGACY SHAPE, and that direction is the whole point: an
   * insert that omits `obs` succeeds on BOTH schemas — the column takes its
   * default — while one that names it fails the entire batch on a database
   * that has not been migrated yet. The canonical runbook publishes the
   * Worker before applying migrations, so that database exists for a few
   * minutes on every deploy, and a pass that cannot record an unsettled row
   * leaves the next pass free to remind on it. Guessing wrong in the other
   * direction costs those rows a guard token; guessing wrong this way costs
   * the marker itself.
   */
  withGuard = false,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const { loanId, reason } of unsettledRows(report)) {
    // `first_seen_at` is deliberately NOT in the update list. It is the
    // operator's whole signal — minutes means a transient read, days means a
    // ghost nobody resolved — and an upsert that refreshed it on every
    // re-observation would erase exactly that.
    statements.push(
      withGuard
        ? db
            .prepare(
              `INSERT INTO loan_reconcile_quarantine
                 (chain_id, loan_id, reason, first_seen_at, last_seen_at, obs)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(chain_id, loan_id) DO UPDATE SET
                 reason = excluded.reason,
                 last_seen_at = excluded.last_seen_at,
                 obs = excluded.obs`,
            )
            .bind(chainId, loanId, reason, nowSec, nowSec, observationToken())
        : db
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
    statements.push(quarantineReleaseStatement(db, chainId, loanId));
  }
  return statements;
}

/**
 * THE ONLY WAY TO RELEASE ONE MARKER. Every per-loan delete goes through here.
 *
 * This exists because of the shape rounds 6–9 of #2231 kept producing. The
 * quarantine had THREE places that delete a marker for one loan — this
 * module's settle path, the close-out side-table list, and (in bulk) the
 * terminal sweep — and disclosure was added to them one at a time, as each
 * was noticed. Round 7 found the sweep undisclosed. Round 7 again found the
 * settle path undisclosed. Round 9 found the close-out list undisclosed
 * (`4036242408`), by which point the pattern was not a missing case but a
 * missing RULE: nothing made a new delete site inherit the disclosure, so
 * every one of them had to be remembered, and one never was.
 *
 * A caller cannot now write the DELETE without the `RETURNING` that makes the
 * release visible, because the only way to obtain the statement is to ask for
 * it here.
 *
 * WHAT THAT DOES AND DOES NOT BUY, stated because the first version of this
 * paragraph said "disclosed by construction" and that was more than the
 * mechanism delivers (#2231 r10 `4036448014`). This helper returns a
 * statement; it does not execute one. A caller can still put it in a batch
 * and throw the results away, and the source assertion in the tests would
 * pass, because the SQL does contain `RETURNING`. Claiming otherwise is the
 * same overreach that made the report's spec sentence outrun the report three
 * rounds running, and it would be worse here: a guarantee a reader trusts is
 * more dangerous than one they check.
 *
 * What IS enforced, precisely:
 *
 *   - the SQL carries `RETURNING`, so the data disclosure needs is always
 *     available to whoever runs the batch — no site has to remember to ask
 *     for it;
 *   - `ReconcileContext.discloseSideTableBatch` is REQUIRED, so a new
 *     reconcile context does not compile without deciding what it discloses;
 *   - a source assertion refuses a hand-written single-loan delete anywhere
 *     in these modules, which is how the three existing sites drifted apart.
 *
 * What remains a convention is the last step: the caller passing its batch
 * results to `discloseQuarantineReleases`. Making that unavoidable would mean
 * this module owning execution, and it cannot — these statements exist to be
 * spliced into batches that are atomic with things this module knows nothing
 * about, which is the whole reason they are statements.
 *
 * `RETURNING loan_id, reason, first_seen_at` — the last of those is what
 * `discloseQuarantineReleases` uses to separate the cases. The overwhelming
 * majority of these deletes are no-ops against a marker that was never there,
 * and most of the rest are the healthy case the module is built around: a
 * read failed, the row was held for a lap, the next pass settled it.
 * Announcing those would bury the ones that matter.
 */
export function quarantineReleaseStatement(
  db: D1Database,
  chainId: number,
  loanId: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND loan_id = ?
        RETURNING loan_id, reason, first_seen_at`,
    )
    .bind(chainId, loanId);
}

/** One released marker, as the batch hands it back. */
interface ReleasedMarker {
  loan_id: number;
  reason: string;
  first_seen_at: number;
}

/**
 * Say which LONG-HELD markers a batch released (#2231 r7 `4035821181`,
 * r9 `4036242408`).
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
 * carry `RETURNING`, so a result with rows IS a release.
 *
 * WHAT IS AND IS NOT SUBSTANTIATED ABOUT THAT, so a later reader need not
 * redo the check. Cloudflare documents `batch()` as returning "an array of
 * `D1Result` objects", each carrying a `results` array — that shape is
 * certain. That D1 surfaces `RETURNING` rows through a statement result is
 * also certain: `consumeTelegramLinkCode` reads a `DELETE … RETURNING` row in
 * production. That the two compose — RETURNING rows landing in `results` on
 * the BATCH path specifically — is an INFERENCE across those two facts, and
 * D1's documentation does not mention `RETURNING` at all.
 *
 * It is kept on that inference where the stale report's window function was
 * reverted off a comparable one, and the difference is the failure mode, not
 * the confidence. A rejected window function makes the report THROW, and the
 * report is the only surface disclosing a suppression at all — the module's
 * own defect, reintroduced by its fix. An empty `results` here makes this
 * function return silently, which is the behaviour before this PR: an
 * improvement that does not arrive, not a regression. Guarded accordingly —
 * this is a log, and it must never be the reason a pass fails.
 */
/**
 * WHY A BASIS, and why one wording will not do (#2231 r10 `4036448029`).
 *
 * Wiring this discloser to every release path made its message wrong for one
 * of them. "This pass examined the id and the chain answered" is true of the
 * settle path and is the soundest evidence in the module. It is NOT true of
 * the close-out: there, a terminal EVENT for the id arrived, which establishes
 * that the position CURRENTLY bearing the id ended — not that the marker being
 * released was ever about that position. Reusing the settle wording there
 * presented the reused-id identity assumption as settled, on the very path
 * this PR added disclosure to because it was silent about it.
 *
 * Sharing a mechanism does not license sharing a claim.
 */
export type ReleaseBasis =
  /** A pass read the chain for this id and got an answer. */
  | 'examined'
  /**
   * A pass read the chain at a safe head, found the loan already terminal,
   * and repaired the stored row — with NO terminal event having arrived
   * (#2231 r11 `4036569613`). Distinct from `closed-out`, which this path
   * borrowed for one round: saying "a terminal event arrived" on a path
   * whose whole purpose is that the event was MISSED misdescribes the very
   * evidence the operator is being asked to weigh.
   */
  | 'reconciled'
  /**
   * A pass read the chain, found the loan terminal, and ANOTHER writer had
   * already recorded it — so nothing here can say whether a terminal event
   * arrived or not (#2231 r14 `4037027847`). The weakest of the four, and
   * the right one when a compare-and-set loses: the race the CAS exists for
   * is precisely the event handler getting there first, so `reconciled`
   * would assert the absence of the likeliest explanation.
   */
  | 'chain-read'
  /** A terminal event for this id arrived and the close-out cleared it. */
  | 'closed-out';

export function discloseQuarantineReleases(
  chainId: number,
  results: unknown,
  nowSec: number,
  basis: ReleaseBasis = 'examined',
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
  const why =
    basis === 'examined'
      ? `because this pass examined the id and the chain answered: ` +
        `${described}. That is the soundest release the platform makes — a ` +
        `chain read about the id, not a stored column standing in for one — ` +
        `and reminders for that id resume, correctly.`
      : basis === 'chain-read'
      ? `because a pass read the chain and found the loan terminal, though ` +
        `another writer had already recorded it: ${described}. Which writer, ` +
        `and whether a terminal event arrived at all, is not something this ` +
        `pass can say — it lost the race it runs to detect. The evidence is ` +
        `the chain read alone, and it establishes the state of the position ` +
        `CURRENTLY bearing the id, not that the entry being released was ` +
        `about that position.`
      : basis === 'reconciled'
      ? `because a pass read the chain at a safe head and found the loan ` +
        `already terminal, with no terminal event having arrived: ` +
        `${described}. The evidence is a chain read, not an event — the ` +
        `event is precisely what was missed — and it establishes the state ` +
        `of the position CURRENTLY bearing the id, not that the entry being ` +
        `released was about that position.`
      : `because a terminal event for the id arrived and the close-out ` +
        `cleared it: ${described}. Note what that event establishes and what ` +
        `it does not: the position CURRENTLY bearing the id ended. It does ` +
        `NOT establish that the entry being released was ever about that ` +
        `position, so this release carries the same identity assumption the ` +
        `platform cannot verify.`;
  console.warn(
    `[loanQuarantine] chain ${chainId}: released ${stale.length} long-held ` +
      `entr${stale.length === 1 ? 'y' : 'ies'} ${why} It ` +
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
  // WHAT IS AND IS NOT BOUNDED HERE, said plainly (#2231 r14 `4037027829`).
  //
  // Rows RETURNED are capped, and the delete below is capped with them. The
  // roster's own SCAN is not: with nothing terminal to find, SQLite walks the
  // chain's held rows — an index walk with one primary-key probe into `loans`
  // each — before concluding there is nothing. No index can bound that,
  // because the condition spans two tables and the answer is not stored.
  //
  // It is left that way deliberately, and the alternatives were weighed. A
  // durably cursored sweep would bound the scan and make a release wait
  // several passes for a table whose size is bounded by the number of
  // UNSETTLED loans — which in a healthy system is a handful, and when it is
  // not, the held rows themselves are the fault being reported. Trading
  // prompt releases for a bound on work that only matters in the state the
  // sweep exists to clear is the wrong way round. What is not acceptable is
  // claiming a bound that is not there, which is why this note exists rather
  // than a sentence saying the sweep is bounded.
  //
  // BOUNDED AT THE DATABASE, not in the string (#2231 r8 `4036084552`).
  //
  // The previous revision took `RETURNING loan_id` on the DELETE and sliced
  // the array afterwards. That bounds the LOG and nothing else: D1 is still
  // asked to return every deleted id and the Worker still materialises them
  // all, so response volume and memory stay linear in the number of terminal
  // markers — on a sweep the comment itself said could be thousands. It is
  // the same half-fix this PR has now made twice: the visible half of a cost
  // addressed, the one that actually bites left alone.
  //
  // So the roster is read FIRST, with a `LIMIT` D1 honours, and the release
  // is a plain DELETE whose `meta.changes` gives the exact number removed.
  // Two statements at worst, one when nothing is terminal — and the roster
  // read is what decides, since its condition is character-for-character the
  // DELETE's. A row that turns terminal between them is not lost; this sweep
  // is the durable cleanup path and the next pass takes it.
  const roster = await db
    .prepare(
      `SELECT loan_id FROM loan_reconcile_quarantine
        WHERE chain_id = ?
          AND EXISTS (
            SELECT 1 FROM loans l
             WHERE l.chain_id = loan_reconcile_quarantine.chain_id
               AND l.loan_id  = loan_reconcile_quarantine.loan_id
               AND l.status NOT IN ('active', 'fallback_pending')
          )
        ORDER BY loan_id
        LIMIT ?`,
    )
    .bind(chainId, QUARANTINE_SWEEP_BATCH)
    .all<{ loan_id: number }>();
  const named = (roster.results ?? []).map((r) => r.loan_id);
  if (named.length === 0) return;
  // THE ID LIST BOUNDS IT; THE PREDICATE KEEPS IT TRUE. Both, not either
  // (#2231 r14 `4037027829`, r16 `4037430380`).
  //
  // Bare `EXISTS` was a second unbounded walk of the chain's held rows behind
  // a bounded read — the bound applied to what came back, never to the work.
  // Naming the ids fixed that and introduced the opposite defect: an id-only
  // delete no longer checks the fact that licensed the release. Between the
  // roster read and here, the terminal row can be deleted and a REPLACEMENT
  // active loan inserted under the same id — which is not a hypothetical
  // race, it is the reused-id remediation this whole change is about — and
  // the sweep would then release a hold on a live loan and resume its
  // reminders.
  //
  // Carrying both makes the scan bounded by the id list and the outcome
  // conditional on the evidence still holding. A row that changed under the
  // sweep simply stays held, and the next pass looks again.
  //
  // A `?` per id rather than an interpolated list: the #1149 guard reads
  // static prepare sites, and an interpolated `IN (...)` leaves its reach.
  const placeholders = named.map(() => '?').join(', ');
  const outcome = await db
    .prepare(
      `DELETE FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND loan_id IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM loans l
             WHERE l.chain_id = loan_reconcile_quarantine.chain_id
               AND l.loan_id  = loan_reconcile_quarantine.loan_id
               AND l.status NOT IN ('active', 'fallback_pending')
          )`,
    )
    .bind(chainId, ...named)
    .run();
  // NO INVENTED COUNT when the driver reports none, AND NO LOWER BOUND EITHER
  // (#2231 r16 `4037430426`).
  //
  // This read `?? named.length` and called that a sound lower bound. It is
  // not: the roster and the delete are separate statements, so an operator's
  // own clear or another invocation can remove any or all of those rows in
  // between — and now that the delete re-checks the terminal predicate, a row
  // that turned active again is skipped as well. "At least 90 released" can
  // therefore be said of a statement that released nothing.
  //
  // What the roster IS is the set that qualified a moment earlier. That is
  // what it is called now.
  const removed = outcome.meta?.changes ?? null;
  if (removed === 0) return;
  // WHAT THE ROSTER IS, said plainly rather than implied. It was read
  // immediately before the delete, so it is what the sweep was ABOUT to
  // release; `removed` is what it DID release. They can differ if another
  // writer moved a row in between — unlikely, and not worth a transaction for
  // a log line, but not worth misrepresenting either.
  const unnamed = removed === null ? 0 : removed - named.length;
  const listed =
    unnamed > 0
      ? `${named.join(', ')} (and ${unnamed} more, not named here — this ` +
        `roster is bounded at ${STALE_ROLL_CALL_LIMIT} ids)`
      : named.join(', ');
  const howMany =
    removed === null
      ? `an unreported number of held entries (the driver returned no row ` +
        `count; ${named.length} qualified a moment earlier, which is not a ` +
        `count of what went — any of them may have been cleared or turned ` +
        `active in between)`
      : `${removed} held entr${removed === 1 ? 'y' : 'ies'}`;
  console.warn(
    `[loanQuarantine] chain ${chainId}: released ${howMany} whose stored ` +
      `loan row is terminal; read just before the delete as: ${listed}. ` +
      `Ordinarily this is the entry's own loan ` +
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
/**
 * THE WHOLE COMMAND, finished, for one entry — not a fragment to assemble
 * (#2231 r14 `4037027842`, and the four rounds before it).
 *
 * This has been a value, then a quoted value, then a predicate in brackets,
 * and every round found another way the operator's assembly came out wrong:
 * a word that matched nothing, quotes that doubled, and finally brackets that
 * SQLite reads as an identifier so the advertised command failed with "no
 * such column". Each fix was to the fragment; the defect was the assembly.
 *
 * So nothing is left to assemble. The report prints a statement that runs as
 * printed, and `test/loanQuarantine.test.ts` EXECUTES the statements it finds
 * in the emitted message against the real migrated schema. That test is the
 * actual fix here — a string this module merely describes can be wrong in
 * ways only a reader notices, and four rounds of readers did.
 *
 * Why both `obs` and `last_seen_at` are in it (#2231 r12 `4036719806`,
 * r13 `4036869950`).
 *
 * BOTH the token and the sighting time, because neither alone covers every
 * way a row can be re-observed. The token changes on every GUARDED write and
 * is the answer to two sightings inside one second. But the legacy write
 * shape — the one that runs while migration 0053 has not been observed —
 * cannot name the column, so its `ON CONFLICT` leaves an existing token
 * untouched while recording a fresh sighting. A guard of the token alone
 * would then still match, and the operator's clear would remove a finding
 * they never saw: round 11's defect, reintroduced by round 12's fallback.
 * `last_seen_at` moves on that write, so the pair does not match.
 *
 * WHAT REMAINS, stated rather than papered over: a LEGACY write landing in
 * the same second as the sighting whose guard the operator holds changes
 * neither half. That needs the probe to have failed or to be mid-window AND
 * two sightings inside one second, on a table that already has the column.
 * It is not closed, and it is not claimed to be — the alternative was to
 * force `last_seen_at` forward on collision, which corrupts the one column
 * telling an operator how long ago a row was actually recorded.
 *
 * It read `obs || 'none'`, which turns the empty guard on a pre-0053 row into
 * the word `none` — so the prescribed clear became `obs = 'none'`, matching
 * nothing. Not a cosmetic slip: an orphan may never be re-observed, so it
 * would never acquire a token, and the entry would be permanently unclearable
 * by the safe route while going on suppressing reminders. The one class of row
 * this report exists for would be the one it could not help with.
 *
 * Quoting HERE rather than in the instruction's template is what makes the
 * empty case work: a template that wrapped the printed value in quotes would
 * turn an empty guard into four quote characters and match nothing again.
 */
function clearCommand(chainId: number, loanId: number, obs: string, lastSeenAt: number): string {
  return (
    `DELETE FROM loan_reconcile_quarantine WHERE chain_id = ${chainId} ` +
    `AND loan_id = ${loanId} AND obs = '` +
    obs.replace(/'/g, `''`) +
    `' AND last_seen_at = ${lastSeenAt} RETURNING loan_id;`
  );
}
/**
 * How to clear ONE entry, when the guard column is there to guard with.
 *
 * Hoisted out of the warning so the unavailable case has something to be
 * an alternative TO, rather than the message growing a second inline copy
 * that drifts from this one (#2231 r13 `4036869959`).
 */
const CLEAR_INSTRUCTION =
  `Clearing one is a deliberate act, and MUST name the exact entry that ` +
  `was read — a pass between your reading this and running it can ` +
  `re-observe the id as unsettled, and an unconditional delete would then ` +
  `drop that fresh finding instead. Each described entry above carries the ` +
  `command for it, finished: run it as printed, changing nothing. It quotes ` +
  `a token AND the time of the sighting, and the two cover different ` +
  `things: an ordinary write rotates the token, which is what separates two ` +
  `sightings inside one second; a write made while the guard column was not ` +
  `yet in place CANNOT rotate it, and those are caught by the time moving ` +
  `instead. It ends in RETURNING loan_id so you can see which happened — a ` +
  `row back means the entry you read is the entry that went, and NO row ` +
  `back means it changed under you and wants re-reading. Without that the ` +
  `two outcomes look identical through a command line.`;
export async function reportStaleQuarantine(
  db: D1Database,
  chainId: number,
  nowSec: number,
  /** As for the writes: selecting `q.obs` fails outright on a database where
   *  0053 has not landed, so the report asks for it only once the probe has
   *  seen it (#2231 r12 `4036719800`). A report that throws during a deploy
   *  window is a report that hides every suppression precisely when the
   *  deploy is the thing most likely to have caused one. */
  withGuard = false,
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
  // TWO STATEMENTS, ALWAYS TWO. Constant is the property that matters, not
  // one (#2231 r6 `4035682768`, r7 `4035821168`). What was wrong was a cost
  // that VARIED with the data — the pass paying the extra was the pass
  // holding the most rows, the one least able to afford it and the one whose
  // failure aborts before the scan cursor is written. Two every time is as
  // immune to that as one every time.
  //
  // It was briefly one, via `COUNT(*) OVER ()` in the page's own statement,
  // and that is reverted deliberately rather than for taste. Cloudflare
  // documents D1 as "compatible with MOST SQLite's SQL convention" and names
  // no version; nothing in this repository has ever run a window function
  // against it, so there is no precedent to lean on the way
  // `consumeTelegramLinkCode` gives `RETURNING` one. The feature is old and
  // almost certainly present — but "almost certainly" is the wrong standard
  // for THIS statement: the stale report is the ONLY surface that discloses
  // a suppression, so a statement D1 rejected would not degrade the report,
  // it would make every held entry invisible on every pass. That is the
  // defect this whole module exists to prevent, reintroduced by the fix for
  // it. One saved subrequest does not buy that risk, and the count returns
  // to what `main` already budgets.
  const countStatement = db
    .prepare(
      `SELECT COUNT(*) AS n FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND first_seen_at <= ?`,
    )
    .bind(chainId, cutoff);
  // AND THE ROWS ARE BOUNDED, which the first version of this was not
  // (#2231 r7 `4035821168`). Folding the statements together fixed the
  // ROUND-TRIP count and left the VOLUME growing with the size of the
  // problem. Those are two different costs and only one had been addressed.
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
  // TWO STATIC STATEMENTS, not one built with an interpolated column list.
  // The #1149 guard reads static `prepare` sites and schema-checks them; a
  // `${...}` in the select list moves this one out of its reach, which the
  // guard's own pinned skip-count caught. Duplicating ten lines is the price
  // of keeping both shapes checked, and the shape that runs in the deploy
  // window is exactly the one nobody exercises locally.
  const pageStatement = withGuard
    ? db
        .prepare(
          `SELECT q.loan_id, q.reason, q.first_seen_at, q.last_seen_at, q.obs,
                  l.status AS loan_status, l.start_block AS loan_start_block
             FROM loan_reconcile_quarantine q
             LEFT JOIN loans l
               ON l.chain_id = q.chain_id AND l.loan_id = q.loan_id
            WHERE q.chain_id = ? AND q.first_seen_at <= ?
            ORDER BY q.first_seen_at ASC
            LIMIT ?`,
        )
        .bind(chainId, cutoff, STALE_ROLL_CALL_LIMIT)
    : db
        .prepare(
          `SELECT q.loan_id, q.reason, q.first_seen_at, q.last_seen_at,
                  '' AS obs,
                  l.status AS loan_status, l.start_block AS loan_start_block
             FROM loan_reconcile_quarantine q
             LEFT JOIN loans l
               ON l.chain_id = q.chain_id AND l.loan_id = q.loan_id
            WHERE q.chain_id = ? AND q.first_seen_at <= ?
            ORDER BY q.first_seen_at ASC
            LIMIT ?`,
        )
        .bind(chainId, cutoff, STALE_ROLL_CALL_LIMIT);
  // ONE SNAPSHOT, because the count and the page describe the same moment or
  // they describe nothing (#2231 r11 `4036569628`).
  //
  // Run separately, the exact total could be taken before an operator's
  // guarded clear and the page after it — leaving the report claiming
  // overflow entries that no longer exist, or describing more rows than its
  // own stated total. "Exact" was the word used, and two reads cannot be.
  //
  // `batch()` is D1's transaction, so both statements see one state. It is
  // also ONE subrequest rather than two, so the report's cost returns to what
  // it was before r7 split it — the snapshot is free, and then some.
  const [countResult, pageResult] = await db.batch<Record<string, unknown>>([
    countStatement,
    pageStatement,
  ]);
  const n = Number((countResult?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  if (n === 0) return;
  const held = (pageResult?.results ?? []) as unknown as Array<{
    loan_id: number;
    reason: string;
    first_seen_at: number;
    last_seen_at: number;
    obs: string;
    loan_status: string | null;
    loan_start_block: number | null;
  }>;
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
      // The command only when there IS a guard column to guard with; on a
      // pre-0053 database every statement naming `obs` fails outright, so
      // printing one is worse than printing none (#2231 r13 `4036869959`,
      // r14 `4037027817`).
      const clear = withGuard
        ? ` — clear with: ${clearCommand(chainId, r.loan_id, r.obs, r.last_seen_at)}`
        : '';
      return (
        `loan ${r.loan_id} (${r.reason}, held ${heldHours}h, ` +
        `last recorded unsettled ${sinceRecorded}h ago at ${r.last_seen_at}; ` +
        `${points})${clear}`
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
    // IDS ONLY here, whatever the schema (#2231 r14 `4037027842`,
    // `4037027817`).
    //
    // r8 paired each overflow id with the value its clear needs, so that a
    // named entry was not also an unactionable one. That was right about the
    // problem and wrong about the remedy: it left the operator assembling a
    // command out of parts, which is the thing that has now gone wrong four
    // rounds running — a word that matched nothing, doubled quotes, brackets
    // SQLite reads as an identifier. And on a pre-0053 database the printed
    // guard named a column that does not exist.
    //
    // There is no room for 180 finished commands in one line, so these ids
    // get what CAN be finished: the enquiry below returns everything a clear
    // needs, and the described entries above show the command already built.
    const ids = named.map((r) => String(r.loan_id)).join(', ');
    // PAST THE ROLL CALL'S OWN BOUND, SAY SO AND HAND OVER THE ENQUIRY. The
    // count is exact even here, so this is a stated limit rather than a page
    // that quietly ended (#2231 r7 `4035821168`).
    const unnamed = n - held.length;
    const beyond =
      unnamed > 0
        ? ` — and ${unnamed} further held entr${unnamed === 1 ? 'y' : 'ies'} ` +
          `NOT named here, because this report is bounded at ` +
          `${STALE_ROLL_CALL_LIMIT} ids and will not grow with the fault.`
        : '';
    // BOTH guard fields, and only where the column exists (#2231 r14
    // `4037027810`, `4037027817`). The enquiry is itself a finished statement
    // and is executed by the tests, like every other statement this report
    // emits.
    // THE ENQUIRY RETURNS FINISHED COMMANDS, not the values to build one
    // from (#2231 r15 `4037257304`).
    //
    // r14 said nothing was left to assemble and that was true only of the
    // described entries; these still had an operator copying three values
    // into a template read off another row. That is the assembly the whole
    // root fix was about, surviving in the one place the executing test
    // could not reach — it ran this SELECT and stopped, so it validated the
    // enquiry and nothing the enquiry led to.
    //
    // SQLite builds the statement instead: `||` for concatenation and
    // `replace()` for the quote doubling, so the quoting that went wrong by
    // hand at r12 is done by the engine that will parse it. The test now
    // executes this enquiry AND every command it returns.
    const lookup = withGuard
      ? ` To clear any of them, this enquiry returns each one's command ` +
        `already written — run the enquiry, then run the command it gives ` +
        `you for the entry you want, changing nothing: SELECT loan_id, ` +
        `'DELETE FROM loan_reconcile_quarantine WHERE chain_id = ' || ` +
        `chain_id || ' AND loan_id = ' || loan_id || ' AND obs = ''' || ` +
        `replace(obs, '''', '''''') || ''' AND last_seen_at = ' || ` +
        `last_seen_at || ' RETURNING loan_id;' AS clear_command FROM ` +
        `loan_reconcile_quarantine WHERE chain_id = ${chainId} ` +
        `AND first_seen_at <= ${cutoff} ORDER BY first_seen_at ASC;`
      : '';
    overflow =
      ` (+${n - shown.length} more, each also holding reminders back; ` +
      `${named.length} of them named here but NOT described: ${ids} — the ` +
      `detail above is the oldest ${STALE_REPORT_LIMIT} and does not rotate, ` +
      `so these stay undescribed until an entry ahead of them is resolved. ` +
      `Being named is not being examined: nothing above says what these ids ` +
      `point at now, and that is the check the described entries got and ` +
      `these did not.${beyond}${lookup})`;
  }
  // NO CLEARING INSTRUCTION AT ALL while the guard column has not been
  // observed (#2231 r13 `4036869959`). On a database still at 0049 every
  // command naming `obs` fails with an unknown-column error, so printing
  // one hands the operator something that cannot work and invites them to
  // improvise the unguarded delete this paragraph exists to prevent. The
  // window is minutes; saying "not yet" is the honest content for it.
  const howToClear = withGuard
    ? CLEAR_INSTRUCTION
    : `A guarded clear is NOT available on this database yet: the guard `
      + `column (migration 0053) has not been seen here, and every command `
      + `naming it would fail with an unknown-column error. Wait for the `
      + `migration rather than deleting unguarded — an unguarded delete `
      + `drops whatever a pass recorded between your reading this and `
      + `running it. In the ordinary rollout this is a deploy window of `
      + `minutes. Nothing here can tell you that, though: a probe `
      + `establishes only that the column is ABSENT, never when it will `
      + `arrive. If you are still reading this on a later run, the `
      + `migration did not land — go and look at it, because these `
      + `suppressions stay unclearable until it does.`;
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
      `from stored data has proved unsound (#2222). ${howToClear} ` +
      `Note also that an entry IS released ` +
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
  /**
   * Whether migration 0053's guard column has landed, as of the last probe
   * that succeeded — `'unknown'` before any has (#2231 r12 `4036719800`).
   *
   * A SECOND ANSWER FROM THE SAME READ, not a second probe. The deploy
   * window this whole probe exists for applies to a COLUMN exactly as it
   * does to a table: the canonical runbook publishes the Worker before
   * applying migrations, so new code runs for a few minutes against 0049's
   * table, which has no `obs`. An insert naming it fails the whole
   * quarantine batch, and a pass that cannot record an unsettled row leaves
   * the next pass free to remind on it — the module's own defect, during its
   * own upgrade.
   *
   * `sqlite_master.sql` carries the table's full DDL including columns added
   * by `ALTER TABLE`, so asking for it instead of the name answers both
   * questions for one read and no extra subrequest.
   */
  guardColumn(): boolean | 'unknown';
}

export function createQuarantineAvailability(): QuarantineAvailabilityProbe {
  let seen = false;
  let passOpen = false;
  let thisPass: QuarantineAvailability | null = null;
  // Latches on TRUE only, like `seen`: a column cannot un-land, and a probe
  // that failed must not be able to downgrade a `true` into a `false` and
  // send the write path back to the legacy shape on a healthy database.
  let guard: boolean | 'unknown' = 'unknown';
  const probe = async (db: QuarantineProbeDb): Promise<QuarantineAvailability> => {
    // FULLY SETTLED: the table is there AND the guard column is there. Only
    // then can this stop asking for good — a database seen without `obs` is
    // one mid-deploy, and it must be re-asked (once per pass) so the write
    // path picks up 0053 the moment it lands rather than at the next isolate.
    if (seen && guard === true) return 'present';
    // Otherwise still AT MOST ONCE PER PASS, exactly as before: the pass
    // cache covers the guard question too, so a legacy database costs one
    // probe a pass and not one per call.
    if (thisPass !== null) return thisPass;
    try {
      const row = await db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${QUARANTINE_TABLE}'`,
        )
        .first<{ sql: string | null }>();
      if (row) {
        seen = true;
        if (passOpen) thisPass = 'present';
        // A word-boundary match on the stored DDL. The column list is the
        // only place an identifier appears there — SQLite does not keep
        // comments for a column added by `ALTER TABLE` — so this is a
        // question about text with one right answer, not a parse.
        // TRUE or FALSE, never left `'unknown'` once the DDL has been read:
        // "the column is not there" is a definite answer and the write path
        // needs it, so it can use the legacy shape deliberately rather than
        // guess. Only a probe that FAILED leaves the previous value alone.
        guard = /\bobs\b/.test(row.sql ?? '');
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
  probe.guardColumn = () => guard;
  return probe as QuarantineAvailabilityProbe;
}
