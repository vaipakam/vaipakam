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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1);
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
    expect(said).toContain('AND last_seen_at = <the value');
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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1);
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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    // The three past the described page are named individually.
    for (const id of ids.slice(STALE_REPORT_LIMIT)) {
      expect(said).toContain(String(id));
    }
    expect(said).toContain('also holding reminders back');
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
    await apply(h, report({ examined: [77], unresolvable: [77] }), NOW);
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
    await reportStaleQuarantine(h.d1 as never, CHAIN, NOW + QUARANTINE_STALE_SECONDS + 1);
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
  function countingDb(present: boolean | 'throws') {
    let probes = 0;
    return {
      probes: () => probes,
      db: {
        prepare() {
          return {
            async first<T>(): Promise<T | null> {
              probes += 1;
              if (present === 'throws') throw new Error('D1_ERROR: unavailable');
              return present ? ({ name: 'loan_quarantine' } as unknown as T) : null;
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
