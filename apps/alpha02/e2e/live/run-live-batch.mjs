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
  results.push({ script, ok: res.status === 0 });
}

console.log('\n━━━ live batch summary ━━━');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.script}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
