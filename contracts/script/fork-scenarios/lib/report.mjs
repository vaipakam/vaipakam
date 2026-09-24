/**
 * Scenario ledger.
 *
 * Every scenario records an outcome with an explicit verdict. `INFO` exists
 * on purpose: a scenario that OBSERVED something real but had no assertion
 * worth failing on must say so rather than be silently dropped or dressed up
 * as a pass.
 */
const rows = [];

export function record(id, name, status, detail = '') {
  rows.push({ id, name, status, detail });
  const line = `[${status}] ${id} ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  return rows[rows.length - 1];
}

/** Assert equality and record the comparison either way. */
export function expectEq(id, name, got, want, note = '') {
  const ok = String(got) === String(want);
  return record(id, name, ok ? 'PASS' : 'FAIL', `got=${got} want=${want}${note ? ` (${note})` : ''}`);
}

export const ledger = () => rows.slice();

export function summarise() {
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`\n${rows.length} scenarios — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  return counts;
}
