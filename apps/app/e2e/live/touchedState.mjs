/**
 * THE TOUCHED-STATE LEDGER (#2422 r6).
 *
 * A signing drive changes on-chain state, and when it fails partway the
 * operator needs to know exactly what it changed and how to put it back.
 * `live-refinance.mjs`'s earlier failure report covered the request and the
 * borrower's allowance — and four review findings were the same gap from
 * four sides: a pre-run allowance it told the operator to zero, the
 * lender's leftover approval it never mentioned, the loan's auto-refinance
 * caps it never mentioned, and the request itself. The fix is structural:
 *
 *   - every piece of state a write-plan step can change is a LEDGER ENTRY,
 *     declared with the plan steps that touch it, how to read it, how to
 *     print it, and how to RESTORE it to a baseline;
 *   - the preflight snapshots every entry at the pinned block (the
 *     BASELINE), before any write;
 *   - after a failure every entry is re-read, and this module decides, per
 *     entry, what to say.
 *
 * The rules (`ledgerRows`):
 *   - a read that failed, at either end    → UNKNOWN: read it by hand;
 *   - now equals baseline                  → UNCHANGED: no remedy, even if
 *     a step touched it (it is back where it started);
 *   - changed, and a CONSUMED step touches → CHANGED BY THIS RUN: the
 *     it                                     remedy RESTORES THE BASELINE —
 *                                            never a blanket zero, so a
 *                                            grant that predates the run is
 *                                            put back, not erased;
 *   - changed, but no consumed step        → CHANGED, NOT BY THIS RUN: no
 *     touches it                             remedy — this run did not do
 *                                            it, so it is not this run's to
 *                                            undo.
 * An entry's `restore` may return null when the change cannot be undone
 * (a completed refinance); the row then says so instead of offering a fix.
 *
 * Pure: reads happen in the caller; this module only compares and words.
 * `touchedState.test.mjs` pins every rule.
 */

/**
 * @typedef {object} LedgerEntry
 * @property {string} key
 * @property {string} label
 * @property {string[]} touchedBy        plan step ids that can change it
 * @property {(v: any) => string} format
 * @property {(a: any, b: any) => boolean} [equal]   default: deep-ish equality
 * @property {(baseline: any, now: any) => string|null} restore
 *
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} Reading
 */

const defaultEqual = (a, b) => stable(a) === stable(b);
function stable(v) {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
}

/**
 * @param {LedgerEntry[]} entries
 * @param {Record<string, Reading>} baseline  by entry key
 * @param {Record<string, Reading>} now       by entry key
 * @param {Set<string>|string[]} consumedStepIds
 * @returns {Array<{ key: string, label: string, status: 'unknown'|'unchanged'|'changed-by-run'|'changed-not-by-run',
 *   baselineText: string, nowText: string, touchedSteps: string[], remedy: string|null }>}
 */
export function ledgerRows(entries, baseline, now, consumedStepIds) {
  const consumed = new Set(consumedStepIds);
  return entries.map((e) => {
    const b = baseline?.[e.key];
    const n = now?.[e.key];
    const touchedSteps = e.touchedBy.filter((id) => consumed.has(id));
    const text = (r) => (r?.ok ? e.format(r.value) : `UNREADABLE (${r?.error ?? 'not read'})`);
    const row = { key: e.key, label: e.label, baselineText: text(b), nowText: text(n), touchedSteps };
    if (!b?.ok || !n?.ok) {
      return { ...row, status: 'unknown', remedy: `could not be compared — read ${e.label} by hand` };
    }
    if ((e.equal ?? defaultEqual)(b.value, n.value)) {
      return { ...row, status: 'unchanged', remedy: null };
    }
    if (touchedSteps.length === 0) {
      return { ...row, status: 'changed-not-by-run', remedy: null };
    }
    const restore = e.restore(b.value, n.value);
    return {
      ...row,
      status: 'changed-by-run',
      remedy: restore ?? 'cannot be restored by a single action (see the state above)',
    };
  });
}

/** One printable block per row. */
export function formatLedgerRow(r) {
  const head = {
    unknown: 'UNKNOWN',
    unchanged: 'unchanged by this run',
    'changed-by-run': `CHANGED BY THIS RUN (${r.touchedSteps.join(', ')})`,
    'changed-not-by-run': 'changed since preflight, but by no write of this run — not this run’s to undo',
  }[r.status];
  const lines = [`${r.label}: ${head}`, `  baseline: ${r.baselineText}`, `  now:      ${r.nowText}`];
  if (r.remedy) lines.push(`  REMEDY:   ${r.remedy}`);
  return lines.join('\n');
}
