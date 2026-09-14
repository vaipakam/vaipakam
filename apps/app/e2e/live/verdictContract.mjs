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
 * Splitting the data out is the whole fix: the runner's behaviour is
 * unchanged, and `verdictContract.test.mjs` can now fail on a driver
 * nobody has classified.
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
  // Exits 2 through `blockedSync` when the connect modal offers no
  // Coinbase connector, when the SDK never opens its window, or when it
  // opens somewhere unexpected — all preconditions for measuring whether
  // the connector phones home, none of them a product regression.
  //
  // Registered after CHECKING that it honours the contract, rather than
  // on the strength of the list being one name short: it documents the
  // contract at its head and reaches `blockedSync` at four sites.
  // Registering a driver that never agreed to mean BLOCKED by exiting 2
  // is the dishonesty this set exists to prevent, so membership is
  // something to verify and not to assume (#2099).
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
