/**
 * Batch runner for the live tier — executes every live review script
 * sequentially against SITE_URL (REQUIRED — no default; see driver.mjs) and
 * prints a per-script verdict table. Use it as the "separate batch"
 * regression before a testnet release, or after a deploy that
 * touched several surfaces at once.
 *
 *   TESTNET_WALLETS_FILE=~/secrets/wallets.json node run-live-batch.mjs
 *   SITE_URL=https://<preview>.workers.dev node run-live-batch.mjs
 *
 * Scripts are independent processes: one failure doesn't stop the
 * batch, and the runner exits non-zero if ANY script failed.
 *
 * Three verdicts, not two:
 *
 *   0  PASS
 *   1  FAIL     — a regression the drive found, or one it hit itself
 *   2  BLOCKED  — it ran but could not verify anything (a precondition
 *                 the live chain didn't offer, a missing credential)
 *
 * FAIL and BLOCKED are reported distinctly because the remedy differs: a
 * FAIL is a defect to fix, a BLOCKED is a review that still needs
 * running. Both keep the batch exit non-zero, so neither can pass for a
 * clean release gate.
 *
 * This meaning is a CONTRACT every driver has to share, not a convention
 * layered on afterwards. `live-ux-sweep.mjs` used to exit 2 for
 * page-initiated write attempts, so the first version of this table
 * summarised that safety regression as "verified nothing" — the wrong
 * cause and the wrong remedy for a drive that had verified plenty and
 * found a defect. It exits 1 for that now (#1529 review round 5). A new
 * driver must pick from the three above rather than inventing a code.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Drivers that IMPLEMENT the three-verdict contract above.
 *
 * As of #1581 that is every driver in this directory. The set is kept
 * rather than dropped because it is what makes the vocabulary HONEST:
 * membership is enforced at classification, so an exit 2 from a driver
 * outside it is recorded as a FAIL. Reading it as BLOCKED would assert
 * "this surface ran but verified nothing" about a driver that never
 * agreed to mean that by exiting 2 (#1529 review round 19), and a new
 * driver is exactly the case where that could still happen.
 *
 * So: ADD A NEW DRIVER HERE when you add one. Honouring the contract is
 * a requirement for a driver in this directory, not an aspiration — and
 * the startup check below names anything unregistered rather than
 * letting the batch quietly misreport it.
 */
const THREE_VERDICT_DRIVERS = new Set([
  'live-alerts-link.mjs',
  'live-collateral-precheck.mjs',
  'live-desk-i18n-capture.mjs',
  'live-dryrun-review.mjs',
  'live-killswitch-regression.mjs',
  'live-position-observe.mjs',
  'live-rate-desk.mjs',
  'live-recover.mjs',
  // Exits 2 when a locale bundle lacks a key it is asked to assert —
  // a missing PRECONDITION in the repo, not a product regression. It
  // is auto-discovered by the sweep below, so without this entry the
  // batch would relabel its BLOCKED as `FAIL (exit 2)` and claim the
  // driver predates the contract, contradicting the driver's own
  // report of the same run (Codex #1590 r3).
  'live-recover-locales.mjs',
  'live-risk-access.mjs',
  'live-rpc-audit.mjs',
  'live-signed-book.mjs',
  'live-support-ticket.mjs',
  'live-ux-sweep.mjs',
]);

const scripts = fs
  .readdirSync(HERE)
  .filter((f) => f.startsWith('live-') && f.endsWith('.mjs'))
  .sort();

// Say so UP FRONT rather than at classification time. An unregistered
// driver's BLOCKED is silently downgraded to FAIL below — the safe
// direction, but silent, and someone then hunts a product bug that a
// missing entry in this file invented. Warning here also means a driver
// added without registering is visible on the run that first includes it,
// not on whichever later run happens to hit its BLOCKED path.
const unregistered = scripts.filter((s) => !THREE_VERDICT_DRIVERS.has(s));
if (unregistered.length) {
  console.log(
    `\nNOTE: ${unregistered.length} driver(s) are not registered in` +
      ` THREE_VERDICT_DRIVERS, so a BLOCKED exit from them will be reported` +
      ` as FAIL:\n` +
      unregistered.map((s) => `  ${s}`).join('\n') +
      `\n  → if they honour the three-verdict contract, add them to that set.`,
  );
}

const results = [];
for (const script of scripts) {
  console.log(`\n━━━ ${script} ━━━`);
  const res = spawnSync('node', [path.join(HERE, script)], {
    stdio: 'inherit',
    env: process.env,
  });
  // Anything other than the three contract codes is a FAIL: a driver
  // that crashed outright, or one inventing a code, must never read as
  // clean just because its number wasn't recognised.
  //
  // Exit 2 counts as BLOCKED only from a driver that HONOURS the
  // contract. Round 19 added the caveat above but applied it to FAIL rows
  // only, leaving this line to promote any exit 2 to BLOCKED — so the
  // comment's claim that "a BLOCKED row can only ever appear for a driver
  // listed here" was an assertion the code did not enforce. An
  // unmigrated driver that exits 2 for its own reasons would have been
  // reported as "ran but verified nothing", a specific claim about a
  // surface nobody had checked. Now it is true by construction.
  const honoursContract = THREE_VERDICT_DRIVERS.has(script);
  results.push({
    script,
    verdict:
      res.status === 0 ? 'PASS' : res.status === 2 && honoursContract ? 'BLOCKED' : 'FAIL',
    code: res.status,
    honoursContract,
  });
}

console.log('\n━━━ live batch summary ━━━');
for (const r of results) {
  const unmigrated = r.verdict === 'FAIL' && !r.honoursContract;
  console.log(
    `${r.verdict.padEnd(7)}  ${r.script}` +
      (r.verdict === 'FAIL' && r.code !== 1 ? `  (exit ${r.code})` : '') +
      // Do not let this row be read as a confirmed product defect.
      (unmigrated ? '  (unregistered driver — may be infrastructure)' : ''),
  );
}
const unmigratedFails = results.filter((r) => r.verdict === 'FAIL' && !r.honoursContract);
if (unmigratedFails.length) {
  console.log(
    `\n${unmigratedFails.length} FAIL(s) came from drivers not registered in` +
      ` THREE_VERDICT_DRIVERS, so BLOCKED could not be distinguished from` +
      ` FAIL for them — an unreachable site or RPC looks identical to a` +
      ` regression. Read those drives' output before treating them as` +
      ` defects, and register them if they honour the contract.`,
  );
}
const blocked = results.filter((r) => r.verdict === 'BLOCKED');
if (blocked.length) {
  console.log(
    `\n${blocked.length} drive(s) BLOCKED — ran but verified nothing, so these` +
      ` surfaces are still unreviewed:\n` +
      blocked.map((r) => `  ${r.script}`).join('\n'),
  );
}
process.exit(results.every((r) => r.verdict === 'PASS') ? 0 : 1);
