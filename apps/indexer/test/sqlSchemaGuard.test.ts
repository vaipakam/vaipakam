/**
 * #1149 — static SQL-vs-schema guardrail.
 *
 * Production incident 2026-07-10: the chainIndexer's OfferModified
 * handler UPDATEd `offers.collateral_amount_max`, a column no migration
 * ever created. D1 rejected it (`no such column`), the fail-closed scan
 * refused to advance the cursor, and Base-Sepolia ingest wedged ~25.7k
 * blocks behind — silently, because the mismatch only fires when the
 * scan window actually contains an OfferModified event. No unit test
 * executed that statement against the real schema, so the bug shipped
 * and sat dormant for ten days.
 *
 * This test kills the whole class: it applies EVERY migration (in the
 * same lexicographic filename order wrangler uses) to an in-memory
 * SQLite — the live db's exact schema, since migrations are the single
 * source of truth per CLAUDE.md's D1 discipline — then extracts every
 * SQL template literal passed to `.prepare(...)` across the Worker's
 * `src/` and prepares each one. `sqlite3_prepare` resolves every table
 * and column name at prepare time WITHOUT executing, so a statement
 * naming a column the migrations never created fails right here, in
 * vitest, instead of at 06:57 UTC on the deployed Worker.
 *
 * Scope and honesty:
 *  - Literals containing `${...}` interpolation (dynamic cond-joins,
 *    IN-list placeholders, an owner-column pivot) can't be prepared
 *    verbatim and are SKIPPED — their shapes are exercised by the
 *    route tests instead. The skip count is PINNED below so a refactor
 *    that pushes statements into the skipped bucket (blinding this
 *    guard) fails loudly rather than silently shrinking coverage.
 *  - The extracted-statement floor is pinned too: if the regex ever
 *    stops matching the codebase's prepare style, the count collapses
 *    and the assertion says so, instead of green-lighting an empty run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const SRC_DIR = new URL('../src/', import.meta.url);

/** Every statement the extractor found, tagged with its source file. */
interface Extracted {
  file: string;
  sql: string;
  interpolated: boolean;
}

function loadMigratedSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // wrangler applies migrations in filename order
  expect(files.length).toBeGreaterThanOrEqual(33); // 0001..0033 shipped
  for (const f of files) {
    const ddl = readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
    try {
      db.exec(ddl);
    } catch (err) {
      throw new Error(`migration ${f} failed to apply: ${String(err)}`);
    }
  }
  return db;
}

function extractPreparedSql(): Extracted[] {
  const out: Extracted[] = [];
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const text = readFileSync(new URL(f, SRC_DIR), 'utf8');
    // Every DB call in this Worker is `<env|db>.DB?.prepare(`template`)`
    // with the SQL as a backtick template literal (pinned by the count
    // floor below — a quoted-string prepare would silently escape this
    // regex, so the floor is the tripwire for style drift).
    const re = /\.prepare\(\s*`((?:[^`\\]|\\.)*)`/gs;
    for (const m of text.matchAll(re)) {
      const sql = m[1];
      out.push({ file: f, sql, interpolated: sql.includes('${') });
    }
  }
  return out;
}

describe('SQL-vs-schema guard (#1149)', () => {
  const db = loadMigratedSchema();
  const statements = extractPreparedSql();
  const staticStatements = statements.filter((s) => !s.interpolated);
  const skipped = statements.filter((s) => s.interpolated);

  it('extractor still sees the codebase (pinned floors)', () => {
    // ~109 prepare sites existed when this guard landed. The floor is
    // set well below to absorb legitimate deletions, but a collapse to
    // near-zero means the regex no longer matches the prepare style.
    expect(staticStatements.length).toBeGreaterThanOrEqual(80);
    // The skipped (interpolated) bucket was 8 when this landed. If it
    // GROWS, someone moved statements out of the guard's reach —
    // either make the new statement static or consciously raise this
    // pin with a route test covering the dynamic shape.
    // Raised 10 → 11 for #1213: the notification-center feed route builds
    // its `WHERE` (chain/recipient + optional keyset cursor) dynamically;
    // the shape is covered by test/notificationRoutes.test.ts against the
    // real migrated schema. (Read-state is client-side, so there is no
    // mark-read UPDATE.)
    // Raised 11 → 12 for #1213 PR 2: the calendar sweep's SELECT embeds
    // its compile-time `LIMIT ${SWEEP_LIMIT}` constant; the statement's
    // shape runs against the real migrated schema in
    // test/calendarNotifications.test.ts.
    // Raised 12 → 14 for #2101 (#2190 r6): the stub heal and the loan
    // repair now build their `SET` clause from ONE shared column list
    // (`mutableLoanColumnsFromDetail`), which is the fix for review
    // extending the repair's hand-picked field set three rounds running.
    // Sharing the list is what makes the SQL dynamic — the two cannot both
    // be had — so this is the guard's own "consciously raise the pin with a
    // test covering the dynamic shape" route, not an escape. Both shapes
    // execute against the REAL migrated schema:
    // `closedLoanSideTables.test.ts` drives `reconcileAfterScan` end to
    // end, and `loanStatusProjection`'s heal lane runs in the scan suites.
    // A column named wrongly in the builder fails those, loudly.
    //
    // Raised 14 → 15 for #2213 r22 (`4015173433`): the quarantine table's
    // availability probe MOVED INTO this Worker from `@vaipakam/lib`, where
    // this extractor could not see it. The statement itself is unchanged and
    // as old as the probe — it interpolates `${QUARANTINE_TABLE}`, the single
    // constant naming the table, into a `sqlite_master` lookup. So this raise
    // records a statement entering the guard's SCOPE rather than a new
    // dynamic statement being written, which is exactly what the pin is for:
    // it noticed, and it should have. The shape runs against the real
    // migrated schema in `calendarNotifications.test.ts` and
    // `loanQuarantine.test.ts`.
    // Raised 15 → 16 for #2231 r14 (`4037027829`): the terminal quarantine
    // sweep's DELETE now names the exact ids its bounded roster returned,
    // `WHERE loan_id IN (?, ?, …)`, with one placeholder per id. It repeated
    // the roster's two-table `EXISTS` before, which meant a SECOND unbounded
    // walk of every held row on each sweep — the bound applied to what came
    // back, never to the work. Binding the ids is what makes the statement
    // dynamic; the values are still bound, never interpolated.
    //
    // The guard's own "raise the pin with a test covering the dynamic shape"
    // route, and the covering test is unusually direct: `loanQuarantine.test`
    // runs the sweep against the REAL migrated schema and asserts exactly
    // which rows go and which remain, so a mis-built `IN` list fails loudly
    // rather than silently clearing too much.
    expect(skipped.length).toBeLessThanOrEqual(16);
  });

  it('every static SQL statement prepares against the migrated schema', () => {
    const failures: string[] = [];
    for (const s of staticStatements) {
      try {
        // prepare() resolves all table/column names without executing.
        db.prepare(s.sql);
      } catch (err) {
        failures.push(
          `${s.file}: ${String(err)}\n  SQL: ${s.sql.replace(/\s+/g, ' ').slice(0, 200)}`,
        );
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });

  it('regression pin: offers has no collateral_amount_max (the #1149 column)', () => {
    // The offers schema stores collateral MIN only — amount_max and
    // interest_rate_bps_max exist, a collateral max never did. If a
    // future migration adds it (for ranged-collateral display), this
    // pin flips and should be updated alongside the create/refresh
    // writes — never by re-adding the column to one UPDATE alone.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('offers')`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('collateral_amount');
    expect(names).toContain('amount_max');
    expect(names).toContain('interest_rate_bps_max');
    expect(names).not.toContain('collateral_amount_max');
  });
});
