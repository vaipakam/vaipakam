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
 * @property {boolean} [fallbackPending] status is FallbackPending — not
 *   Active, but the card stays mounted to explain it
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

/**
 * Was this snapshot itself jumpable — could a sale row have been offered
 * on the state it records?
 *
 * The companion to `jumpabilityMoved`, and it answers the question that
 * one structurally cannot (Codex #1853 r14). `PositionDetails` refreshes
 * the live status on a 30-second interval, so the Basic switch can stay
 * rendered from an earlier Active read for up to that long after the
 * chain has moved. If the transition happens BEFORE the pre-state
 * snapshot, both reads record the new unjumpable state, nothing has
 * "moved" between them, and a perfectly healthy stale render lands on
 * the no-op-switch product FAIL.
 *
 * Ordering the snapshot earlier cannot close that — the page rendered
 * before the drive looked at all, and no observation from outside the
 * card can reach the state that produced the control. So the FAIL is
 * conditioned on the pre-state having been jumpable in the first place.
 * A switch offered over an already-unjumpable snapshot is reported as
 * BLOCKED with the ambiguity named, not as a regression: a stale render
 * and a genuine Basic-mode regression are indistinguishable from the
 * DOM, and the test hook that would separate them is #1855.
 *
 * Strict on purpose, and the same five inputs `jumpabilitySnapshot`
 * records — both sale entry points require exactly Active, refuse past
 * maturity, refuse a locked position, need a live lender token, and are
 * suppressed for a sanctions-flagged holder.
 *
 * @param {JumpabilitySnapshot|null} s
 * @returns {boolean|null} null when there is no snapshot to judge
 */
export function snapshotJumpable(s, observed) {
  if (!s) return null;
  if (!heldByObserver(s, observed)) return false;
  return s.active && !s.matured && !s.locked && !s.flagged;
}

/**
 * Is the position held by the wallet the drive is observing?
 *
 * `holder !== null` is not the question (Codex #1853 r15). The card
 * requires the lender token's holder to equal the CONNECTED address,
 * and the ownership query refreshes on a 60-second interval — so a
 * transfer to a DIFFERENT wallet that lands after the page caches
 * ownership but before the pre-probe snapshot leaves both snapshots
 * holding the same new, non-null address. Nothing "moved" between
 * them, a burn check passes because the token still exists, and the
 * stale card's jumps disappear on the next ownership refetch — which
 * the drive would then have reported as a product FAIL.
 *
 * Compared case-insensitively: `jumpabilitySnapshot` lowercases the
 * holder it reads, and the observed address arrives checksummed.
 *
 * A missing `observed` returns true rather than false — the caller
 * genuinely has nobody to compare against, and inventing a mismatch
 * there would suppress real findings.
 */
function heldByObserver(s, observed) {
  if (s.holder === null) return false;
  if (!observed) return true;
  return s.holder === String(observed).toLowerCase();
}

/**
 * Could the lender CARD still be mounted on this state?
 *
 * The third question, and deliberately the LOOSEST of the three
 * (Codex #1853 r15). `jumpabilityMoved` asks whether anything changed;
 * `snapshotJumpable` asks whether a sale ROW could be offered;
 * this asks whether the card itself could be on the page at all.
 *
 * It must not be conflated with jumpability, and the cost of doing so
 * is severe rather than subtle: the card stays mounted past maturity
 * and on a FallbackPending loan — its wait row is still true — so
 * every past-due position, which is currently EVERY lender position on
 * the live chain, would have its card assertions suppressed. The
 * drive's headline check would stop checking on exactly the data it
 * runs against.
 *
 * What genuinely unmounts it: a terminal status, the holder no longer
 * being the observed wallet (transferred or burned), and the holder
 * being sanctions-flagged — which correctly suppresses the card.
 *
 * @param {JumpabilitySnapshot|null} s
 * @param {string} [observed] the wallet the drive is impersonating
 * @returns {boolean|null} null when there is no snapshot to judge
 */
export function snapshotCardEligible(s, observed) {
  if (!s) return null;
  if (s.flagged) return false;
  if (!heldByObserver(s, observed)) return false;
  return Boolean(s.active || s.fallbackPending);
}

/**
 * Does a sampled mid-probe excursion explain this Advanced result?
 *
 * The RULE behind the wrapper's excursion arm, extracted so it can be
 * exercised (Codex #1853 r27). Round 24 introduced the rule at the two
 * returns where the race had surfaced, and the route that ends "no
 * jumpable row" — the switch never appeared, the deadline passed —
 * walked past it, exiting clean on a run that had RECORDED the exact
 * race the watcher exists to catch. Same shape as r13's finding about
 * `jumpabilityMoved`: a rule applied where a finding pointed rather
 * than everywhere it governs, and unexercised besides.
 *
 * Two conditions, and both are load-bearing:
 *
 *  - Nothing already BLOCKED. Those results carry a more specific
 *    reason, and overwriting it with this one loses the better finding
 *    — the same precedence the stale-owner verdict beside it uses.
 *  - A falsy `advancedJumps`. `null` on every blocked route and `0` on
 *    the honest no-op-switch FAIL, which are exactly the two outcomes
 *    an excursion can explain. A successful audit — positive jumps —
 *    is a positive observation that the excursion did not prevent, so
 *    it is left alone.
 *
 * @param {{advancedBlocked?: boolean, advancedJumps?: number|null}} result
 * @param {string|null} excursion what moved, or null if nothing did
 * @returns {boolean}
 */
export function excursionExplains(result, excursion) {
  if (!excursion) return false;
  if (result?.advancedBlocked) return false;
  return !result?.advancedJumps;
}
