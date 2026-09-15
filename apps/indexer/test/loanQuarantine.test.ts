/**
 * Remembering the rows a reconciliation pass could not settle (#2212).
 *
 * The defect this closes is an ALIASING one: "what this pass examined" is not
 * "what is currently unsettled". #2211 withheld reminders using the current
 * pass's report, and since the rotation examines one or three rows a turn,
 * the very next turn had an empty exclusion for the same unsettled row.
 *
 * Two halves. Marking is the easy one. RELEASING is where this becomes its
 * own bug if it is wrong: a mark never cleared silently withholds a healthy
 * loan's reminders forever, which is the mirror image of the defect — so the
 * release cases below are the ones to read first.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  QUARANTINE_STALE_SECONDS,
  quarantineStatements,
  reportStaleQuarantine,
  settledRows,
  unsettledRows,
} from '../src/loanQuarantine';
import type { ReconcileReport } from '../src/loanReconcile';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const NOW = 1_700_000_000;

const report = (over: Partial<ReconcileReport> = {}): ReconcileReport => ({
  chainId: CHAIN,
  chainActive: 6,
  indexedActive: 6,
  agreed: true,
  examined: [],
  repaired: [],
  unread: [],
  writeFailed: [],
  unresolvable: [],
  unknownStatus: [],
  superseded: [],
  nextPointer: 0,
  wrappedLap: false,
  ...over,
});

const quarantined = (h: SqliteD1) =>
  h.db
    .prepare(
      'SELECT loan_id, reason, first_seen_at, last_seen_at FROM loan_reconcile_quarantine ORDER BY loan_id',
    )
    .all() as Array<{ loan_id: number; reason: string; first_seen_at: number; last_seen_at: number }>;

async function apply(h: SqliteD1, r: ReconcileReport, nowSec = NOW) {
  const writes = quarantineStatements(h.d1 as never, CHAIN, r, nowSec);
  if (writes.length > 0) await (h.d1 as never as { batch: (s: unknown[]) => Promise<unknown> }).batch(writes);
}

describe('what counts as unsettled', () => {
  it('names all four ways a row fails to settle, and WHY for each', () => {
    // The reason is kept rather than flattened to a flag because the four
    // need different operator actions: the RPC, D1, a build behind the
    // contracts, and a row that needs a person.
    expect(
      unsettledRows(
        report({
          unread: [13],
          writeFailed: [14],
          unresolvable: [99],
          unknownStatus: [{ loanId: 21, status: 7 }],
        }),
      ),
    ).toEqual([
      { loanId: 13, reason: 'unread' },
      { loanId: 14, reason: 'write-failed' },
      { loanId: 99, reason: 'orphan' },
      { loanId: 21, reason: 'unknown-status' },
    ]);
  });
});

describe('what counts as settled — the half that must not over-release', () => {
  it('releases a row examined and found genuinely running', () => {
    // The ordinary case, and the one that ends a transient read failure's
    // quarantine on the next lap.
    expect(settledRows(report({ examined: [5, 6] }))).toEqual([5, 6]);
  });

  it('releases a repaired row and one another writer terminalized', () => {
    expect(
      settledRows(
        report({
          examined: [8, 9],
          repaired: [{ loanId: 8, from: 'active', to: 'defaulted' }],
          superseded: [9],
        }),
      ).sort((a, b) => a - b),
    ).toEqual([8, 9]);
  });

  it('does NOT release a row it examined and could not settle', () => {
    // The case that makes the whole thing work: every unsettled row was also
    // examined, so a release list built from `examined` alone would clear
    // each mark on the very pass that made it.
    expect(settledRows(report({ examined: [5, 13], unread: [13] }))).toEqual([5]);
  });

  it('does not release an unsettled row even if another bucket also names it', () => {
    // A row can be repaired AND then fail a later read within one pass. The
    // unsettled answer wins: the release is a subtraction, not a union with
    // a subtraction applied to only part of it.
    expect(
      settledRows(
        report({
          examined: [8],
          repaired: [{ loanId: 8, from: 'active', to: 'defaulted' }],
          writeFailed: [8],
        }),
      ),
    ).toEqual([]);
  });
});

describe('the table, over the real migrated schema', () => {
  it('marks a row with its reason and the time it was first seen', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }));
    expect(quarantined(h)).toEqual([
      { loan_id: 99, reason: 'orphan', first_seen_at: NOW, last_seen_at: NOW },
    ]);
  });

  it('KEEPS first_seen_at when the same row is seen unsettled again', async () => {
    // The operator's whole signal. Minutes means a transient read; days means
    // a ghost nobody resolved — and an upsert refreshing this on every
    // re-observation would erase exactly the fact worth knowing, leaving a
    // permanently stuck row looking freshly noticed forever.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW + 9999);
    expect(quarantined(h)[0]).toMatchObject({ first_seen_at: NOW, last_seen_at: NOW + 9999 });
  });

  it('updates the reason when the way it fails changes', async () => {
    // An orphan that becomes merely unreadable is a different problem with a
    // different remedy; the stored reason has to follow.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [13], unread: [13] }), NOW);
    await apply(h, report({ examined: [13], unresolvable: [13] }), NOW + 60);
    expect(quarantined(h)[0]).toMatchObject({ reason: 'orphan', first_seen_at: NOW });
  });

  it('releases the row once a later pass settles it', async () => {
    // Without this the fix is worse than the defect: a loan withheld forever
    // on the strength of one bad read.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [13], unread: [13] }));
    expect(quarantined(h)).toHaveLength(1);
    await apply(h, report({ examined: [13] }), NOW + 300);
    expect(quarantined(h)).toEqual([]);
  });

  it('leaves a row it did not examine alone, in either direction', async () => {
    // The rotation looks at a few rows a turn. A pass that never saw a
    // quarantined row must neither release it nor refresh it — that is the
    // entire reason this table exists rather than the pass's own report.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW);
    await apply(h, report({ examined: [5, 6] }), NOW + 300);
    expect(quarantined(h)).toEqual([
      { loan_id: 99, reason: 'orphan', first_seen_at: NOW, last_seen_at: NOW },
    ]);
  });
});

describe('telling the operator about a row that stays', () => {
  it('says nothing while a mark is young', async () => {
    // Silent by design in the ordinary case: a read fails, the row is held
    // for a lap, the next lap settles it, nobody needs to know.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [13], unread: [13] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + 60);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('names the loan, the reason and how long, once it has stayed', async () => {
    // A row unsettled this long is a position still published as open that
    // nobody has resolved. Retrying will not fix it, so silence would leave
    // it withheld and unexamined indefinitely.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('loan 99');
    expect(said).toContain('orphan');
    warn.mockRestore();
  });
});
