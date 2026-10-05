/**
 * THE OUTCOME MANIFEST — what a live drive's verdict actually claims
 * (#2422 r8).
 *
 * A bare "ALL CHECKS PASSED" says that every check which RAN passed. It
 * does not say which claims those checks substantiate, and it is silent
 * about everything no check looked at — which a reader of the verdict, or
 * of a release note citing it, then fills in with "and the rest worked
 * too". This module replaces that line with one data structure that
 * states both halves:
 *
 *   VERIFIED — each claim, with the reads that substantiated it. A claim
 *     declares the CHECKS it consists of (each with the read behind it),
 *     and prints as verified only when EVERY declared check was recorded
 *     and every recording passed. A claim with one check missing is
 *     NOT RUN, never verified; a check recorded against a claim or key the
 *     manifest does not declare throws, so evidence cannot be filed under a
 *     claim it was not declared for.
 *   NOT VERIFIED BY THIS DRIVER — each claim the drive does NOT
 *     substantiate, with the reason and where it IS covered (a named test)
 *     or "not covered". Some are static (declared up front); others move
 *     here at runtime via `defer`, when the drive meets a case its model
 *     does not cover — stated, with the reason, rather than passed.
 *
 * A third outcome, UNDETERMINED (#2422 r9), is for a check that RAN after
 * the irreversible write but whose model premises did not hold — a fee
 * posture the model does not cover, another transaction in the same block
 * touching the state it diffs, a block whose receipts could not be read. It
 * is distinct from FAILED: nothing was observed to be wrong; the claim could
 * not be substantiated, and the manifest says why. It is recorded per check
 * (`undetermined`), always with a reason.
 *
 * `passed()` is true only when no claim FAILED and no verifiable claim is
 * NOT RUN. Deferred, static not-verified and UNDETERMINED claims do not fail
 * a run; they are printed as exactly what they are, and `undeterminedCount()`
 * lets the verdict say so instead of printing a plain PASS.
 *
 * Pure; `outcomeManifest.test.mjs` pins the rules.
 */

/**
 * @typedef {object} VerifiableClaim
 * @property {string} id
 * @property {string} claim                      the sentence the verdict asserts
 * @property {Record<string, string>} checks     key → the read that substantiates it
 *
 * @typedef {object} NotVerifiedClaim
 * @property {string} id
 * @property {string} claim
 * @property {string} reason                     why this driver does not verify it
 * @property {string|null} coveredBy             a named test, or null = not covered
 */

const STATUS_ORDER = ['verified', 'failed', 'not run', 'undetermined', 'not verified'];

/**
 * @param {{ verifiable: VerifiableClaim[], notVerified?: NotVerifiedClaim[] }} spec
 */
export function createManifest({ verifiable, notVerified = [] }) {
  const ids = new Set();
  const claims = new Map();
  const declare = (id) => {
    if (typeof id !== 'string' || id === '') throw new Error(`manifest: a claim needs an id (${JSON.stringify(id)})`);
    if (ids.has(id)) throw new Error(`manifest: claim "${id}" declared twice`);
    ids.add(id);
  };
  for (const c of verifiable) {
    declare(c.id);
    const keys = Object.keys(c.checks ?? {});
    if (keys.length === 0) throw new Error(`manifest: claim "${c.id}" declares no checks — it could never be verified`);
    claims.set(c.id, {
      id: c.id,
      claim: c.claim,
      kind: 'verifiable',
      checks: new Map(keys.map((k) => [k, { read: c.checks[k], records: [] }])),
      deferred: null,
    });
  }
  for (const c of notVerified) {
    declare(c.id);
    if (!c.reason) throw new Error(`manifest: not-verified claim "${c.id}" needs a reason`);
    claims.set(c.id, {
      id: c.id,
      claim: c.claim,
      kind: 'static',
      deferred: { reason: c.reason, coveredBy: c.coveredBy ?? null },
    });
  }

  const verifiableClaim = (id) => {
    const c = claims.get(id);
    if (!c) throw new Error(`manifest: no claim "${id}" is declared`);
    if (c.kind !== 'verifiable') throw new Error(`manifest: claim "${id}" is declared NOT VERIFIED — nothing may be recorded against it`);
    return c;
  };

  /** Record one check's result under a declared claim and key. */
  function record(id, key, ok, evidence) {
    const c = verifiableClaim(id);
    const k = c.checks.get(key);
    if (!k) throw new Error(`manifest: claim "${id}" declares no check "${key}"`);
    k.records.push({ ok: ok === true, evidence: String(evidence ?? '') });
    return ok === true;
  }

  /**
   * Record that a declared check RAN but could not be substantiated, and
   * why (#2422 r9). Never a failure; never a pass. A reason is required.
   */
  function undetermined(id, key, reason) {
    const c = verifiableClaim(id);
    const k = c.checks.get(key);
    if (!k) throw new Error(`manifest: claim "${id}" declares no check "${key}"`);
    if (!reason) throw new Error(`manifest: an undetermined check ("${id}.${key}") needs a reason`);
    k.records.push({ ok: null, undetermined: String(reason), evidence: `UNDETERMINED — ${reason}` });
  }

  /**
   * Move a verifiable claim to NOT VERIFIED at runtime: the drive met a
   * case its model does not substantiate. A claim that already FAILED stays
   * failed — deferring never hides a failure.
   */
  function defer(id, reason, coveredBy = null) {
    const c = verifiableClaim(id);
    if (!reason) throw new Error(`manifest: deferring "${id}" needs a reason`);
    c.deferred = { reason, coveredBy };
  }

  function statusOf(c) {
    if (c.kind === 'static') return 'not verified';
    const all = [...c.checks.values()];
    if (all.some((k) => k.records.some((r) => r.ok === false))) return 'failed';
    if (c.deferred) return 'not verified';
    if (all.some((k) => k.records.length === 0)) return 'not run';
    if (all.some((k) => k.records.some((r) => r.undetermined))) return 'undetermined';
    return 'verified';
  }
  const checkStatus = (k) =>
    k.records.length === 0
      ? 'not run'
      : k.records.some((r) => r.ok === false)
        ? 'failed'
        : k.records.some((r) => r.undetermined)
          ? 'undetermined'
          : 'passed';

  /** One row per claim, in declaration order. */
  function rows() {
    return [...claims.values()].map((c) => ({
      id: c.id,
      claim: c.claim,
      status: statusOf(c),
      checks:
        c.kind === 'static'
          ? []
          : [...c.checks.entries()].map(([key, k]) => ({
              key,
              read: k.read,
              status: checkStatus(k),
              evidence: k.records.map((r) => r.evidence),
            })),
      reason: c.deferred?.reason ?? null,
      coveredBy: c.deferred?.coveredBy ?? null,
    }));
  }

  const passed = () => rows().every((r) => ['verified', 'not verified', 'undetermined'].includes(r.status));
  const undeterminedCount = () => rows().filter((r) => r.status === 'undetermined').length;

  /** The manifest as printable lines, grouped by status. */
  function render() {
    const all = rows();
    const out = ['=== OUTCOME MANIFEST ==='];
    const heading = {
      verified: 'VERIFIED',
      failed: 'FAILED',
      'not run': 'NOT RUN (a declared check never ran — the claim is not substantiated)',
      undetermined:
        'UNDETERMINED (each check ran after the write, but its premises did not hold — the claim could not be substantiated either way)',
      'not verified': 'NOT VERIFIED BY THIS DRIVER',
    };
    for (const status of STATUS_ORDER) {
      const group = all.filter((r) => r.status === status);
      if (group.length === 0) continue;
      out.push('', `${heading[status]} (${group.length}):`);
      for (const r of group) {
        out.push(`  [${r.id}] ${r.claim}`);
        for (const k of r.checks) {
          if (status === 'not verified' && k.status === 'not run') continue;
          const mark = { passed: 'ok  ', failed: 'FAIL', undetermined: '??  ', 'not run': '--  ' }[k.status];
          out.push(`      ${mark} ${k.key}: ${k.read}`);
          for (const e of k.evidence) out.push(`             ${e}`);
        }
        if (status === 'not verified') {
          out.push(`      why not: ${r.reason}`);
          out.push(`      covered by: ${r.coveredBy ?? 'not covered'}`);
        }
      }
    }
    return out;
  }

  return { record, undetermined, defer, rows, passed, undeterminedCount, render };
}
