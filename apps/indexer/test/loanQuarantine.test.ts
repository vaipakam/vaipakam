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
  createQuarantineAvailability,
  QUARANTINE_STALE_SECONDS,
  quarantineStatements,
  releaseTerminalQuarantine,
  reportStaleQuarantine,
  STALE_REPORT_LIMIT,
  STALE_ROLL_CALL_LIMIT,
  QUARANTINE_SWEEP_BATCH,
  discloseQuarantineReleases,
  quarantineReleaseStatement,
  settledRows,
  unsettledRows,
} from '../src/loanQuarantine';
import type { ReconcileReport } from '../src/loanReconcile';
import {
  _reportQuarantineForChain,
  _resetQuarantineWriteProbe,
} from '../src/chainIndexer';
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

/** The per-observation guard token, read separately so the shape assertions
 *  on `quarantined()` stay exact. */
const guardTokens = (h: SqliteD1) =>
  new Map(
    (
      h.db
        .prepare('SELECT loan_id, obs FROM loan_reconcile_quarantine')
        .all() as Array<{ loan_id: number; obs: string }>
    ).map((r) => [r.loan_id, r.obs]),
  );

async function apply(h: SqliteD1, r: ReconcileReport, nowSec = NOW): Promise<unknown> {
  const writes = quarantineStatements(h.d1 as never, CHAIN, r, nowSec, true);
  if (writes.length === 0) return [];
  return (h.d1 as never as { batch: (s: unknown[]) => Promise<unknown> }).batch(writes);
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

/** The minimum a `loans` row needs to exist, for the release sweep's join. */
/**
 * `startBlock` is the CHAIN's loan start block, which #2222's release clause
 * reads — a log-derived number, unlike `start_at`, which ingest may fill with
 * a local clock sentinel when a block-timestamp lookup fails (#2231 r1).
 */
function seedLoanRow(
  h: SqliteD1,
  loanId: number,
  status: string,
  startBlock = 0,
) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, ?, '0xl', '0xb', '100', '200', 0, 0, '0xa', '0xc', 30,
         '0', '0', '1', '2', '0xl', '0xb', 500, ?, ?, 0, ?)`,
    )
    .run(CHAIN, loanId, status, NOW, startBlock, NOW);
}

describe('the table, over the real migrated schema', () => {
  it('marks a row with its reason and the time it was first seen', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }));
    expect(quarantined(h)).toEqual([
      { loan_id: 99, reason: 'orphan', first_seen_at: NOW, last_seen_at: NOW },
    ]);
  });

  it('still records a marker on a database where 0053 has NOT landed', async () => {
    // #2231 r12 `4036719800`. The canonical runbook publishes the Worker
    // before applying migrations, so for a few minutes on every deploy this
    // code runs against 0049's table, which has no guard column. Naming it
    // fails the WHOLE batch, and a pass that cannot record an unsettled row
    // leaves the next pass free to remind on it — the module's own defect,
    // during its own upgrade.
    //
    // Every other test here runs the fully migrated schema, which is why
    // mutation-checking the flag away broke nothing. This is the deploy
    // window, built.
    const legacy = createSqliteD1(
      ALL_MIGRATIONS.filter((sql) => !/ADD COLUMN obs/.test(sql)),
    );
    const writes = quarantineStatements(
      legacy.d1 as never,
      CHAIN,
      report({ examined: [31], unread: [31] }),
      NOW,
      false,
    );
    await (legacy.d1 as never as { batch: (s: unknown[]) => Promise<unknown> }).batch(writes);
    expect(quarantined(legacy)).toEqual([
      { loan_id: 31, reason: 'unread', first_seen_at: NOW, last_seen_at: NOW },
    ]);
    // And the guard-shaped write is exactly what would have failed, which is
    // why the flag defaults to the legacy shape rather than the new one.
    const guarded = quarantineStatements(
      legacy.d1 as never,
      CHAIN,
      report({ examined: [32], unread: [32] }),
      NOW,
      true,
    );
    await expect(
      (legacy.d1 as never as { batch: (s: unknown[]) => Promise<unknown> }).batch(guarded),
    ).rejects.toThrow();
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

  it('changes the guard on a SAME-SECOND re-observation, which a timestamp does not', async () => {
    // #2231 r11 `4036569620`. The report tells an operator to clear an entry
    // with a compare-and-delete so a pass re-observing it in between is not
    // discarded. Guarded on `last_seen_at`, two sightings inside one second
    // leave the value identical — the guard passes and the FRESH finding is
    // deleted, while the message promises it would delete nothing.
    //
    // This is the exact case, written at one fixed second so it cannot pass
    // by accident: the timestamp is unchanged and the guard is not.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [42], unread: [42] }), NOW);
    const before = quarantined(h)[0];
    const guardBefore = guardTokens(h).get(42);
    await apply(h, report({ examined: [42], unread: [42] }), NOW);
    const after = quarantined(h)[0];
    const guardAfter = guardTokens(h).get(42);
    // The timestamp cannot tell the two observations apart...
    expect(after.last_seen_at).toBe(before.last_seen_at);
    // ...and the guard can, which is the whole point.
    expect(guardAfter).not.toBe(guardBefore);
    expect(guardAfter).toMatch(/^[0-9a-f]{8}$/);
    // So the operator's guarded delete, holding the OLD guard, removes
    // nothing — and the fresh finding survives.
    const removed = h.db
      .prepare('DELETE FROM loan_reconcile_quarantine WHERE chain_id = ? AND loan_id = ? AND obs = ?')
      .run(CHAIN, 42, guardBefore as string);
    expect(Number(removed.changes)).toBe(0);
    expect(quarantined(h)).toHaveLength(1);
  });

  it('releases a held row whose loan has since ended, however it ended', async () => {
    // #2213 r15 `4013952990`. The durable cleanup path. A release missed at
    // close-out — because the table's existence could not be established, or
    // because that statement failed — has no second chance from the close-out
    // side: the loan is terminal, so it has left the set the reconciliation
    // rotation selects from and no pass revisits it. Sweeping on the row's own
    // state covers every way the release can be missed, including ways nobody
    // has thought of.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [13, 14], unread: [13], unresolvable: [14] }));
    expect(quarantined(h)).toHaveLength(2);
    seedLoanRow(h, 13, 'repaid');
    seedLoanRow(h, 14, 'active');
    await releaseTerminalQuarantine(h.d1 as never, CHAIN);
    // 13 ended, so its row goes; 14 is still live and stays held.
    expect(quarantined(h).map((r) => r.loan_id)).toEqual([14]);
  });

  it('says which entries it released, because it cannot verify they are the same position', async () => {
    // #2231 r6 `4035682797`. The release condition is itself an identity
    // assumption: it takes the stored row bearing an id to be the position
    // the finding was about, and a REPLACEMENT loan that started and ended
    // under that id satisfies it just as well.
    //
    // The stale report states that assumption — but the report cannot be the
    // surface that discloses it, because this sweep runs FIRST and the report
    // returns early once nothing is held. In exactly the case worth
    // disclosing, the sweep empties the table and the report says nothing.
    // Whoever exercises the assumption reports it.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [13, 14], unread: [13], unresolvable: [14] }));
    seedLoanRow(h, 13, 'repaid');
    seedLoanRow(h, 14, 'active');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await releaseTerminalQuarantine(h.d1 as never, CHAIN);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // The id that WAS released is named — a count alone cannot be audited.
    expect(said).toContain('released 1 held entry');
    expect(said).toContain('13');
    expect(said).toContain('identity assumption');
    // And it does not claim more than it knows.
    expect(said).toContain('Nothing here distinguishes the two');
    warn.mockRestore();
  });

  it('says when the pass SETTLING an id released a long-held entry', async () => {
    // #2231 r7 `4035821181`. The ordinary settle path deletes a held marker
    // the moment the rotation examines its id and the chain answers —
    // including when the id has come round again and the answer is about a
    // different position. That is a release on a reused id, it is not the
    // terminal sweep, and it was silent.
    //
    // It is NOT prevented, and that is the deliberate half: a chain read of
    // the id is the only sound evidence anywhere in this module, and blocking
    // it would withhold a live settled position's reminders forever on the
    // strength of a finding about a position that no longer exists. What it
    // must not be is unannounced.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [77], unresolvable: [77] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const later = NOW + QUARANTINE_STALE_SECONDS + 1;
    const outcome = await apply(h, report({ examined: [77] }), later);
    discloseQuarantineReleases(CHAIN, outcome, later);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('released 1 long-held entry');
    expect(said).toContain('loan 77');
    expect(said).toContain('the chain answered');
    expect(said).toContain('soundest release');
    // It says what it cannot know, rather than implying identity.
    expect(said).toContain('Nothing here can tell whether there was an earlier position');
    expect(quarantined(h)).toEqual([]);
    warn.mockRestore();
  });

  it('leaves no way to release one marker without reporting it', async () => {
    // THE ROOT FIX, pinned structurally (#2231 r9 `4036242408`).
    //
    // Three places delete a marker for one loan, and disclosure was added to
    // them one at a time as each round noticed one — so the third stayed
    // silent until round 9 found it. The defect was never a missing case; it
    // was a missing RULE. `quarantineReleaseStatement` is now the only way to
    // build such a delete, and it carries the `RETURNING` that makes the
    // release visible.
    //
    // A test naming the three sites would pass while a FOURTH was added
    // silently — which is the failure this fix exists to prevent, reproduced
    // in the test. So the assertion is on the source: no module may write a
    // single-loan quarantine delete by hand.
    const sources = ['../src/loanQuarantine.ts', '../src/chainIndexer.ts'].map((rel) =>
      readFileSync(new URL(rel, import.meta.url), 'utf8'),
    );
    for (const src of sources) {
      // Every `DELETE FROM loan_reconcile_quarantine` keyed by a single loan
      // must come from the shared builder. The bulk sweep deletes by
      // `chain_id` alone plus an EXISTS, so it does not match, and it has its
      // own disclosure.
      const handWritten = src.match(
        /DELETE FROM loan_reconcile_quarantine\s+WHERE chain_id = \?\s+AND loan_id = \?(?![\s\S]{0,80}RETURNING)/g,
      );
      expect(handWritten).toBeNull();
    }
    // And the builder does carry it, so the rule above has something to mean.
    const built = quarantineReleaseStatement({
      prepare: (sql: string) => ({ bind: () => sql }),
    } as never, CHAIN, 7) as unknown as string;
    expect(built).toContain('RETURNING');
  });

  it('wires each release path to ITS OWN basis, not a borrowed one', async () => {
    // The basis is chosen at the CALL SITE, and every behavioural test for it
    // supplies its own — so reverting a call site to the wrong basis broke
    // nothing, which I found by mutation-checking rather than by a round.
    // A test that passes because it stubbed the thing under test is the
    // failure this file has already hit twice (#2231 r8, r9).
    //
    // The wiring is the claim: `reconciled` where a chain read found the loan
    // terminal with the event MISSED, `closed-out` where an event actually
    // arrived. Getting them the wrong way round tells an operator the
    // opposite of what licensed the release.
    const src = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
    // The repair path reaches the close-out list from a safe-head chain read
    // — and only claims so when its own compare-and-set landed. A lost CAS
    // means another writer got there first, possibly the event handler, so
    // the weaker basis is used (#2231 r14 `4037027847`).
    expect(src).toMatch(
      /discloseSideTableBatch:[\s\S]{0,1200}?wonTheCas \? 'reconciled' : 'chain-read'/,
    );
    // The event handlers' own cleanup did see an event.
    expect(src).toMatch(
      /async function _clearClosedLoanSideTables[\s\S]*?discloseQuarantineReleases\([\s\S]{0,200}?'closed-out'\)/,
    );
    // And no call site borrows the settle path's wording.
    expect(src).not.toMatch(/discloseSideTableBatch:[\s\S]{0,1200}?'closed-out'/);
  });

  it('stays quiet when a settle releases a mark that was never long-held', async () => {
    // The silent-by-design case: a read fails, the row is held for a lap, the
    // next lap settles it. Announcing those would bury the ones that matter —
    // and the overwhelming majority of these deletes are no-ops against a
    // marker that was never there at all.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [77], unread: [77] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const outcome = await apply(h, report({ examined: [77, 78] }), NOW + 300);
    discloseQuarantineReleases(CHAIN, outcome, NOW + 300);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('bounds the ids it names when a sweep releases a great many', async () => {
    // The sweep clears everything terminal on the chain in ONE statement, so
    // a mass close-out or a backfill returns thousands of ids — and joining
    // them into one line is the same unbounded-log defect #2231 r7 found in
    // the stale report, arriving by the other door. Found by a self-review of
    // this PR's diff rather than by a round, which is the only reason it is
    // not a finding.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const extra = 4;
    const ids = Array.from({ length: STALE_ROLL_CALL_LIMIT + extra }, (_, k) => 7000 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }));
    for (const id of ids) seedLoanRow(h, id, 'repaid');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await releaseTerminalQuarantine(h.d1 as never, CHAIN);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // The COUNT is exact — it is free, and it is what conveys the magnitude.
    // ONE PASS CLEARS AT MOST A BIND-SAFE BATCH, and says exactly that
    // number: the delete names the ids the roster returned, so the count
    // describes the rows just listed (#2231 r14 `4037027829`). The batch is
    // 90, not the report's 200 — D1 caps a statement at 100 bound parameters
    // and a 200-id list would throw on every pass (#2231 r16 `4037430369`).
    expect(said).toContain(`released ${QUARANTINE_SWEEP_BATCH} held entries`);
    const shown = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(said));
    expect(shown).toHaveLength(QUARANTINE_SWEEP_BATCH);
    // The remainder waits for later passes — this sweep is the durable
    // cleanup path and runs on every one.
    expect(quarantined(h)).toHaveLength(ids.length - QUARANTINE_SWEEP_BATCH);
    warn.mockRestore();
  });

  it('never asks D1 for more rows than it will name', async () => {
    // #2231 r8 `4036084552`. The previous revision bounded the LOG and
    // nothing else: `RETURNING` still asked D1 to hand back every deleted id
    // and the Worker still materialised them all, so response volume and
    // memory stayed linear in the number of terminal markers. Slicing the
    // array afterwards hides that rather than fixing it.
    //
    // So the assertion is on what comes back from the DATABASE, not on the
    // string — the only place the distinction is visible.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_ROLL_CALL_LIMIT + 40 }, (_, k) => 8000 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }));
    for (const id of ids) seedLoanRow(h, id, 'repaid');
    const returned: number[] = [];
    const counting = {
      prepare: (sql: string) => {
        const stmt = (h.d1 as { prepare: (s: string) => never }).prepare(sql);
        return new Proxy(stmt as object, {
          get(target, prop, recv) {
            const bound = Reflect.get(target, prop, recv);
            if (prop !== 'bind') return bound;
            return (...args: unknown[]) => {
              const st = (bound as (...a: unknown[]) => Record<string, unknown>).apply(target, args);
              const all = st.all as () => Promise<{ results?: unknown[] }>;
              return {
                ...st,
                all: async () => {
                  const res = await all.call(st);
                  returned.push((res.results ?? []).length);
                  return res;
                },
              };
            };
          },
        });
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await releaseTerminalQuarantine(counting as never, CHAIN);
    warn.mockRestore();
    expect(returned.length).toBeGreaterThan(0);
    // Never more than the sweep's BIND-SAFE batch, which is the tighter of
    // the two bounds and the one D1 enforces (#2231 r16 `4037430369`).
    for (const count of returned) expect(count).toBeLessThanOrEqual(QUARANTINE_SWEEP_BATCH);
    // The delete is bounded WITH the read, so one pass clears a batch and the
    // rest wait for later passes (#2231 r14 `4037027829`). The earlier shape
    // removed everything in one go by repeating the roster's two-table
    // condition — unbounded work behind a bounded read.
    expect(quarantined(h)).toHaveLength(STALE_ROLL_CALL_LIMIT + 40 - QUARANTINE_SWEEP_BATCH);
  });

  it('will not invent a count when the driver reports none', async () => {
    // Found by re-reading my own round-8 commit, not by a round. The count
    // fell back to the roster length, which is CAPPED — so a sweep that
    // removed five thousand rows would have reported "released 200": a figure
    // the code cannot substantiate, stated as exact. The roster length is a
    // sound LOWER bound, so it is reported as one.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_ROLL_CALL_LIMIT + 7 }, (_, k) => 6000 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }));
    for (const id of ids) seedLoanRow(h, id, 'repaid');
    // A driver that runs the statement but reports no row count.
    const countless = {
      prepare: (sql: string) => {
        const stmt = (h.d1 as { prepare: (s: string) => never }).prepare(sql);
        return {
          bind: (...args: unknown[]) => {
            const st = (stmt as unknown as { bind: (...a: unknown[]) => Record<string, unknown> })
              .bind(...args);
            return { ...st, run: async () => { await (st.run as () => Promise<unknown>)(); return {}; } };
          },
        };
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await releaseTerminalQuarantine(countless as never, CHAIN);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(said).toContain('an unreported number of held entries');
    // NOT "at least N" — the roster and the delete are separate statements,
    // so rows can be cleared or turn active in between and the roster is no
    // lower bound on what went (#2231 r16 `4037430426`).
    expect(said).not.toContain('at least');
    expect(said).toContain(`${QUARANTINE_SWEEP_BATCH} qualified a moment earlier`);
    expect(said).toContain('not a count of what went');
    // The release still happened, up to this pass's batch.
    expect(quarantined(h)).toHaveLength(
      STALE_ROLL_CALL_LIMIT + 7 - QUARANTINE_SWEEP_BATCH,
    );
  });

  it('will not release a hold whose loan turned active between read and delete', async () => {
    // #2231 r16 `4037430380`. The bounded delete names ids, which is what
    // stops a second unbounded walk — but an id-only delete no longer checks
    // the fact that licensed the release. Between the roster read and the
    // delete, the terminal row can be replaced by an ACTIVE loan under the
    // same id. That is not a hypothetical race: it is the reused-id
    // remediation this whole change is about, and releasing there resumes
    // reminders for a live loan.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [81, 82], unread: [81, 82] }));
    seedLoanRow(h, 81, 'repaid');
    seedLoanRow(h, 82, 'repaid');
    // A db that swaps loan 81 for an active replacement once the roster has
    // been read — exactly the window the predicate re-check closes.
    const racing = {
      prepare: (sql: string) => {
        const st = (h.d1 as { prepare: (q: string) => never }).prepare(sql) as unknown as Record<
          string,
          unknown
        >;
        if (!/^\s*SELECT loan_id FROM/.test(sql)) return st;
        return {
          ...st,
          bind: (...args: unknown[]) => {
            const bound = (st.bind as (...a: unknown[]) => Record<string, unknown>)(...args);
            return {
              ...bound,
              all: async () => {
                const out = await (bound.all as () => Promise<unknown>)();
                h.db.prepare('DELETE FROM loans WHERE loan_id = 81').run();
                seedLoanRow(h, 81, 'active');
                return out;
              },
            };
          },
        };
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await releaseTerminalQuarantine(racing as never, CHAIN);
    warn.mockRestore();
    // 82 was and remained terminal, so it goes. 81 is a live loan now, so its
    // hold stays and the next pass looks again.
    expect(quarantined(h).map((r) => r.loan_id)).toEqual([81]);
  });

  it('stays silent on a sweep that released nothing', async () => {
    // The disclosure is about an assumption EXERCISED. A sweep that deleted
    // no row exercised none, and a line on every pass would bury the ones
    // that matter — the same noise argument that keeps the young-mark case
    // silent.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [14], unread: [14] }));
    seedLoanRow(h, 14, 'active');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await releaseTerminalQuarantine(h.d1 as never, CHAIN);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves a held row alone when its loan is not in the table at all', async () => {
    // The orphan case — the chain denies the loan and D1 may have no row for
    // it either. There is nothing to prove it ended, so it stays held and
    // stays in the stale report, which is where a person needs to see it.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }));
    await releaseTerminalQuarantine(h.d1 as never, CHAIN);
    expect(quarantined(h).map((r) => r.loan_id)).toEqual([99]);
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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + 60, true);
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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('loan 99');
    expect(said).toContain('orphan');
    warn.mockRestore();
  });

  it('names the loan a held id points at NOW, so the suppression is visible', async () => {
    // #2231 r4. A held entry withholds reminders from whatever loan currently
    // bears its id, and the platform cannot soundly establish whether that
    // loan is the one the finding was about — four different columns were
    // tried and every one can be substituted, reset, gone stale or left
    // behind by a reorg. So it reports what it sees and a person decides.
    // Without this line an operator cannot tell a finding still doing its job
    // from one suppressing a position it was never about.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW);
    seedLoanRow(h, 99, 'active', 5_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('stored row for this id: active, from block 5000');
    // Labelled as stored and unverified, never as what the id "now holds" —
    // that row can be reorg residue, which is why the automatic release went.
    expect(said).toContain('UNVERIFIED');
    expect(said).toContain('canonical identity unknown');
    // And how to clear it, since the platform will not do so on its own —
    // guarded on the exact entry that was read, so a pass that re-observes
    // the id between the reading and the running is not silently dropped.
    expect(said).toContain('DELETE FROM loan_reconcile_quarantine');
    expect(said).toContain('run it as printed, changing nothing');
    warn.mockRestore();
  });

  it('still names an entry whose loan row is gone, claiming nothing about it', async () => {
    // The orphan an operator may already have resolved by deleting the row.
    // A LEFT JOIN keeps it in the report — dropping it would hide exactly the
    // entry most likely to be suppressing something.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [99], unresolvable: [99] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('loan 99');
    expect(said).toContain('no stored loan row for this id');
    warn.mockRestore();
  });

  it('names EVERY held id, not just the page it describes', async () => {
    // #2231 r5 `4035554496`. This report is now the only surface that
    // discloses a suppression, so a page that stopped at its limit left every
    // id past it withholding reminders with nothing ever saying which.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_REPORT_LIMIT + 3 }, (_, k) => 500 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // The three past the described page are named individually.
    for (const id of ids.slice(STALE_REPORT_LIMIT)) {
      expect(said).toContain(String(id));
    }
    expect(said).toContain('also holding reminders back');
    warn.mockRestore();
  });

  it('costs the same one statement whether or not the page overflows', async () => {
    // #2231 r6 `4035682768`. The roll call above arrived as a THIRD D1 call,
    // issued only when the page overflowed — a report whose cost depends on
    // the data, under a ceiling whose overrun aborts the invocation before
    // the scan cursor is written. The pass that pays the extra is by
    // definition the one holding the most rows: the least able to afford it,
    // and the one whose failure freezes the chain.
    //
    // So the assertion is on the COST, and it is the same number on both
    // sides of the page boundary. Re-budgeting for a variable cost would have
    // satisfied the finding and left the dependency in place.
    // Counted as SUBREQUESTS, which is what the ceiling is about: a `batch()`
    // is one round trip however many statements it carries. Counting
    // `prepare` calls would have reported 2 for a report that makes a single
    // trip (#2231 r11 `4036569628` folded the count and the page into one
    // transactional batch, for the snapshot — and got the cost back too).
    const subrequests = async (count: number): Promise<number> => {
      const h = createSqliteD1(ALL_MIGRATIONS);
      const ids = Array.from({ length: count }, (_, k) => 500 + k);
      await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
      let trips = 0;
      const inner = h.d1 as {
        prepare: (s: string) => never;
        batch: (st: unknown[]) => Promise<unknown>;
      };
      const counting = {
        prepare: (sql: string) => {
          const st = inner.prepare(sql) as unknown as Record<string, unknown>;
          const wrap = (o: Record<string, unknown>): Record<string, unknown> => ({
            ...o,
            bind: (...a: unknown[]) =>
              wrap((o.bind as (...x: unknown[]) => Record<string, unknown>)(...a)),
            first: async () => { trips += 1; return (o.first as () => Promise<unknown>)(); },
            all: async () => { trips += 1; return (o.all as () => Promise<unknown>)(); },
            run: async () => { trips += 1; return (o.run as () => Promise<unknown>)(); },
          });
          return wrap(st);
        },
        batch: async (st: unknown[]) => {
          trips += 1;
          return inner.batch(st);
        },
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await reportStaleQuarantine(counting as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
      warn.mockRestore();
      return trips;
    };
    expect(await subrequests(STALE_REPORT_LIMIT - 1)).toBe(1);
    expect(await subrequests(STALE_REPORT_LIMIT + 3)).toBe(1);
  });

  it('prints a legacy row\u2019s guard as something that actually executes', async () => {
    // #2231 r12 `4036719806`. A row written before migration 0053 carries the
    // column default \u2014 an empty string \u2014 and rendering that as the word
    // "none" produced `obs = 'none'`, which matches nothing. An orphan may
    // never be re-observed, so it would never acquire a token: the entry
    // would be permanently unclearable by the documented safe route while
    // still suppressing reminders, which is the one class of row this report
    // exists for.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [55], unresolvable: [55] }), NOW);
    // Exactly what 0053 leaves behind on a row written by the old shape.
    h.db.prepare("UPDATE loan_reconcile_quarantine SET obs = '' WHERE loan_id = 55").run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    // An empty SQL literal, not a word.
    expect(said).toContain(`AND obs = '' AND last_seen_at = ${NOW} RETURNING loan_id;`);
    expect(said).not.toContain('guard none');
    // And the instruction does not add quotes of its own, which would turn
    // that into four quote characters and match nothing again.
    expect(said).toContain('run it as printed, changing nothing');
    // The command it produces is the one that works.
    // The command the report produces, RUN AS PRINTED.
    const printed = (said.match(/clear with: (DELETE[^;]*;)/) ?? [])[1];
    expect(printed).toBeTruthy();
    expect(h.db.prepare(printed as string).all()).toHaveLength(1);
  });

  it('EXECUTES every statement it prints, exactly as printed', async () => {
    // THE ROOT FIX for a defect class, not a case (#2231 r14 `4037027842`,
    // and r11-r13 before it).
    //
    // The report hands an operator SQL. Across four rounds every kind of
    // fragment it printed turned out not to run: a word that matched nothing,
    // quotes that doubled into four, a column that does not exist on the
    // older schema, and finally brackets that SQLite reads as an identifier.
    // Each round fixed the fragment; none of them could catch the next one,
    // because a string this file merely DESCRIBES is only checked by a reader
    // noticing.
    //
    // So the statements are finished, and this runs them. Anything the report
    // prints between `DELETE`/`SELECT` and `;` is extracted and executed
    // against the real migrated schema. A command that does not parse, names
    // a column that is not there, or quotes a value wrongly fails here rather
    // than in front of an operator holding a live suppression.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_REPORT_LIMIT + 5 }, (_, k) => 400 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
    seedLoanRow(h, 400, 'active', 5000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();

    // EXTRACTED THE WAY AN OPERATOR COPIES, from the label to the semicolon
    // — not by finding a `DELETE` and reading forward, which would step over
    // any stray delimiter sitting in front of it. That is not hypothetical:
    // the defect this test exists for was brackets around the command, and a
    // `DELETE`-anchored match reads straight past an opening bracket and
    // passes on the exact string that fails for a human.
    const perEntry = [...said.matchAll(/clear with: (DELETE[^;]*;)/g)].map((m) => m[1]);
    expect(perEntry).toHaveLength(STALE_REPORT_LIMIT);
    // The enquiry is matched to its OWN terminator, not to the first `;`:
    // it builds a statement, so it contains a semicolon inside a string
    // literal. A lazy `[^;]*;` truncates it into something that does not
    // parse — and a test that then asserted "it parses" would be asserting
    // about a string the report never printed.
    const enquiry = (said.match(/SELECT loan_id,[\s\S]*?ORDER BY first_seen_at ASC;/) ?? [])[1 - 1];
    expect(enquiry).toBeTruthy();

    // Each described entry's command, run verbatim. Throws on a syntax
    // error, an unknown column, or a mis-quoted literal.
    for (const sql of perEntry) {
      const rows = h.db.prepare(sql).all() as unknown[];
      // `RETURNING loan_id`, so the operator can SEE which outcome they got
      // (#2231 r15 `4037257331`). Exactly one row back: a command returning
      // none would be a guard that does not match, and one returning more
      // would be a delete not anchored to a row.
      expect(rows).toHaveLength(1);
    }
    // Exactly the described entries went; everything else is still held.
    expect(quarantined(h)).toHaveLength(5);

    // THE ENQUIRY, AND THEN WHAT THE ENQUIRY HANDS BACK (#2231 r15
    // `4037257304`). Running only the enquiry validated the enquiry and
    // nothing it led to — which is where the operator-side assembly had
    // survived the root fix.
    const handed = h.db.prepare(enquiry as string).all() as Array<{
      loan_id: number;
      clear_command: string;
    }>;
    expect(handed).toHaveLength(5);
    for (const row of handed) {
      const rows = h.db.prepare(row.clear_command).all() as unknown[];
      expect(rows).toHaveLength(1);
    }
    // And with those run, nothing is held at all.
    expect(quarantined(h)).toHaveLength(0);
  });

  it('offers NO clearing command while the guard column is unseen', async () => {
    // #2231 r13 `4036869959`. During the deploy window the report reads a
    // 0049 table by synthesizing an empty guard — but every command naming
    // `obs` fails there with an unknown-column error. Printing one hands the
    // operator something that cannot work and invites them to improvise the
    // unguarded delete this report spends a paragraph warning against.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [61], unresolvable: [61] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    // `false` is what the probe reports on a database still at 0049.
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, false);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    // The hold is still reported — the window is exactly when a suppression
    // most needs to be visible.
    expect(said).toContain('loan 61');
    // But no command that would fail is offered...
    expect(said).not.toContain('DELETE FROM loan_reconcile_quarantine');
    // ...and the reason is stated rather than left as a silent omission.
    expect(said).toContain('A guarded clear is NOT available on this database yet');
    expect(said).toContain('unknown-column error');
    expect(said).toContain('rather than deleting unguarded');
  });

  it('will not let a stale token clear a row the legacy shape re-observed', async () => {
    // #2231 r13 `4036869950`. The legacy write cannot name `obs`, so its
    // ON CONFLICT leaves an existing token untouched while recording a fresh
    // sighting. Run against a MIGRATED table — which happens if 0053 lands
    // mid-pass, or if a probe fails — a guard of the token alone would still
    // match, and the operator's clear would remove a finding they never saw:
    // round 11's defect, reintroduced by round 12's fallback.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [71], unread: [71] }), NOW);
    const staleToken = guardTokens(h).get(71) as string;
    // The fallback shape, on a table that DOES have the column.
    const legacy = quarantineStatements(
      h.d1 as never,
      CHAIN,
      report({ examined: [71], unread: [71] }),
      NOW + 30,
      false,
    );
    await (h.d1 as never as { batch: (x: unknown[]) => Promise<unknown> }).batch(legacy);
    // The token really is untouched — that is the hole.
    expect(guardTokens(h).get(71)).toBe(staleToken);
    // The composite guard is what closes it: the sighting time moved.
    const removed = h.db
      .prepare(
        `DELETE FROM loan_reconcile_quarantine WHERE chain_id = ? AND loan_id = ? ` +
          `AND obs = ? AND last_seen_at = ?`,
      )
      .run(CHAIN, 71, staleToken, NOW);
    expect(Number(removed.changes)).toBe(0);
    expect(quarantined(h)).toHaveLength(1);
  });

  it('bounds the roll call, and says exactly how many it is not naming', async () => {
    // #2231 r6 fixed the round-TRIP count and left the VOLUME growing with the
    // number of held rows — every row materialised and every id joined into
    // one line — so the report would fail on exactly the chain that most needs
    // it, inside the invocation that must still write the scan cursor (#2231
    // r7 `4035821168`). A bound is mandatory; a bound that is SILENT is the
    // truncation this module exists to avoid.
    //
    // So the two properties are asserted together: the naming stops at the
    // cap, and the count of what is past it is EXACT — which is only possible
    // because the total comes from `COUNT(*) OVER ()` in the same statement
    // rather than from the size of a truncated page.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const extra = 5;
    const ids = Array.from({ length: STALE_ROLL_CALL_LIMIT + extra }, (_, k) => 5000 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // The TOTAL is exact past the cap — the window function, not the page.
    expect(said).toContain(`${STALE_ROLL_CALL_LIMIT + extra} loan(s) held back`);
    // Exactly the cap's worth of ids are named, not all of them.
    const named = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(said));
    expect(named).toHaveLength(STALE_ROLL_CALL_LIMIT);
    // And the shortfall is STATED, with the query that closes it.
    expect(said).toContain(`${extra} further held entries NOT named here`);
    expect(said).toContain(`bounded at ${STALE_ROLL_CALL_LIMIT} ids`);
    expect(said).toContain("'DELETE FROM loan_reconcile_quarantine WHERE chain_id = ' ||");
    warn.mockRestore();
  });

  it('does not promise the overflow will be described later', async () => {
    // #2231 r6 `4035682787`. It said "described next tick" for one round, and
    // nothing keeps that promise: the described page is the OLDEST entries
    // and does not rotate, so the same ones are described every tick and the
    // remainder stay identifier-only until an entry ahead of them is
    // resolved. An operator waiting for detail that never arrives is worse
    // off than one told what would produce it.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_REPORT_LIMIT + 2 }, (_, k) => 600 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).not.toContain('described next tick');
    expect(said).toContain('does not rotate');
    expect(said).toContain('until an entry ahead of them is resolved');
    warn.mockRestore();
  });

  it('gives each undescribed id the value its guarded DELETE needs', async () => {
    // #2231 r8 `4036084570`. The clearing instruction is compare-and-delete
    // and wants the row's exact `last_seen_at`. Printing overflow entries as
    // bare ids named them while leaving them UNCLEARABLE by the documented
    // route — and since the described page does not rotate, unclearable
    // indefinitely. In practice that pushes a person toward the unguarded
    // delete this report spends a paragraph warning against.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ids = Array.from({ length: STALE_REPORT_LIMIT + 2 }, (_, k) => 900 + k);
    await apply(h, report({ examined: ids, unresolvable: ids }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // Every undescribed id carries its own GUARD value, not just an id — and
    // the guard is the per-observation token, not the whole-second timestamp
    // it replaced (#2231 r11 `4036569620`).
    const byId = guardTokens(h);
    for (const id of ids.slice(STALE_REPORT_LIMIT)) {
      const obs = byId.get(id);
      expect(obs).toMatch(/^[0-9a-f]{8}$/);
      // Named, and NOT carrying a half-built command: the values an overflow
      // entry needs come from the enquiry, and the finished command is shown
      // on the described entries (#2231 r14 `4037027842`).
      expect(said).toMatch(new RegExp(`\\b${id}\\b`));
      expect(said).not.toContain(`${id}@`);
    }
    // And what they can do about it is stated, with a finished enquiry.
    expect(said).toContain('AS clear_command FROM');
    expect(said).toContain('Being named is not being examined');
    expect(said).toContain('nothing above says what these ids point at now');
    warn.mockRestore();
  });

  it('still NAMES long-held rows when the release sweep fails', async () => {
    // #2213 r26 `4015927513`. r15 put the release before the report so the
    // report never names an already-resolvable row, and sharing one `try` was
    // the cost of that ordering: a recurring write failure returned before the
    // report ran, so every long-held row on every tick went unnamed while the
    // reads that would have named them were perfectly healthy.
    //
    // Broken maintenance hiding the disclosure is the worse half of the pair,
    // because the disclosure is what tells anyone the maintenance is broken.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [77, 78], unresolvable: [77], unread: [78] }), NOW);
    // THE SWEEP MUST HAVE WORK TO DO for its write to be the thing that fails
    // (#2231 r8). The sweep now reads a bounded roster first and returns
    // early when nothing is terminal, so a stub that throws on the DELETE is
    // never reached unless a releasable row exists — and a test that passes
    // because the code under test was skipped is not testing it. Loan 78 is
    // terminal and held, so the roster is non-empty and the delete is
    // attempted; loan 77 is the long-held orphan that must still be reported
    // once that delete has failed.
    seedLoanRow(h, 78, 'repaid');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    warn.mockClear();
    error.mockClear();
    // The release path throws; the reporting reads are untouched.
    const db = {
      prepare(sql: string) {
        if (/DELETE\s+FROM\s+loan_reconcile_quarantine/i.test(sql)) {
          throw new Error('D1_ERROR: write refused');
        }
        return h.d1.prepare(sql);
      },
      batch: (h.d1 as unknown as { batch: unknown }).batch,
    };
    // `NOW` is 2023, so the seeded row is long past the stale threshold
    // against the real clock this helper reads.
    _resetQuarantineWriteProbe();
    await _reportQuarantineForChain({ DB: db } as never, CHAIN);
    const said = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');
    // The failed cleanup is named...
    expect(said).toContain('RELEASE failed');
    // ...and the row is STILL reported, which is the whole point.
    expect(said).toContain('loan 77');
    warn.mockRestore();
    error.mockRestore();
  });

  it('calls the timestamp what it is — the last RECORDED sighting', async () => {
    // #2213 r23 `4015375760`. `last_seen_at` only moves when the upsert
    // SUCCEEDS, and this PR made a failed upsert both reachable and reported.
    // So a row examined minutes ago whose write failed keeps an older value,
    // and calling that "last examined" tells an operator the row is merely
    // waiting for the rotation — sending them away from a row whose
    // bookkeeping is broken. The column cannot distinguish the two; the label
    // must not pretend otherwise.
    const h = createSqliteD1(ALL_MIGRATIONS);
    await apply(h, report({ examined: [42], unresolvable: [42] }), NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1, true);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('last recorded unsettled');
    // The claim it must NOT make: that the row has not been looked at since.
    expect(said).not.toContain('last examined');
    warn.mockRestore();
  });
});

describe('how often the table is probed for', () => {
  /**
   * A `sqlite_master` read is a D1 binding call and therefore one of the
   * Worker's ~50 subrequests. The costs below are counted, not assumed.
   */
  /**
   * `present` may be `'legacy'`: the table is there but without 0053's guard
   * column, which is what a database looks like during the deploy window the
   * canonical runbook creates (#2231 r12 `4036719800`).
   *
   * The stub returns the table's DDL because that is what the probe reads —
   * it used to return `{ name }`, and a stub answering a question the code no
   * longer asks is how a probe test keeps passing while it has stopped
   * covering the probe.
   */
  function countingDb(present: boolean | 'legacy' | 'throws') {
    let probes = 0;
    const legacyDdl =
      `CREATE TABLE loan_reconcile_quarantine (chain_id INTEGER, loan_id INTEGER, ` +
      `reason TEXT, first_seen_at INTEGER, last_seen_at INTEGER)`;
    const currentDdl = legacyDdl.replace(/\)$/, `, obs TEXT NOT NULL DEFAULT '')`);
    return {
      probes: () => probes,
      db: {
        prepare() {
          return {
            async first<T>(): Promise<T | null> {
              probes += 1;
              if (present === 'throws') throw new Error('D1_ERROR: unavailable');
              if (present === 'legacy') return { sql: legacyDdl } as unknown as T;
              return present ? ({ sql: currentDdl } as unknown as T) : null;
            },
          };
        },
      },
    };
  }

  it('asks ONCE for a whole pass while the table is missing', async () => {
    // #2213 r28 `4016565774`. A negative answer was never cached, so during
    // the guaranteed deploy-before-migration window every terminal event
    // re-probed — and a close-out can reach the helper twice, once in its own
    // handler and again through the deferred status cleanup. A backfill with
    // enough close-outs spent the invocation's allowance on identical reads
    // and aborted before the cursor advanced, which is the rollout freeze the
    // guard exists to survive.
    const { db, probes } = countingDb(false);
    const probe = createQuarantineAvailability();
    probe.beginPass();
    for (let i = 0; i < 40; i++) expect(await probe(db)).toBe('absent');
    expect(probes()).toBe(1);
  });

  it('asks again on the NEXT pass, so a landed migration is noticed', async () => {
    // The other half, and the reason the scope is a pass rather than the
    // isolate: caching the absence for the isolate's life would leave this
    // Worker ignoring the quarantine after the migration landed, until it
    // happened to recycle, with nothing saying so.
    const { db, probes } = countingDb(false);
    const probe = createQuarantineAvailability();
    probe.beginPass();
    await probe(db);
    probe.beginPass();
    await probe(db);
    expect(probes()).toBe(2);
  });

  it('caches an UNKNOWN for the pass too — a failing probe is not free either', async () => {
    const { db, probes } = countingDb('throws');
    const probe = createQuarantineAvailability();
    probe.beginPass();
    for (let i = 0; i < 10; i++) expect(await probe(db)).toBe('unknown');
    expect(probes()).toBe(1);
  });

  it('keeps a PRESENT across passes — a table does not un-exist', async () => {
    const { db, probes } = countingDb(true);
    const probe = createQuarantineAvailability();
    probe.beginPass();
    await probe(db);
    probe.beginPass();
    expect(await probe(db)).toBe('present');
    expect(probes()).toBe(1);
  });

  it('keeps re-asking while the guard column has not landed yet', async () => {
    // #2231 r12 `4036719800`. A table without 0053's column is a database
    // mid-deploy, not a settled one. Latching `present` on the table alone
    // would leave the write path on the legacy shape for the life of the
    // isolate — long after the migration landed — so the probe stays curious
    // until BOTH are there, while still costing one read per pass.
    const { db, probes } = countingDb('legacy');
    const probe = createQuarantineAvailability();
    probe.beginPass();
    expect(await probe(db)).toBe('present');
    expect(await probe(db)).toBe('present');
    expect(probes()).toBe(1);
    expect(probe.guardColumn()).toBe(false);
    probe.beginPass();
    expect(await probe(db)).toBe('present');
    expect(probes()).toBe(2);
  });

  it('stops asking once BOTH the table and the guard column are there', async () => {
    const { db, probes } = countingDb(true);
    const probe = createQuarantineAvailability();
    probe.beginPass();
    await probe(db);
    expect(probe.guardColumn()).toBe(true);
    probe.beginPass();
    await probe(db);
    expect(probes()).toBe(1);
  });

  it('never lets a FAILED probe downgrade a guard it already saw', async () => {
    // The direction that matters: a hiccup must not send a healthy database's
    // write path back to the legacy shape, which would stop recording guards
    // and leave those rows unclearable by the documented route.
    let present: boolean | 'throws' = true;
    let probes = 0;
    const db = {
      prepare() {
        return {
          async first<T>(): Promise<T | null> {
            probes += 1;
            if (present === 'throws') throw new Error('D1_ERROR: unavailable');
            return {
              sql: `CREATE TABLE loan_reconcile_quarantine (chain_id INTEGER, obs TEXT)`,
            } as unknown as T;
          },
        };
      },
    };
    const probe = createQuarantineAvailability();
    probe.beginPass();
    await probe(db as never);
    expect(probe.guardColumn()).toBe(true);
    present = 'throws';
    probe.beginPass();
    await probe(db as never);
    expect(probe.guardColumn()).toBe(true);
    expect(probes).toBe(1);
  });

  it('caches NOTHING negative for a caller that never opens a pass', async () => {
    // The safety direction, and it is why `beginPass` opens the scope rather
    // than merely clearing it. Written the other way round, a lane that forgot
    // the call would latch `absent` for the life of its isolate and go on
    // ignoring the quarantine long after the migration landed — the failure
    // the no-caching rule existed to prevent, reintroduced by the fix for the
    // probe count. Forgetting must cost an extra read, never a stale answer.
    const { db, probes } = countingDb(false);
    const probe = createQuarantineAvailability();
    for (let i = 0; i < 5; i++) expect(await probe(db)).toBe('absent');
    expect(probes()).toBe(5);
  });
});
