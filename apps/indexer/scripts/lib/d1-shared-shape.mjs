/**
 * The shape rule of check 1 in `check-d1-name-consistency.mjs`, as a pure
 * function so it can be tested (#2272).
 *
 * Two configurations are legitimate. In the normal one every consumer that
 * binds the shared database binds the same one, on both name and id. In the
 * CUTOVER BARRIER the three writers declare no `d1_databases` at all, so no
 * invocation can obtain a handle while the data is copied
 * (`docs/ops/D1CutoverArchiveToWarm.md`). Anything else is refused, and the
 * worst case is the half-applied barrier: one writer still bound while the
 * others are held keeps writing through a window every later cutover step
 * treats as closed.
 *
 * The barrier is an EMPTY `d1_databases`, not a missing `DB` entry (#2267
 * r22): a writer that keeps a complete attachment under another binding name
 * can still reach a database, so it is neither shape.
 *
 * The barrier branch runs in production once, during a maintenance window,
 * and the half-applied branch ideally never, so nothing but the tests re-runs
 * them. Keep this module free of file reads and process exits.
 */

/**
 * @typedef {{ binding?: string, database_name?: string, database_id?: string }} D1Entry
 * @typedef {{ file: string, binding: string }} Consumer
 *
 * @param {{
 *   consumers: Consumer[],
 *   writers: Set<string>,
 *   entriesOf: (file: string) => D1Entry[],
 * }} input  the shared consumers, the writer files the barrier holds, and the
 *   `d1_databases` list each file declares
 * @returns {{
 *   problems: string[],
 *   fatal: string | null,
 *   bound: { file: string, binding: string, entry: D1Entry }[],
 *   heldForCutover: boolean,
 *   shared: { name: string, id: string } | null,
 * }} `fatal` is set when no consumer binds the shared database, so there is
 *   nothing to compare against; `shared` is then null.
 */
export function resolveSharedShape({ consumers, writers, entriesOf }) {
  const problems = [];
  const bound = [];
  const unbound = [];
  for (const { file, binding } of consumers) {
    const entry = entriesOf(file).find((e) => e.binding === binding);
    if (entry?.database_name && entry?.database_id) bound.push({ file, binding, entry });
    else unbound.push({ file, binding, entry });
  }

  const heldWriters = [...writers].filter((f) => entriesOf(f).length === 0);
  const heldForCutover = heldWriters.length === writers.size;

  // A writer with a d1 array that has no `DB` in it is neither bound nor
  // held: it is attached to something under another name, which the barrier
  // does not permit and the normal shape does not describe.
  for (const file of writers) {
    const entries = entriesOf(file);
    if (entries.length === 0) continue;
    if (entries.some((e) => e.binding === 'DB')) continue;
    problems.push(
      `${file}: has ${entries.length} d1 binding(s) — ` +
        `${entries.map((e) => `"${e.binding}"`).join(', ')} — but none named ` +
        `"DB".\n    That is neither shape: not the normal one, which binds ` +
        `the shared database as "DB", and not the cutover barrier, which is ` +
        `an EMPTY d1_databases. A handle under another name is still a ` +
        `handle, and this Worker can still reach a database.`,
    );
  }

  for (const { file, binding, entry } of unbound) {
    if (heldForCutover && writers.has(file)) continue;
    problems.push(
      entry === undefined
        ? `${file}: no d1 binding named "${binding}"` +
            (writers.has(file)
              ? `.\n    ${heldWriters.length} of ${writers.size} writers declare ` +
                `no d1_databases at all, so this is not the cutover barrier — ` +
                `that shape needs ALL of them empty. A writer left attached ` +
                `while the others are held keeps writing through a window the ` +
                `procedure believes is closed.`
              : '')
        : `${file} (binding ${binding}) declares an incomplete d1 binding: ` +
            `name ${entry.database_name ?? '(missing)'}, id ` +
            `${entry.database_id ?? '(missing)'}. Half a binding names no database.`,
    );
  }

  if (bound.length === 0) {
    return {
      problems,
      fatal:
        `no consumer binds the shared database — not even ` +
        `${consumers.map((c) => c.file).find((f) => !writers.has(f))}, which is ` +
        `not part of the cutover barrier. There is nothing to check against.`,
      bound,
      heldForCutover,
      shared: null,
    };
  }

  // The shared database is whatever the bound consumers agree on. Two
  // distinct pairs IS the half-applied cutover, reported per consumer against
  // the majority so the message names which file to move.
  const pairs = new Map();
  for (const c of bound) {
    const k = `${c.entry.database_name}\u0000${c.entry.database_id}`;
    pairs.set(k, [...(pairs.get(k) ?? []), c]);
  }
  const [agreed] = [...pairs.values()].sort((a, b) => b.length - a.length);
  const shared = { name: agreed[0].entry.database_name, id: agreed[0].entry.database_id };

  for (const { file, binding, entry } of bound) {
    const nameOk = entry.database_name === shared.name;
    const idOk = entry.database_id === shared.id;
    if (nameOk && idOk) continue;
    problems.push(
      `${file} (binding ${binding}) disagrees with the other consumers:\n` +
        `    name: ${entry.database_name} ${nameOk ? '(ok)' : `!= ${shared.name}`}\n` +
        `    id:   ${entry.database_id} ${idOk ? '(ok)' : `!= ${shared.id}`}\n` +
        `    ${
          nameOk !== idOk
            ? 'One field matches and the other does not — this is a ' +
              'half-applied cutover, the shape that silently splits ' +
              'migrations from reads.'
            : 'This Worker binds a different database entirely.'
        }`,
    );
  }

  return { problems, fatal: null, bound, heldForCutover, shared };
}
