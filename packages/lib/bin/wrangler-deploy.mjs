#!/usr/bin/env node
/**
 * `wrangler deploy`, stamped with the commit it was built from (#2242).
 *
 * Every Worker deploy in this repository goes through here (directly from a
 * package's `deploy` script, or through apps/indexer/scripts/deploy-shared-d1.mjs),
 * so the deploy-lag check can read back exactly what each live Worker was
 * built from. Arguments are passed to `wrangler deploy` unchanged, ahead of
 * the stamp's flags; the stamp itself is ../src/deployStamp.mjs.
 *
 * It runs the wrangler the calling package declares, resolved from the
 * working directory, under this Node and without a shell (wranglerDeploy).
 */
import { deployStamp, wranglerDeploy } from '../src/deployStamp.mjs';

const stamp = deployStamp();
if ('reason' in stamp) {
  console.warn(`[deploy-stamp] not recording the commit on this deployment: ${stamp.reason}`);
  console.warn('[deploy-stamp] the deploy-lag check will infer it from the upload time, and say so.');
} else {
  console.log(`[deploy-stamp] ${stamp.message}`);
}
let res;
try {
  res = wranglerDeploy(process.argv.slice(2), { stamp });
} catch (err) {
  console.error(`[deploy-stamp] could not find wrangler from ${process.cwd()}: ${err.message.split('\n')[0]}`);
  process.exit(1);
}
if (res.error) {
  console.error(`[deploy-stamp] could not run wrangler: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
