#!/usr/bin/env node
/**
 * `wrangler deploy`, stamped with the commit it was built from (#2242), or,
 * when the Worker's Workers Build sets `VAIPAKAM_DEPLOY_MODE=upload`,
 * `wrangler versions upload` with the same stamp (#3236): the version is
 * stored and previewable but takes no traffic until a person approves it in
 * .github/workflows/promote-site.yml.
 *
 * Every Worker deploy in this repository goes through here (directly from a
 * package's `deploy` script, or through apps/indexer/scripts/deploy-shared-d1.mjs),
 * so the deploy-lag check can read back exactly what each live Worker was
 * built from. Arguments are passed to wrangler unchanged, ahead of the
 * stamp's flags; the stamp itself is ../src/deployStamp.mjs.
 *
 * It runs the wrangler the calling package declares, resolved from the
 * working directory, under this Node and without a shell (wranglerRun).
 */
import { deployMode, deployStamp, wranglerRun } from '../src/deployStamp.mjs';

const mode = deployMode();
if ('reason' in mode) {
  console.error(`[deploy-stamp] ${mode.reason}; refusing to deploy.`);
  process.exit(1);
}
const stamp = deployStamp();
if ('reason' in stamp) {
  if (mode.mode === 'upload') {
    // An unstamped upload could never be matched to a commit, so it could
    // never be approved: refuse it here rather than store an orphan.
    console.error(`[deploy-stamp] cannot upload for approval without a commit stamp: ${stamp.reason}`);
    process.exit(1);
  }
  console.warn(`[deploy-stamp] not recording the commit on this deployment: ${stamp.reason}`);
  console.warn('[deploy-stamp] the deploy-lag check will infer it from the upload time, and say so.');
} else {
  console.log(`[deploy-stamp] ${stamp.message}`);
}
if (mode.mode === 'upload') {
  console.log('[deploy-stamp] VAIPAKAM_DEPLOY_MODE=upload: uploading a version that takes no traffic until it is approved (promote-site.yml).');
}
let res;
try {
  res = wranglerRun(mode.mode === 'upload' ? ['versions', 'upload'] : ['deploy'], process.argv.slice(2), { stamp });
} catch (err) {
  console.error(`[deploy-stamp] could not find wrangler from ${process.cwd()}: ${err.message.split('\n')[0]}`);
  process.exit(1);
}
if (res.error) {
  console.error(`[deploy-stamp] could not run wrangler: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
