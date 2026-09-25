/**
 * Scenario ledger.
 *
 * A row is exactly one of two things, and the API makes it impossible to be
 * anything else:
 *
 *  - an ASSERTION — `check(id, name, ok)` / `expectEq(...)`. Its verdict is
 *    PASS or FAIL and nothing in between. There is no way to write a PASS
 *    without a condition behind it.
 *  - an OBSERVATION — `observe(id, name, detail)`. Always INFO. It records
 *    something real that has no expectation worth failing on (a deployment's
 *    configured value, a shape worth writing down).
 *
 * The earlier API took the verdict as a free string, and that is how the
 * ledger grew rows that printed a number under a hard-coded 'PASS', and rows
 * whose FAILURE branch was 'INFO' — a regression on either reads as green.
 * A flow that cannot continue (an accept that should have gone through, a
 * close that should have been simulatable) is neither: it THROWS, and
 * `run-all.mjs` names the file as aborted and exits non-zero.
 */
const rows = [];

function push(id, name, status, detail) {
  rows.push({ id, name, status, detail });
  console.log(`[${status}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  return rows[rows.length - 1];
}

/** Assert `ok`; PASS or FAIL. */
export function check(id, name, ok, detail = '') {
  if (typeof ok !== 'boolean') throw new TypeError(`check(${id}): condition must be a boolean, got ${typeof ok}`);
  return push(id, name, ok ? 'PASS' : 'FAIL', detail);
}

/** Assert equality and record the comparison either way. */
export function expectEq(id, name, got, want, note = '') {
  return check(id, name, String(got) === String(want), `got=${got} want=${want}${note ? ` (${note})` : ''}`);
}

/** Record an observation with no assertion behind it; always INFO. */
export function observe(id, name, detail = '') {
  return push(id, name, 'INFO', detail);
}

/** Throw so the runner records the file as ABORTED — a flow that cannot continue. */
export function cannotContinue(step, why) {
  throw new Error(`${step}: ${why}`);
}

export const ledger = () => rows.slice();

export function summarise() {
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`\n${rows.length} scenarios — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  return counts;
}
