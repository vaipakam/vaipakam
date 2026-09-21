import { describe, expect, it } from 'vitest';

// The reconciliation decision table from the cutover tool (#2214). It is a
// plain-Node operator script rather than Worker source, so it is imported
// by path; the module guards its own `main()` behind a direct-execution
// check precisely so this import cannot start carrying rows.
// @ts-expect-error — untyped .mjs operator script, imported for its one pure export
import { classifyForReconcile } from '../scripts/d1-carry-rows.mjs';

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

function classify(opts: {
  rows: Record<string, unknown>[];
  held: number[];
  mirrored: Record<string, unknown>[];
}) {
  const wasSeen: Record<string, string> = {};
  for (const r of opts.mirrored) wasSeen[k(r.id as number)] = hashOf(r);
  return classifyForReconcile({
    table: 't',
    cols,
    key,
    rows: opts.rows,
    sourceKeys: new Set(opts.rows.map((r) => k(r.id as number))),
    heldKeys: new Set(opts.held.map(k)),
    wasSeen,
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
      held: [1],
      mirrored: [{ id: 1, value: 'before' }],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('changed on the source after the mirror');
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
    // AUTOINCREMENT on both sides after the mirror: one id, two different
    // records. An insert would be a no-op and the source's record lost.
    const { insert, conflicts } = classify({
      rows: [{ id: 7, value: 'source record' }],
      held: [7],
      mirrored: [],
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('key allocated on both sides');
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
      heldKeys: new Set<string>(),
      wasSeen: null,
    });
    expect(insert).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('no record');
  });
});
