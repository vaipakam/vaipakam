/**
 * Batch runner for the live tier — executes every live review script
 * sequentially against SITE_URL (default: production alpha02) and
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
 * Drivers that actually IMPLEMENT the three-verdict contract above.
 *
 * The contract is aspirational for everything not in this set. Those
 * drivers exit 1 for infrastructure failures — an unreachable site, a
 * dead RPC, an absent wallet file — either by an explicit
 * `process.exit(1)` or by letting the rejection reach the top level. So
 * a BLOCKED row can only ever appear for a driver listed here, and a
 * FAIL row from any other driver may or may not be a real regression.
 *
 * Naming that explicitly is the point. A summary that silently applied a
 * three-verdict vocabulary to twelve drivers when one honours it reads
 * as "no infrastructure failures occurred" when what actually happened
 * is that none could be distinguished (#1529 review round 19). Migrating
 * the rest is tracked separately; add each here as it lands.
 */
const THREE_VERDICT_DRIVERS = new Set(['live-position-observe.mjs']);

const scripts = fs
  .readdirSync(HERE)
  .filter((f) => f.startsWith('live-') && f.endsWith('.mjs'))
  .sort();

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
  results.push({
    script,
    verdict: res.status === 0 ? 'PASS' : res.status === 2 ? 'BLOCKED' : 'FAIL',
    code: res.status,
  });
}

console.log('\n━━━ live batch summary ━━━');
for (const r of results) {
  const unmigrated = r.verdict === 'FAIL' && !THREE_VERDICT_DRIVERS.has(r.script);
  console.log(
    `${r.verdict.padEnd(7)}  ${r.script}` +
      (r.verdict === 'FAIL' && r.code !== 1 ? `  (exit ${r.code})` : '') +
      // Do not let this row be read as a confirmed product defect.
      (unmigrated ? '  (may be infrastructure — driver predates the contract)' : ''),
  );
}
const unmigratedFails = results.filter(
  (r) => r.verdict === 'FAIL' && !THREE_VERDICT_DRIVERS.has(r.script),
);
if (unmigratedFails.length) {
  console.log(
    `\n${unmigratedFails.length} FAIL(s) came from drivers that do not yet` +
      ` distinguish BLOCKED from FAIL — an unreachable site or RPC looks` +
      ` identical to a regression there. Read those drives' output before` +
      ` treating them as defects.`,
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
