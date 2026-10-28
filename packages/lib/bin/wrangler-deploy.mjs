#!/usr/bin/env node
/**
 * `wrangler deploy`, stamped with the commit it was built from (#2242).
 *
 * Every Worker deploy in this repository goes through here (directly from a
 * package's `deploy` script, or through apps/indexer/scripts/deploy-shared-d1.mjs),
 * so the deploy-lag check can read back exactly what each live Worker was
 * built from. Arguments are passed to `wrangler deploy` unchanged, after the
 * stamp; the stamp itself is ../src/deployStamp.mjs.
 *
 * It runs `wrangler` from PATH, which a package script puts there.
 */
import { spawnSync } from 'node:child_process';
import { deployStamp, deployStampArgs } from '../src/deployStamp.mjs';

const stamp = deployStamp();
if ('reason' in stamp) {
  console.warn(`[deploy-stamp] not recording the commit on this deployment: ${stamp.reason}`);
  console.warn('[deploy-stamp] the deploy-lag check will infer it from the deploy time, and say so.');
} else {
  console.log(`[deploy-stamp] ${stamp.message}`);
}
const res = spawnSync('wrangler', ['deploy', ...deployStampArgs(stamp), ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (res.error) {
  console.error(`[deploy-stamp] could not run wrangler: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
