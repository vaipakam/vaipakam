/**
 * Did the inputs that make a lender SALE ROW JUMPABLE actually CHANGE
 * during a probe?
 *
 * Extracted from `live-position-observe.mjs` so it can be regression-
 * tested (Codex #1853 r13). It had shipped through four review rounds
 * unexercised: the live chain carries no jumpable lender row, so every
 * "re-ran live, 3/3 clean" this driver reported had never once entered
 * the code path this function guards. `jumpability.test.mjs` is what
 * actually checks it, and it caught the `await` bug below on the first
 * run.
 *
 * SYNCHRONOUS ON PURPOSE. The version this replaces was declared
 * `async` while awaiting nothing, and the call site forgot the `await`.
 * `moved` was then always a truthy Promise, so every zero-jump case
 * exited BLOCKED with `[object Promise]` as its reason and the
 * no-op-switch FAIL beneath it was UNREACHABLE — the branch three
 * rounds of review had been spent getting right could not fire. A pure
 * comparison over two plain objects has no reason to be a Promise, and
 * a function that is not `async` cannot be mis-awaited.
 */

/**
 * @typedef {object} JumpabilitySnapshot
 * @property {boolean} active   loan status is exactly Active
 * @property {boolean} matured  chain time has reached start + duration
 * @property {boolean} locked   the lender position token carries a lock
 * @property {string|null} holder lowercased lender authority, null if burned
 * @property {boolean} flagged  the observed wallet is sanctions-flagged
 */

/**
 * A BEFORE/AFTER comparison, not a post-hoc read of the current state
 * (Codex #1853 r12). The version before that read only the state AFTER
 * the click and called any unjumpable value a race — so a candidate
 * that was ALREADY FallbackPending (which lender eligibility explicitly
 * admits), already past maturity, or already locked before the page
 * rendered got reported as "left Active during the probe" and exited
 * BLOCKED. Nothing had moved.
 *
 * That is the direction that hides a real defect: if a Basic-mode
 * regression wrongly offered the switch on such a position, clicking it
 * yields no jumps, and the drive would excuse the contradiction as a
 * race instead of failing on it.
 *
 * NOT the same question as `stillEligible`, which asks whether the CARD
 * may mount and is deliberately loose — it accepts FallbackPending and
 * past maturity, because the wait row stays true either way (Codex
 * #1853 r9). This asks the strict question, so its inputs are a
 * SUPERSET of that one's: status, maturity, lock, holder, sanctions.
 *
 * Deliberately a subset of everything `buildLenderExitRows` consults. A
 * complete model would be a shadow copy of that module living in a test
 * harness — precisely the defect class this PR chain is about — so
 * anything uncovered still reports as the no-op-switch FAIL, which is
 * the honest failure for "we cannot explain this".
 *
 * @param {JumpabilitySnapshot|null} before
 * @param {JumpabilitySnapshot|null} after
 * @returns {string|null} a human-readable reason, or null if nothing moved
 */
export function jumpabilityMoved(before, after) {
  if (!before || !after) return null;
  if (before.active && !after.active) return 'loan left Active during the probe';
  if (!before.matured && after.matured) return 'loan reached maturity during the probe';
  if (!before.locked && after.locked) return 'position became locked during the probe';
  if (before.holder !== after.holder) {
    return after.holder === null
      ? 'lender token burned during the probe'
      : 'position transferred during the probe';
  }
  if (!before.flagged && after.flagged) return 'holder sanctions-flagged during the probe';
  return null;
}
