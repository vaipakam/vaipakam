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
 * stays opt-in. The same holds for exit 3: UNDETERMINED only from a driver
 * declared in `FOUR_VERDICT_DRIVERS`, FAIL from any other (`classifyExit`
 * is the one rule, #2434 r2).
 *
 * WHY THIS IS ITS OWN MODULE (#2099). The lists lived in the runner,
 * which executes the whole batch on import — so nothing could read them
 * without launching browsers against a live site, and the only guard
 * that could exist was a `console.log` at startup. That warning prints
 * on a batch run, which happens before a testnet release and not on a
 * pull request, so a driver could be added, reviewed, merged and run for
 * weeks with its BLOCKED reported as a product FAIL.
 *
 * The row is not SILENT about it — the runner appends "undeclared driver
 * — may be infrastructure" and repeats the point in its summary, and an
 * earlier draft here said the operator had no way to tell, which
 * overstated it. What is wrong is the VERDICT: a hedged claim that a
 * defect was found is still a claim that a defect was found, and a hedge
 * asks the reader to discount a verdict rather than giving them the
 * right one.
 *
 * Splitting the data out is what makes a check possible at all, and
 * `verdictContract.test.mjs` is the check: it fails on a driver nobody
 * has classified.
 *
 * BE PRECISE ABOUT ITS FORCE. That suite runs on every change and is
 * meant to be treated as blocking by reviewers, but it is not among the
 * checks that mechanically prevent a merge — `app-vitest.yml` says so in
 * its own header, and says not to describe it as a gate that does. So
 * this closes the gap of nobody NOTICING, which is what went wrong: a
 * warning that printed only during a release run. Making it mechanical
 * is a separate decision about which checks are required.
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
  // (live-refinance.mjs is NOT here: it also exits 3 = UNDETERMINED, so it
  // is declared in FOUR_VERDICT_DRIVERS below — #2434 r2.)
  'live-rpc-audit.mjs',
  'live-signed-book.mjs',
  'live-support-ticket.mjs',
  'live-ux-sweep.mjs',
]);

/**
 * Drivers that implement the three-verdict contract PLUS a fourth code —
 * 3 UNDETERMINED — each with its reason (#2434 r2).
 *
 * UNDETERMINED means the drive WROTE to the chain and then could not
 * establish its claims either way: nothing was observed wrong (that would be
 * 1), and the drive did not stop before writing (that would be 2). It is NOT
 * a pass and keeps the batch red, but it is reported as what it is rather
 * than as a product FAIL. Exit 0, 1 and 2 mean what they mean for
 * `THREE_VERDICT_DRIVERS`.
 *
 * Opt-in, like BLOCKED: an exit 3 from a driver NOT declared here is a FAIL,
 * because reading UNDETERMINED off a driver that never agreed to mean it is
 * the same dishonesty the three-verdict opt-in prevents.
 */
export const FOUR_VERDICT_DRIVERS = new Map([
  [
    'live-refinance.mjs',
    // Exits 2 only BEFORE its first write (no REFI_LOAN_ID, site build
    // mismatch, chain facts that differ from an eligible loan, short
    // balances, an open request, missing credentials, a browser session that
    // could not be set up). After the first write it FAILs only on a chain
    // read contradicting an outcome claim or a gate escape; any other stop is
    // 3. Also MANUAL-ONLY — see MANUAL_ONLY_DRIVERS below.
    'after its first write, a stop that no chain read shows to be a defect is ' +
      'UNDETERMINED (exit 3), with the touched-state ledger printed (#2431, #2434)',
  ],
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

/**
 * Drivers the batch runner SKIPS — run by hand, one deliberate invocation
 * at a time — each with its reason.
 *
 * This is NOT a verdict contract and does not replace the ones above: a
 * manual-only driver is still declared in exactly one of them,
 * because an operator running it by hand reads its exit code the same
 * way. What this list answers is a different question — whether a
 * release batch should launch it at all. A driver belongs here when an
 * unattended run cannot be green: it consumes the on-chain state it
 * drives (a one-shot refinance closes its loan), so after its first
 * success every batch would show it BLOCKED, and a batch that is red by
 * construction trains people to ignore red.
 *
 * Skipping is never silent: the runner prints each skipped driver with
 * its reason before the batch and again in the summary, so a reviewer
 * reading a green batch can see what it did not cover.
 */
export const MANUAL_ONLY_DRIVERS = new Map([
  [
    'live-refinance.mjs',
    'one-shot on-chain refinance: a success closes the loan it drives, and it ' +
      'needs REFI_LOAN_ID naming a fresh eligible loan — run it by hand',
  ],
]);

/** The drivers a batch run actually launches: everything on disk minus
 *  the manual-only ones. */
export function batchDrivers(names = driversOnDisk()) {
  return names.filter((n) => !MANUAL_ONLY_DRIVERS.has(n));
}

/** Every driver on disk, the way the batch runner discovers them. */
export function driversOnDisk(dir = HERE) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('live-') && f.endsWith('.mjs'))
    .sort();
}

/**
 * Drivers in NO list — added without anyone saying which verdicts
 * they speak, so the batch will report their BLOCKED as a product FAIL.
 *
 * A hand-maintained list against an auto-discovered directory is the
 * shape this repo has been bitten by repeatedly — the facet selector
 * lists, the regression runner's subdirectories — and in each case the
 * fix was a check that fails, not a reminder to remember.
 */
export function undeclaredDrivers(names = driversOnDisk()) {
  return names.filter((n) => declarationsOf(n) === 0);
}

/** How many of the three verdict declarations name `n`. */
function declarationsOf(n) {
  return [THREE_VERDICT_DRIVERS.has(n), FOUR_VERDICT_DRIVERS.has(n), TWO_VERDICT_DRIVERS.has(n)].filter(Boolean).length;
}

/**
 * The batch verdict for one driver's exit code — the ONE place the runner's
 * classification lives, so it can be tested without launching a batch.
 *
 *   0 → PASS, from any driver.
 *   2 → BLOCKED only from a driver that honours the contract (three- or
 *       four-verdict); otherwise FAIL.
 *   3 → UNDETERMINED only from a FOUR_VERDICT_DRIVERS driver; otherwise FAIL.
 *   anything else (1, a crash's null, an invented code) → FAIL.
 */
export function classifyExit(script, code) {
  if (code === 0) return 'PASS';
  if (code === 2 && (THREE_VERDICT_DRIVERS.has(script) || FOUR_VERDICT_DRIVERS.has(script))) return 'BLOCKED';
  if (code === 3 && FOUR_VERDICT_DRIVERS.has(script)) return 'UNDETERMINED';
  return 'FAIL';
}

/**
 * Drivers declared in MORE THAN ONE list — two contracts for one driver, which
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
  const all = new Set([...THREE_VERDICT_DRIVERS, ...FOUR_VERDICT_DRIVERS.keys(), ...TWO_VERDICT_DRIVERS.keys()]);
  return [...all].filter((n) => declarationsOf(n) > 1).sort();
}
