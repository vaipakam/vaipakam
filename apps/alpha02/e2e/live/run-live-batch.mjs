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
 * Three verdicts, not two. Exit 2 from a script means BLOCKED — it ran
 * but could not verify anything (a precondition the live chain didn't
 * offer, a missing credential). That is reported distinctly from FAIL
 * because the remedy is different: a FAIL is a regression to fix, a
 * BLOCKED is a review that still needs running. Both keep the batch
 * exit non-zero, so neither can be mistaken for a clean release gate.
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
  results.push({
    script,
    verdict: res.status === 0 ? 'PASS' : res.status === 2 ? 'BLOCKED' : 'FAIL',
  });
}

console.log('\n━━━ live batch summary ━━━');
for (const r of results) {
  console.log(`${r.verdict.padEnd(7)}  ${r.script}`);
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
