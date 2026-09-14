/**
 * WHICH VERDICTS EACH LIVE DRIVER SPEAKS.
 *
 * `run-live-batch.mjs` classifies a driver's exit code against this, and
 * the classification is only honest if the lists are right: an exit 2
 * from a driver in `THREE_VERDICT_DRIVERS` is reported as BLOCKED ("this
 * drive DID NOT COMPLETE, so its surfaces are not fully reviewed"), and
 * from any other driver as `FAIL (exit 2)`. Reading a BLOCKED off a
 * driver that never agreed to mean that by exiting 2 asserts something
 * about a surface nobody checked, which is why membership is opt-in and
 * stays opt-in.
 *
 * WHY THIS IS ITS OWN MODULE (#2099). The lists lived in the runner,
 * which executes the whole batch on import — so nothing could read them
 * without launching browsers against a live site, and the only guard
 * that could exist was a `console.log` at startup. That warning prints
 * on a batch run, which happens before a testnet release and not on a
 * pull request, so a driver could be added, reviewed, merged and run for
 * weeks with its BLOCKED reported as a product FAIL. The operator
 * reading that row has no way to tell.
 *
 * Splitting the data out is what makes a check possible at all, and
 * `verdictContract.test.mjs` is the check: it fails on a driver nobody
 * has classified.
 *
 * The runner's CLASSIFICATION is untouched — an exit code still becomes
 * the same verdict it always did. Its REPORTING did change, and an
 * earlier draft of this comment claimed otherwise after the change had
 * been made: a declared opt-out is now named with its reason and no
 * longer carries the hedge meant for a driver nobody has looked at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Drivers that IMPLEMENT the three-verdict contract — 0 pass, 1 fail,
 * 2 blocked (a precondition failed, so the drive did not complete).
 *
 * NOTE what BLOCKED does and does not say. It means the drive did not
 * complete, so its surfaces are not fully reviewed. It does NOT mean the
 * drive observed nothing: a multi-role driver may pass every scenario
 * for one role and then hit a setup failure on the next, keeping those
 * results and its report while still exiting 2.
 */
export const THREE_VERDICT_DRIVERS = new Set([
  'live-alerts-link.mjs',
  // Exits 2 for a bad role selector, a browser/profile setup failure, or
  // an unreachable site — all PRECONDITIONS, not product regressions.
  // Without this entry the batch relabels those BLOCKED exits as FAIL and
  // points the operator at the product during an infrastructure problem.
  'live-role-journeys.mjs',
  'live-collateral-precheck.mjs',
  // Speaks BLOCKED through the SHARED HARNESS — an unreachable site, a
  // missing credential, no browser — and through none of its own
  // checks, which are all assertions against a page that was served.
  //
  // That took three review rounds to establish, and the audit comment
  // here was wrong twice on the way (#2099 r1-r3). It first said the
  // driver reached `blockedSync` at four sites and called all four
  // preconditions; each round moved another one to FAIL, until none was
  // left. Registering a driver that never agreed to mean BLOCKED by
  // exiting 2 is the dishonesty this set exists to prevent — and a
  // rationale that has drifted from the driver is the same failure with
  // an extra step, since it is what the next reader will trust instead
  // of reading the code.
  'live-connect-telemetry.mjs',
  'live-desk-i18n-capture.mjs',
  'live-dryrun-review.mjs',
  'live-killswitch-regression.mjs',
  'live-position-observe.mjs',
  'live-rate-desk.mjs',
  'live-recover.mjs',
  // Exits 2 when a locale bundle lacks a key it is asked to assert —
  // a missing PRECONDITION in the repo, not a product regression. It
  // is auto-discovered by the sweep, so without this entry the batch
  // would relabel its BLOCKED as `FAIL (exit 2)` and claim the driver
  // predates the contract, contradicting the driver's own report of the
  // same run (Codex #1590 r3).
  'live-recover-locales.mjs',
  'live-risk-access.mjs',
  'live-rpc-audit.mjs',
  'live-signed-book.mjs',
  'live-support-ticket.mjs',
  'live-ux-sweep.mjs',
]);

/**
 * Drivers that DELIBERATELY do not implement it, each with its reason.
 * Membership here is a decision, and the reason is what makes it one.
 *
 * This list is why the check below is not simply "every driver must be
 * registered". Auto-registering would be the easy fix and the wrong one:
 * the opt-in is what makes BLOCKED mean something. What was missing was
 * never registration — it was the DIFFERENCE between a driver that opted
 * out and one nobody had got to yet, which a single list cannot express
 * and a startup warning cannot enforce.
 */
export const TWO_VERDICT_DRIVERS = new Map([
  // (empty today: every driver in this directory honours the contract)
]);

/** Every driver on disk, the way the batch runner discovers them. */
export function driversOnDisk(dir = HERE) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('live-') && f.endsWith('.mjs'))
    .sort();
}

/**
 * Drivers in NEITHER list — added without anyone saying which verdicts
 * they speak, so the batch will report their BLOCKED as a product FAIL.
 *
 * A hand-maintained list against an auto-discovered directory is the
 * shape this repo has been bitten by repeatedly — the facet selector
 * lists, the regression runner's subdirectories — and in each case the
 * fix was a check that fails, not a reminder to remember.
 */
export function undeclaredDrivers(names = driversOnDisk()) {
  return names.filter((n) => !THREE_VERDICT_DRIVERS.has(n) && !TWO_VERDICT_DRIVERS.has(n));
}

/**
 * Drivers declared in BOTH lists — two contracts for one driver, which
 * is worse than none.
 *
 * The way in is converting a driver: add it to the opt-out list, forget
 * to remove it from the other. Nothing here refuses that on its own,
 * and the two readers then DISAGREE ABOUT THE SAME RUN — the runner
 * announces it as deliberately two-verdict at startup and then reads its
 * exit 2 as BLOCKED, because that classification asks
 * `THREE_VERDICT_DRIVERS` directly (#2099 round 2).
 *
 * Exactly one declaration per driver, or the lists are not a contract.
 */
export function doublyDeclaredDrivers() {
  return [...THREE_VERDICT_DRIVERS].filter((n) => TWO_VERDICT_DRIVERS.has(n)).sort();
}
