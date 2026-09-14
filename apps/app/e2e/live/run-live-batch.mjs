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
 *   2  BLOCKED  — it did not COMPLETE, so its surfaces are not fully
 *                 reviewed (a precondition the live chain didn't offer,
 *                 a missing credential). Usually that means it verified
 *                 nothing, and for most drives it does — but not always:
 *                 an accumulating driver can complete one role, hit a
 *                 setup failure on the next, keep the results it has and
 *                 still exit 2. BLOCKED says "do not read this as a
 *                 pass", not "nothing was seen".
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { driversOnDisk, THREE_VERDICT_DRIVERS } from './verdictContract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * WHICH VERDICTS EACH DRIVER SPEAKS — moved to `verdictContract.mjs` so
 * something other than this file can read it (#2099).
 *
 * This module runs the whole batch on import, so while the lists lived
 * here nothing could check them without launching browsers against a
 * live site, and the only guard that could exist was the startup warning
 * below. That warning prints on a batch run — before a testnet release,
 * not on a pull request — so a driver could be added, reviewed, merged
 * and run for weeks with its BLOCKED reported as a product FAIL.
 *
 * Behaviour here is unchanged. The check that fails is a unit test.
 */

const scripts = driversOnDisk(HERE);

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
  // "VERIFIED NOTHING" IS NOT ALWAYS TRUE, and stating it flatly erased
  // real observations (#2069 review round 13). A multi-role driver can
  // pass every visitor scenario and then hit a setup failure on a later
  // role: it deliberately keeps those results, writes its report, and
  // exits 2 so the run is not called green. Reporting that as "ran but
  // verified nothing" contradicted the very report the driver went to
  // trouble to preserve — and told the operator to re-review surfaces
  // that had just been reviewed.
  //
  // BLOCKED still means "do not read this as a pass". It does not mean
  // the drive saw nothing, so the wording no longer claims it does and
  // points at the report instead.
  console.log(
    `\n${blocked.length} drive(s) BLOCKED — did not complete, so their` +
      ` surfaces are not fully reviewed. A blocked drive may still have` +
      ` verified some scenarios before it stopped; check its report or` +
      ` output rather than assuming nothing was covered:\n` +
      blocked.map((r) => `  ${r.script}`).join('\n'),
  );
}
process.exit(results.every((r) => r.verdict === 'PASS') ? 0 : 1);
