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
  console.log(
    `${r.verdict.padEnd(7)}  ${r.script}` +
      (r.verdict === 'FAIL' && r.code !== 1 ? `  (exit ${r.code})` : ''),
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
