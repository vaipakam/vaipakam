/**
 * #2272 — the shape rule of `check-d1-name-consistency`. The cutover barrier
 * runs in production once and the half-applied shape ideally never, so these
 * tests are what keeps an edit to the rule from silently taking either out.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations.
import { resolveSharedShape } from '../scripts/lib/d1-shared-shape.mjs';

type Entry = { binding?: string; database_name?: string; database_id?: string };

const WARM = { binding: 'DB', database_name: 'vaipakam-warm', database_id: 'id-warm' };
const ARCHIVE_READ = { binding: 'DB_ARCHIVE', database_name: 'vaipakam-warm', database_id: 'id-warm' };

const consumers = [
  { file: 'indexer', binding: 'DB' },
  { file: 'keeper', binding: 'DB' },
  { file: 'agent', binding: 'DB' },
  { file: 'backup', binding: 'DB_ARCHIVE' },
];
const writers = new Set(['indexer', 'keeper', 'agent']);

const run = (entries: Record<string, Entry[]>) =>
  resolveSharedShape({ consumers, writers, entriesOf: (f: string) => entries[f] ?? [] });

describe('check-d1-name-consistency shape rule', () => {
  it('normal: every consumer binds the same database', () => {
    const r = run({ indexer: [WARM], keeper: [WARM], agent: [WARM], backup: [ARCHIVE_READ] });
    expect(r.problems).toEqual([]);
    expect(r.fatal).toBeNull();
    expect(r.heldForCutover).toBe(false);
    expect(r.shared).toEqual({ name: 'vaipakam-warm', id: 'id-warm' });
    expect(r.bound).toHaveLength(4);
  });

  it('barrier: all three writers declare no d1_databases, the reader still binds', () => {
    const r = run({ indexer: [], keeper: [], agent: [], backup: [ARCHIVE_READ] });
    expect(r.problems).toEqual([]);
    expect(r.fatal).toBeNull();
    expect(r.heldForCutover).toBe(true);
    expect(r.bound.map((b: { file: string }) => b.file)).toEqual(['backup']);
  });

  it('half-applied barrier: one writer still bound while the others are held is refused', () => {
    const r = run({ indexer: [WARM], keeper: [], agent: [], backup: [ARCHIVE_READ] });
    expect(r.heldForCutover).toBe(false);
    expect(r.problems).toHaveLength(2);
    for (const p of r.problems) {
      expect(p).toMatch(/2 of 3 writers declare no d1_databases at all, so this is not the cutover barrier/);
    }
  });

  it('a writer attached under another binding name is neither shape', () => {
    const renamed = { ...WARM, binding: 'DB_OLD' };
    const r = run({ indexer: [renamed], keeper: [renamed], agent: [renamed], backup: [ARCHIVE_READ] });
    expect(r.heldForCutover).toBe(false);
    expect(r.problems.filter((p: string) => /but none named "DB"/.test(p))).toHaveLength(3);
  });

  it('two bound consumers naming different databases are reported against the majority', () => {
    const other = { binding: 'DB', database_name: 'vaipakam-archive', database_id: 'id-archive' };
    const r = run({ indexer: [WARM], keeper: [WARM], agent: [other], backup: [ARCHIVE_READ] });
    expect(r.shared).toEqual({ name: 'vaipakam-warm', id: 'id-warm' });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^agent \(binding DB\) disagrees/);
    expect(r.problems[0]).toMatch(/different database entirely/);
  });

  it('a name that matches with an id that does not is the half-applied cutover', () => {
    const idMoved = { ...WARM, database_id: 'id-new' };
    const r = run({ indexer: [WARM], keeper: [WARM], agent: [idMoved], backup: [ARCHIVE_READ] });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/One field matches and the other does not/);
  });

  it('a binding with a name and no id names no database', () => {
    const noId = { binding: 'DB', database_name: 'vaipakam-warm' };
    const r = run({ indexer: [WARM], keeper: [noId], agent: [WARM], backup: [ARCHIVE_READ] });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^keeper \(binding DB\) declares an incomplete d1 binding/);
    expect(r.problems[0]).toMatch(/id \(missing\)/);
  });

  it('no bound consumer at all is fatal: there is nothing to compare against', () => {
    const r = run({ indexer: [], keeper: [], agent: [], backup: [] });
    expect(r.shared).toBeNull();
    expect(r.fatal).toMatch(/no consumer binds the shared database — not even backup/);
  });
});
