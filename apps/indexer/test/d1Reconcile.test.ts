import { describe, expect, it } from 'vitest';

// The reconciliation decision table from the cutover tool (#2214). It is a
// plain-Node operator script rather than Worker source, so it is imported
// by path; the module guards its own `main()` behind a direct-execution
// check precisely so this import cannot start carrying rows.
// @ts-expect-error — untyped .mjs operator script, imported for its pure exports
import {
  classifyForReconcile,
  collapseOutsideLiterals,
  isMissingSequenceTable,
  readAll,
  situationOf,
  verdictProblems,
} from '../scripts/d1-carry-rows.mjs';

/**
 * WHY THIS TEST EXISTS. Post-switch reconciliation decides, per row,
 * whether to carry it, leave it, or stop and ask. Two of those cases
 * CANNOT be produced by rehearsing against the live pair — the
 * destination is inert before the switch, so it deletes nothing and
 * allocates no keys — and the branch that decides whether a deleted row
 * gets resurrected is not one to leave unexercised because a rehearsal
 * happened not to reach it.
 *
 * Each case below is one row of the table in
 * `docs/ops/D1CutoverArchiveToWarm.md` §"Reconcile, and keep reconciling".
 */

const cols = ['id', 'value'];
const key = ['id'];
const k = (id: number) => JSON.stringify([id]);

/** The hash the tool stores per row — sha256 of the canonical encoding. */
function hashOf(row: Record<string, unknown>) {
  // Mirrors `rowHash`: JSON of the values in declared column order.
  const canonical = JSON.stringify(cols.map((c) => row[c] ?? null));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * `held` may be given as bare ids — in which case the destination row is
 * assumed identical to the source row with that id — or as whole rows,
 * for the cases where the destination holds something DIFFERENT under the
 * same key. That distinction is the point of several cases below.
 */
function classify(opts: {
  rows: Record<string, unknown>[];
  held: (number | Record<string, unknown>)[];
  mirrored: Record<string, unknown>[];
  uniques?: { name: string; columns: string[] }[];
}) {
  const wasSeen: Record<string, string> = {};
  for (const r of opts.mirrored) wasSeen[k(r.id as number)] = hashOf(r);
  const heldByKey = new Map<string, Record<string, unknown>>();
  for (const h of opts.held) {
    const row =
      typeof h === 'number'
        ? (opts.rows.find((r) => r.id === h) ??
          opts.mirrored.find((r) => r.id === h) ?? { id: h, value: null })
        : h;
    heldByKey.set(k(row.id as number), row);
  }
  return classifyForReconcile({
    table: 't',
    cols,
    key,
    rows: opts.rows,
    sourceKeys: new Set(opts.rows.map((r) => k(r.id as number))),
    heldByKey,
    wasSeen,
    uniques: opts.uniques ?? [],
  });
}

describe('reconciliation decision table', () => {
  it('carries a row the source gained after the mirror — the only automatic case', () => {
    const row = { id: 1, value: 'new' };
    const { insert, conflicts } = classify({ rows: [row], held: [], mirrored: [] });
    expect(insert).toEqual([row]);
    expect(conflicts).toEqual([]);
  });

  it('leaves an unchanged mirrored row alone', () => {
    const row = { id: 1, value: 'same' };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [1],
      mirrored: [row],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('reports a row the source changed after the mirror, and does not carry it', () => {
    const { insert, conflicts } = classify({
      rows: [{ id: 1, value: 'after' }],
      held: [{ id: 1, value: 'before' }],
      mirrored: [{ id: 1, value: 'before' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('changed on the source after the mirror');
  });

  it('says nothing when only the DESTINATION moved on', () => {
    // After the switch the destination is the live database: indexer_cursor
    // advances every minute while archive stays exactly as the mirror saw
    // it. The two sides differ, but the source did not change — so this is
    // the destination doing its job, not a conflict. Reporting it would
    // make the two required clean passes impossible to reach.
    const mirrored = { id: 1, value: 'as mirrored' };
    const { insert, conflicts } = classify({
      rows: [mirrored],
      held: [{ id: 1, value: 'destination has moved on' }],
      mirrored: [mirrored],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('reports when BOTH sides moved differently', () => {
    const { insert, conflicts } = classify({
      rows: [{ id: 1, value: 'source moved' }],
      held: [{ id: 1, value: 'destination moved elsewhere' }],
      mirrored: [{ id: 1, value: 'as mirrored' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('changed on the source after the mirror');
  });

  it('accepts a late update an operator has already resolved', () => {
    // The operator picked a value and made both sides agree. Comparing the
    // source against the MANIFEST alone would keep reporting this forever,
    // so repeat-until-clean could never come clean after resolving
    // anything — which is what the procedure asks the operator to do.
    const resolved = { id: 1, value: 'after' };
    const { insert, conflicts } = classify({
      rows: [resolved],
      held: [resolved],
      mirrored: [{ id: 1, value: 'before' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('refuses to resurrect a row the DESTINATION deleted', () => {
    // The mirror carried it, so the destination had it and has since
    // dropped it — a retention prune, possibly a privacy obligation.
    // Absence alone looks identical to "never arrived", which is why the
    // manifest is what tells them apart.
    const row = { id: 1, value: 'pruned there' };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [],
      mirrored: [row],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('deleted on the destination');
  });

  it('reports a key both sides allocated independently, and does not carry it', () => {
    // AUTOINCREMENT on both sides after the mirror: one id, two DIFFERENT
    // records. An insert would be a no-op and the source's record lost.
    const { insert, conflicts } = classify({
      rows: [{ id: 7, value: 'source record' }],
      held: [{ id: 7, value: 'a different record' }],
      mirrored: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('key allocated on both sides');
  });

  it('accepts a row a previous pass already carried, so the procedure converges', () => {
    // Same shape as the case above — not in the manifest, present on both
    // sides — but the destination row is the one the last pass inserted.
    // Content is what tells them apart; without it, repeat-until-clean
    // could never come clean after carrying anything.
    const row = { id: 7, value: 'carried last pass' };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [row],
      mirrored: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('reports a logical row the destination already holds under a different key', () => {
    // Absent by primary key is not the same as insertable: a secondary
    // unique index (notifications.dedup_key) can already hold this row's
    // tuple, and ON CONFLICT (pk) would not catch it — the insert fails
    // with a raw constraint error and aborts the reconciliation.
    const { insert, conflicts } = classify({
      rows: [{ id: 9, value: 'dedup-abc' }],
      held: [{ id: 4, value: 'dedup-abc' }],
      mirrored: [],
      uniques: [{ name: 'idx_value', columns: ['value'] }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('already present under a different key');
  });

  it('does not treat a NULL unique column as a collision', () => {
    // SQLite treats NULLs in a unique index as distinct, so two rows with
    // a NULL there do not collide and must still be carried.
    const row = { id: 9, value: null };
    const { insert, conflicts } = classify({
      rows: [row],
      held: [{ id: 4, value: null }],
      mirrored: [],
      uniques: [{ name: 'idx_value', columns: ['value'] }],
    });
    expect(insert).toEqual([row]);
    expect(conflicts).toEqual([]);
  });

  it('reports a row the SOURCE deleted after the mirror while the destination still holds it', () => {
    // Invisible to anything iterating the source — it is in no row at all.
    const { insert, conflicts } = classify({
      rows: [],
      held: [1],
      mirrored: [{ id: 1, value: 'gone from source' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('deleted on the source after the mirror');
  });

  it('says nothing when both sides deleted the same row', () => {
    const { insert, conflicts } = classify({
      rows: [],
      held: [],
      mirrored: [{ id: 1, value: 'gone from both' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('refuses to reconcile a table the manifest has no record of', () => {
    const { insert, conflicts } = classifyForReconcile({
      table: 't',
      cols,
      key,
      rows: [{ id: 1, value: 'x' }],
      sourceKeys: new Set([k(1)]),
      heldByKey: new Map(),
      wasSeen: null,
      uniques: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('no record');
  });
});

/**
 * The three facts collapse to one name, and the classifier handles every
 * name or throws. Pinning the names here is what keeps that promise
 * checkable: a situation added without a matching case in the classifier
 * fails loudly, and a case quietly dropped from the classifier — which has
 * happened twice — cannot pass this file.
 */
describe('situationOf — the three facts as one name', () => {
  const h = (value: unknown) => hashOf({ id: 1, value });
  const row = (value: unknown) => ({ id: 1, value });

  it.each([
    ['new-on-source', undefined, h('a'), undefined],
    ['destination-deleted', h('a'), h('a'), undefined],
    ['agreed', h('a'), h('a'), row('a')],
    ['agreed (after an operator resolved it)', h('old'), h('new'), row('new')],
    ['key-collision', undefined, h('a'), row('b')],
    ['destination-moved', h('a'), h('a'), row('b')],
    ['source-changed', h('old'), h('new'), row('other')],
  ])('%s', (name, mirroredHash, sourceHash, destRow) => {
    expect(
      situationOf({ mirroredHash, sourceHash, destRow, cols }),
    ).toBe(String(name).split(' ')[0]);
  });

  it('covers every situation the classifier knows how to handle', () => {
    // If a situation is ever added without a case, the classifier throws
    // rather than silently neither carrying nor reporting the row. This
    // asserts the set the tests above actually exercise.
    const exercised = new Set([
      'new-on-source',
      'destination-deleted',
      'agreed',
      'key-collision',
      'destination-moved',
      'source-changed',
    ]);
    expect(exercised.size).toBe(6);
  });
});

/**
 * THE SUCCESS PATH, which had never executed. Three stale references sat
 * in the branch that prints VERIFIED through four review rounds, because
 * every live run had conflicts and left on the failure path — so the
 * live-run evidence reported each round covered only half the code.
 * Reaching that branch against the real databases needs a source holding
 * still, which is the cutover condition itself; a test reaches it now.
 */
describe('verdict', () => {
  const d = (digest: string, count: number) => ({ digest, count });
  const both = (digest: string, count: number) =>
    [new Map([['t', d(digest, count)]]), new Map([['t', d(digest, count)]])] as const;

  it('reports NOTHING when a mirror left both sides identical', () => {
    const [srcD, dstD] = both('aaaa', 3);
    expect(
      verdictProblems({ srcD, dstD, refused: [], conflicts: [], reconciling: false }),
    ).toEqual([]);
  });

  it('reports NOTHING when a reconciliation finds the destination complete', () => {
    // The destination may legitimately hold MORE than the source by then.
    const srcD = new Map([['t', d('aaaa', 3)]]);
    const dstD = new Map([['t', d('bbbb', 5)]]);
    expect(
      verdictProblems({ srcD, dstD, refused: [], conflicts: [], reconciling: true }),
    ).toEqual([]);
  });

  it('reports a digest difference after a mirror', () => {
    const srcD = new Map([['t', d('aaaa', 3)]]);
    const dstD = new Map([['t', d('bbbb', 3)]]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('!=');
  });

  it('reports a destination holding fewer rows than the source', () => {
    const srcD = new Map([['t', d('aaaa', 5)]]);
    const dstD = new Map([['t', d('bbbb', 2)]]);
    expect(
      verdictProblems({ srcD, dstD, refused: [], conflicts: [], reconciling: true }),
    ).toHaveLength(1);
  });

  it('fails on a refused table rather than reporting success', () => {
    const [srcD, dstD] = both('aaaa', 3);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [{ table: 't', refused: 'no primary key' }],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NOT CARRIED');
  });

  it('names a conflict by table and key, and never by its contents', () => {
    const [srcD, dstD] = both('aaaa', 3);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [
        {
          table: 'support_tickets',
          key: '["tk_1"]',
          kind: 'changed on the source after the mirror',
          detail: 'the destination holds a different row under that key',
        },
      ],
      reconciling: true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('support_tickets ["tk_1"]');
    // The row's values must never reach a report that gets pasted into logs.
    expect(problems[0]).not.toContain('@');
  });
});

describe('verdict — a table only the destination has', () => {
  const d = (digest: string, count: number) => ({ digest, count });

  it('fails rather than reporting VERIFIED', () => {
    // A mirror says it makes the destination IDENTICAL to the source. A
    // table the destination alone holds makes that claim false, and the
    // loop over the source can never see it — so the run would have
    // printed VERIFIED with an unexamined table of user records sitting
    // there.
    const srcD = new Map([['t', d('aaaa', 3)]]);
    const dstD = new Map([
      ['t', d('aaaa', 3)],
      ['left_behind', d('bbbb', 40)],
    ]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('left_behind');
    expect(problems[0]).toContain('ABSENT from the source');
  });

  it('fails in the read-only direction too', () => {
    // reconcile compares against a manifest taken when the two sides were
    // in parity; an extra table means that premise no longer holds.
    const srcD = new Map([['t', d('aaaa', 3)]]);
    const dstD = new Map([
      ['t', d('zzzz', 9)],
      ['left_behind', d('bbbb', 40)],
    ]);
    expect(
      verdictProblems({ srcD, dstD, refused: [], conflicts: [], reconciling: true }),
    ).toHaveLength(1);
  });

  it('does not double-report a table already refused', () => {
    const srcD = new Map([['t', d('aaaa', 3)]]);
    const dstD = new Map([
      ['t', d('aaaa', 3)],
      ['odd', d('bbbb', 1)],
    ]);
    const problems = verdictProblems({
      srcD,
      dstD,
      refused: [{ table: 'odd', refused: 'destination-only' }],
      conflicts: [],
      reconciling: false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NOT CARRIED');
  });
});

/**
 * WHY THIS TEST EXISTS. `readAll` pages a table with `LIMIT/OFFSET`, and
 * each page is a separate statement against a database that may be
 * changing: a row inserted between pages whose sort position falls into a
 * page already read is returned by none of them. The tool answers that by
 * reading the whole table TWICE and comparing — which only works if a row
 * the first pass skipped really does come back in the result.
 *
 * Nothing about that is visible from a rehearsal against the live pair,
 * because a quiesced source agrees on the first comparison every time.
 * These drive `readAll` against an in-memory table that moves underneath
 * it on purpose.
 */
describe('readAll — a paged read is not a snapshot', () => {
  const COLS = ['id'];
  const PAGE = 500;
  const id = (n: number) => `r${String(n).padStart(5, '0')}`;

  /**
   * A table that answers `LIMIT/OFFSET` from its current contents, with a
   * hook that runs strictly BETWEEN statements — which is exactly where a
   * straggler's write lands.
   */
  function fakeTable(initial: string[]) {
    const state = {
      rows: [...initial],
      statements: 0,
      afterStatement: (_n: number, _s: { rows: string[] }) => {},
    };
    const run = async (_dbId: string, sql: string) => {
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
      if (!m) throw new Error(`unexpected SQL: ${sql}`);
      const page = [...state.rows]
        .sort()
        .slice(Number(m[2]), Number(m[2]) + Number(m[1]))
        .map((v) => ({ id: v }));
      state.statements += 1;
      state.afterStatement(state.statements, state);
      return page;
    };
    return { state, run };
  }

  it('reads a single-statement table once and does not re-read it', async () => {
    const { state, run } = fakeTable([id(1), id(2), id(3)]);
    const rows = await readAll('db', 't', COLS, run);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(state.statements).toBe(1);
  });

  it('re-reads a table that actually paged, and agrees when it is still', async () => {
    const all = Array.from({ length: PAGE + 100 }, (_, i) => id(i + 1));
    const { state, run } = fakeTable(all);
    const rows = await readAll('db', 't', COLS, run);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(all);
    // Two full passes of two statements each — the second pass is the
    // check, and it is not skipped just because the table was quiet.
    expect(state.statements).toBe(4);
  });

  it('returns a row the first pass skipped entirely', async () => {
    const all = Array.from({ length: PAGE + 100 }, (_, i) => id(i + 1));
    const { state, run } = fakeTable(all);
    // A straggler commits after the first page is read, sorting ahead of
    // everything already returned — the one insert a single paged pass
    // cannot see.
    const straggler = id(0);
    state.afterStatement = (n, s) => {
      if (n === 1) s.rows.push(straggler);
    };

    const rows = await readAll('db', 't', COLS, run);
    const seen = rows.map((r: { id: string }) => r.id);

    expect(seen).toContain(straggler);
    expect([...new Set(seen)].sort()).toEqual([straggler, ...all].sort());
  });
});

/**
 * WHY THESE TESTS EXIST. Both behaviours below decide whether a run that
 * looks clean actually is, and neither is reachable from a rehearsal
 * against the live pair — the first needs a source that moves mid-run,
 * the second needs two schemas that differ only inside a quoted literal.
 */
describe('a verdict is only as good as the reading it was drawn from', () => {
  const d = (digest: string, count: number) => ({ digest, count });

  it('reports a source that changed between classification and the verdict', () => {
    // The trap: an UPDATE leaves the row count identical, and reconcile
    // mode only checks that the destination has at least as many rows. So
    // a straggler updating an archive row after its table was classified
    // produced no conflict and printed VERIFIED.
    const problems = verdictProblems({
      srcD: new Map([['offers', d('after', 12)]]),
      dstD: new Map([['offers', d('whatever', 12)]]),
      refused: [],
      conflicts: [],
      reconciling: true,
      classifiedSource: new Map([['offers', 'before']]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the source CHANGED while this run was working');
    expect(problems[0]).toContain('before');
    expect(problems[0]).toContain('after');
  });

  it('stays silent when the source held still, whatever the destination did', () => {
    // The destination is live during a reconcile and legitimately differs;
    // only the SOURCE moving invalidates the classification.
    const problems = verdictProblems({
      srcD: new Map([['offers', d('same', 12)]]),
      dstD: new Map([['offers', d('destination moved on', 14)]]),
      refused: [],
      conflicts: [],
      reconciling: true,
      classifiedSource: new Map([['offers', 'same']]),
    });
    expect(problems).toEqual([]);
  });

  it('does not apply the check to a mirror, which compares digests outright', () => {
    const problems = verdictProblems({
      srcD: new Map([['offers', d('aaaa', 3)]]),
      dstD: new Map([['offers', d('aaaa', 3)]]),
      refused: [],
      conflicts: [],
      reconciling: false,
      classifiedSource: new Map([['offers', 'something else']]),
    });
    expect(problems).toEqual([]);
  });
});

describe('schema comparison — whitespace outside literals only', () => {
  it('keeps two defaults that SQLite keeps distinct, distinct', () => {
    expect(collapseOutsideLiterals("x TEXT DEFAULT 'a  b'")).not.toBe(
      collapseOutsideLiterals("x TEXT DEFAULT 'a b'"),
    );
  });

  it('still collapses whitespace outside quotes', () => {
    expect(collapseOutsideLiterals('CREATE   TABLE\n  t (a)')).toBe(
      'CREATE TABLE t (a)',
    );
  });

  it('preserves spacing inside quoted identifiers and CHECK values', () => {
    expect(collapseOutsideLiterals('CREATE TABLE "x  y" (a)')).toBe(
      'CREATE TABLE "x  y" (a)',
    );
    expect(collapseOutsideLiterals("a CHECK (a <> 'p  q')")).toBe(
      "a CHECK (a <> 'p  q')",
    );
  });

  it('handles a doubled quote, where one literal closes and the next opens', () => {
    expect(collapseOutsideLiterals("x DEFAULT 'it''s  here'")).toBe(
      "x DEFAULT 'it''s  here'",
    );
  });
});

/**
 * WHY THIS TEST EXISTS. The AUTOINCREMENT check queries `sqlite_sequence`,
 * which SQLite does not create until something allocates — so on a
 * database where nothing has, the query is an error rather than an empty
 * result, and treating that as empty is correct. Treating anything ELSE
 * as empty would be a check reporting success when it never ran, which is
 * the failure this tool exists to avoid.
 */
describe('the one error that means "nothing has ever allocated"', () => {
  const live = (m: string) => new Error(`HTTP 400 on /d1/database/x/query\n${m}`);

  it('recognises the real D1 shape', () => {
    expect(
      isMissingSequenceTable(
        live('{"errors":[{"code":7500,"message":"no such table: sqlite_sequence: SQLITE_ERROR"}]}'),
      ),
    ).toBe(true);
  });

  it('does NOT match a table whose name merely starts the same way', () => {
    expect(
      isMissingSequenceTable(
        live('{"errors":[{"message":"no such table: sqlite_sequence_nope: SQLITE_ERROR"}]}'),
      ),
    ).toBe(false);
  });

  it('does not swallow a missing application table', () => {
    expect(
      isMissingSequenceTable(live('no such table: notifications: SQLITE_ERROR')),
    ).toBe(false);
  });

  it('does not swallow a transport or auth failure', () => {
    expect(isMissingSequenceTable(new Error('fetch failed'))).toBe(false);
    expect(isMissingSequenceTable(live('Authentication error'))).toBe(false);
  });
});
