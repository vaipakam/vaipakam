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

/**
 * Assert an EXACT ledger: every watched balance change equals the expected
 * map (keys `token.holder`, values in base units, absent = 0), so an
 * unexpected movement fails as surely as a wrong amount. A fund-moving step
 * asserted any looser than this — "the loan's lender changed", "collateral
 * went down" — certifies the state rewrite while the money could be wrong.
 */
export function expectLedger(id, name, before, after, expected, note = '') {
  const watched = new Set([...Object.keys(before), ...Object.keys(after)]);
  const wrong = [];
  for (const k of watched) {
    const got = (after[k] ?? 0n) - (before[k] ?? 0n);
    const want = expected[k] ?? 0n;
    if (got !== want) wrong.push(`${k}: got ${got} want ${want}`);
  }
  for (const k of Object.keys(expected)) if (!watched.has(k)) wrong.push(`${k}: expected a movement on an unwatched balance`);
  const shown = Object.entries(expected).filter(([, v]) => v !== 0n).map(([k, v]) => `${k}=${v}`).join(' ');
  return check(id, name, wrong.length === 0, (wrong.length ? `MISMATCH ${wrong.join('; ')}` : `exact: ${shown}`) + (note ? ` (${note})` : ''));
}

/**
 * Assert a REFUSAL by name. A refusal row that accepts any revert certifies
 * whichever guard happened to fire — so when the guard under test is removed,
 * a later, unrelated check (an empty route, a missing allowance, the health
 * bound) keeps the row green. `res` is a `simulate()` result (`name`) or an
 * accept result (`reason`); the error's name is compared up to its arguments.
 */
export function expectRefusal(id, name, res, errorName, detail = '') {
  const got = res.ok ? null : String(res.name ?? res.reason ?? '');
  const ok = got !== null && got.split('(')[0] === errorName;
  return check(id, name, ok, `${got === null ? 'NOT refused' : got}${ok ? '' : ` (want ${errorName})`}${detail ? ` — ${detail}` : ''}`);
}

/** Record an observation with no assertion behind it; always INFO. */
export function observe(id, name, detail = '') {
  return push(id, name, 'INFO', detail);
}

/** Throw so the runner records the file as ABORTED — a flow that cannot continue. */
export function cannotContinue(step, why) {
  throw new Error(`${step}: ${why}`);
}

/**
 * Declare a scenario's ENVELOPE: a configuration value its fixed inputs were
 * written for. Every configurable number a scenario ASSERTS against is read
 * from the chain; the few it cannot cheaply derive — the size of a probe, the
 * topology a ledger is written for — are instead declared here, checked
 * against the live configuration, and a deployment outside them stops the
 * file NAMING the knob. That is neither a PASS nor a protocol FAIL: it says
 * this scenario did not run on this configuration, and why.
 *
 * One mechanism instead of scaling every input for every valid setting,
 * which is an edge list with no end.
 */
export function requireEnvelope(knob, ok, detail) {
  if (typeof ok !== 'boolean') throw new TypeError(`requireEnvelope(${knob}): condition must be a boolean`);
  if (ok) return;
  const e = new Error(`OUT OF ENVELOPE — ${knob}: ${detail}`);
  e.outOfEnvelope = true;
  throw e;
}

export const ledger = () => rows.slice();

/** Ledger position, so the runner can set aside rows from a file that aborts. */
export const mark = () => rows.length;

/**
 * Remove and return every row recorded since `at`. The runner does this for
 * an ABORTED file: the chain is reverted to before the file, so its rows
 * describe state that no longer exists and must not count in the verdict.
 * They are kept in `last-run.json` under the aborted file, for diagnosis.
 */
export const takeSince = (at) => rows.splice(at);

export function summarise() {
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`\n${rows.length} scenarios — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  return counts;
}
