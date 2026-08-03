#!/usr/bin/env node
/**
 * Print the values for `ARCHIVE_FIRST_MONTHLY` / `ARCHIVE_FIRST_YEARLY`.
 *
 * WHY THIS EXISTS. #1476 gave the healthcheck two operator-declared
 * baselines — the first monthly and yearly archive this deployment ever
 * wrote — because deriving them from the surviving objects is circular:
 * delete the oldest yearly archive and the inferred baseline advances past
 * it, so the deleted year stops being required; empty the family and there
 * is nothing left to infer from, so nothing is missing and the tier passes.
 * A detector whose expectations come from the survivors cannot report a
 * deletion.
 *
 * That shipped WITHOUT any way for an operator to discover the values,
 * which made the setting unactionable — you were asked to declare a fact
 * you had no way to look up. This reads the bucket and tells you.
 *
 * It is read-only: it lists, and prints. It never writes to B2 and never
 * touches the Worker.
 *
 * ONE JUDGEMENT IT CANNOT MAKE FOR YOU. It reports the earliest archive
 * that still EXISTS. If the very first monthly cut has already been
 * deleted or aged out, the true baseline is earlier than what it prints,
 * and declaring the printed value would tell the healthcheck to stop
 * expecting the ones already gone. The yearly family has no lifecycle rule
 * so nothing should have aged out of it; the monthly family retains ~12
 * months, so if this deployment is older than that, set the monthly value
 * from when the archive Worker first ran rather than from this output.
 * It prints the object count so you can see whether the range looks
 * complete.
 *
 * Usage, from `ops/offchain-data-archive/`:
 *   node scripts/find-archive-baselines.mjs
 *
 * Credentials: repo-root `.env`, same as `setup-backblaze.mjs`
 * (`BACKBLAZE_KEY_ID` + `BACKBLAZE_APP_KEY`). A read-only key is enough.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const BUCKET = process.env.BUCKET_NAME || 'vaipakam-offchain-data-archive';

/** Families to inspect: the prefix, and the shape its period segment takes. */
const FAMILIES = [
  {
    env: 'ARCHIVE_FIRST_MONTHLY',
    prefix: 'manifests-monthly/',
    shape: /^\d{4}-\d{2}$/,
    label: 'monthly (written on the 1st)',
  },
  {
    env: 'ARCHIVE_FIRST_YEARLY',
    prefix: 'manifests-yearly/',
    shape: /^\d{4}$/,
    label: 'yearly (written on Jan 1)',
  },
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function loadEnv() {
  const envPath = resolve(REPO_ROOT, '.env');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (err) {
    fail(`Could not read ${envPath}: ${err.message}`);
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!out.BACKBLAZE_KEY_ID || !out.BACKBLAZE_APP_KEY) {
    fail(`BACKBLAZE_KEY_ID and BACKBLAZE_APP_KEY must both be set in ${envPath}`);
  }
  return out;
}

async function authorize(keyId, appKey) {
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}`,
    },
  });
  if (!res.ok) {
    fail(`b2_authorize_account failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    token: data.authorizationToken,
    // v3 splits the endpoints; the native storage API is the one we need.
    apiUrl: data.apiInfo?.storageApi?.apiUrl ?? data.apiUrl,
    allowedBucketId: data.apiInfo?.storageApi?.bucketId ?? data.allowed?.bucketId,
  };
}

async function b2(auth, endpoint, body) {
  // CodeQL flags `apiUrl` as request-forgery because it traces to B2's own
  // authorize response. It is B2 telling us which shard to talk to, reached
  // with credentials from the operator's own `.env` — the same pattern and
  // the same justification as `setup-backblaze.mjs`.
  const res = await fetch(`${auth.apiUrl}/b2api/v3/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    fail(`${endpoint} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function resolveBucketId(auth) {
  if (auth.allowedBucketId) return auth.allowedBucketId;
  const data = await b2(auth, 'b2_list_buckets', {
    accountId: undefined,
    bucketName: BUCKET,
  });
  const found = (data.buckets ?? []).find((b) => b.bucketName === BUCKET);
  if (!found) fail(`bucket ${BUCKET} not visible to this key`);
  return found.bucketId;
}

/** Every period segment present under a prefix, plus the object count. */
async function periodsUnder(auth, bucketId, prefix, shape) {
  const periods = new Set();
  let files = 0;
  let startFileName = null;
  // Paged: a family can hold years of objects, and a truncated first page
  // would silently report a later "earliest".
  for (let page = 0; page < 200; page++) {
    const data = await b2(auth, 'b2_list_file_names', {
      bucketId,
      prefix,
      maxFileCount: 1000,
      ...(startFileName ? { startFileName } : {}),
    });
    for (const f of data.files ?? []) {
      files += 1;
      const rest = f.fileName.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (rest.includes('/') && shape.test(seg)) periods.add(seg);
    }
    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
  }
  return { periods: [...periods].sort(), files };
}

const env = loadEnv();
const auth = await authorize(env.BACKBLAZE_KEY_ID, env.BACKBLAZE_APP_KEY);
const bucketId = await resolveBucketId(auth);

console.log(`\nBucket: ${BUCKET}\n`);
const toSet = [];

for (const fam of FAMILIES) {
  const { periods, files } = await periodsUnder(auth, bucketId, fam.prefix, fam.shape);
  console.log(`── ${fam.label}`);
  console.log(`   prefix:  ${fam.prefix}`);
  console.log(`   objects: ${files}`);
  if (periods.length === 0) {
    console.log(`   periods: NONE — nothing written yet.`);
    console.log(`   → leave ${fam.env} UNSET. The healthcheck reports`);
    console.log(`     COVERAGE DEGRADED for this tier until one exists, which`);
    console.log(`     is the honest state rather than a fault.\n`);
    continue;
  }
  console.log(`   periods: ${periods.length} (${periods[0]} … ${periods[periods.length - 1]})`);
  console.log(`   → ${fam.env}=${periods[0]}\n`);
  toSet.push(`${fam.env}=${periods[0]}`);
}

if (toSet.length === 0) {
  console.log('Nothing to set yet.\n');
} else {
  console.log('Add these to the "vars" block of');
  console.log('ops/offchain-data-archive/wrangler.jsonc, then redeploy:\n');
  console.log('  "vars": {');
  console.log(toSet.map((v) => `    "${v.split('=')[0]}": "${v.split('=')[1]}"`).join(',\n'));
  console.log('  }\n');
  console.log('They are plain configuration, NOT secrets — dates, not credentials —');
  console.log('so they belong in the committed wrangler config where a reviewer can');
  console.log('see them, rather than in `wrangler secret put`.\n');
  console.log('⚠ These say when this deployment FIRST wrote each family. If the');
  console.log('  earliest object has already aged out, the true value is EARLIER');
  console.log('  than shown, and declaring the shown one tells the healthcheck to');
  console.log('  stop expecting what is already gone.\n');
}
