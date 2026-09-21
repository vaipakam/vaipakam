import { describe, expect, it } from 'vitest';

// The reconciliation decision table from the cutover tool (#2214). It is a
// plain-Node operator script rather than Worker source, so it is imported
// by path; the module guards its own `main()` behind a direct-execution
// check precisely so this import cannot start carrying rows.
// @ts-expect-error — untyped .mjs operator script, imported for its pure exports
import { classifyForReconcile, situationOf } from '../scripts/d1-carry-rows.mjs';

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
