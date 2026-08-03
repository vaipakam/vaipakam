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

// The SAME validator the healthcheck uses. Re-deriving "is this a real
// period" here would let the two disagree, and this script's whole output
// is a period the operator is asked to commit.
import { isRealPeriod, validateBaseline } from '../src/tiers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const BUCKET = process.env.BUCKET_NAME || 'vaipakam-offchain-data-archive';

/** Families to inspect: the prefix, and the shape its period segment takes. */
const FAMILIES = [
  {
    env: 'ARCHIVE_FIRST_MONTHLY',
    // BOTH halves of the pair. A cut writes a manifest AND an archive; if
    // the oldest loses only its manifest, scanning `manifests-*` alone
    // advances the reported baseline past it and the operator commits a
    // value that permanently masks the deletion — while the bucket still
    // holds the archive proving that period existed. Deriving the
    // baseline from the survivors of ONE family is the same circularity
    // the baseline exists to break, one level down.
    prefixes: ['manifests-monthly/', 'archives-monthly/'],
    tier: 'monthly',
    label: 'monthly (written on the 1st)',
  },
  {
    env: 'ARCHIVE_FIRST_YEARLY',
    prefixes: ['manifests-yearly/', 'archives-yearly/'],
    tier: 'yearly',
    label: 'yearly (written on Jan 1)',
  },
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/**
 * Credentials for a READ-ONLY inventory.
 *
 * Prefers the dedicated read key, and takes it from the process
 * environment first so an operator can supply one without writing it to
 * disk at all. `setup-backblaze.mjs` says the repo-root master key should
 * stay offline after provisioning, and this is routine discovery — there
 * is no reason for it to hold account-wide key, bucket and DELETE powers
 * to list six prefixes. An earlier version of this script read only that
 * master key, which quietly walked back the scoped-key posture.
 */
function loadCreds() {
  const envPath = resolve(REPO_ROOT, '.env');
  let raw = '';
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    /* the error below covers it */
  }
  const file = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) file[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  // Process env first, so an operator can supply a key without writing it
  // to disk; then the dedicated read key; then whatever the repo-root
  // .env holds. The LAST of those is accepted only because the capability
  // check below rejects a master key at runtime — the guarantee is
  // "this process never wields write/delete authority", and a name cannot
  // promise that. B2 telling us what the key can actually do can.
  const pairs = [
    ['process env B2_READ_*', process.env.B2_READ_ACCESS_KEY_ID, process.env.B2_READ_SECRET_ACCESS_KEY],
    ['.env B2_READ_*', file.B2_READ_ACCESS_KEY_ID, file.B2_READ_SECRET_ACCESS_KEY],
    ['.env BACKBLAZE_KEY_ID/APP_KEY', file.BACKBLAZE_KEY_ID, file.BACKBLAZE_APP_KEY],
  ].filter(([, id, key]) => id && key);

  // AMBIGUITY IS FATAL, because the README leans on this command as proof
  // that what is ON DISK is read-only. With an exported B2_READ_* taking
  // precedence, the check could pass on that key while the legacy names in
  // `.env` still held the pre-split MASTER — and the operator would then
  // delete BACKBLAZE_MASTER_* believing the remaining pair was safe. A
  // verification that can succeed without inspecting the thing it certifies
  // is not a verification.
  // A HALF-WRITTEN disk pair must not be silently skipped. Filtering to
  // complete pairs first meant a missing or partial `.env` credential left
  // only the exported one, the run succeeded, and step 7 read that success
  // as proof about what is ON DISK — after which the master is removed and
  // local tooling has no working persisted credential at all.
  const diskPartial =
    (file.BACKBLAZE_KEY_ID || file.BACKBLAZE_APP_KEY) &&
    !(file.BACKBLAZE_KEY_ID && file.BACKBLAZE_APP_KEY);
  if (diskPartial) {
    fail(
      'the repo-root .env has only ONE half of BACKBLAZE_KEY_ID /\n' +
        '  BACKBLAZE_APP_KEY. Refusing to fall back to another credential:\n' +
        '  this command is used to certify the pair ON DISK, so a partial\n' +
        '  one must fail rather than be quietly bypassed.',
    );
  }

  const distinct = [...new Set(pairs.map(([, id]) => id))];
  if (distinct.length > 1) {
    fail(
      `found ${distinct.length} DIFFERENT B2 credentials:\n` +
        pairs.map(([src]) => `    ${src}`).join('\n') +
        `\n\n  Refusing to guess. This command is used to certify that the\n` +
        `  credential on disk is read-only, so it must not silently prefer a\n` +
        `  different one. Unset the extras and re-run.`,
    );
  }
  if (pairs.length > 0) {
    const [src, id, key] = pairs[0];
    console.log(`Credential source: ${src}`);
    return { id, key };
  }
  fail(
    'No B2 credentials found. Set B2_READ_ACCESS_KEY_ID +\n' +
      '  B2_READ_SECRET_ACCESS_KEY in the environment or the repo-root .env.',
  );
}

/**
 * The ONLY capabilities this script may hold — an allowlist, not a
 * denylist.
 *
 * A denylist of six obviously-dangerous permissions passed a key holding
 * `listFiles` plus `writeFileLegalHolds`, `writeFileRetentions` or
 * `bypassGovernance` — all of which mutate, and the last of which can
 * override Object Lock retention, the very mechanism #1469/#1473 lean on.
 * Enumerating what must not be present is a promise that decays every
 * time the provider adds a capability; enumerating what MAY be present
 * does not. This is the documented read-key set and nothing else.
 */
const ALLOWED_CAPABILITIES = ['listBuckets', 'listFiles', 'readFiles'];

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
  const apiUrl = data.apiInfo?.storageApi?.apiUrl ?? data.apiUrl;
  // The endpoint comes from B2's own authorize response, so pin it to
  // Backblaze rather than following wherever the body points. Cheap, and
  // it turns "trust the response" into a checked assumption.
  let host;
  try {
    host = new URL(apiUrl).host;
  } catch {
    fail(`b2_authorize_account returned an unusable apiUrl`);
  }
  if (!/(^|\.)backblazeb2\.com$/.test(host)) {
    fail(`refusing to call a non-Backblaze apiUrl host: ${host}`);
  }
  // REJECT MASTER CAPABILITY, rather than trusting a variable name. This
  // script lists six prefixes; it must not be able to write, delete, or
  // mint keys while doing it. `setup-backblaze.mjs` says the master key
  // stays offline after provisioning, and a routine discovery command is
  // exactly where that quietly stops being true.
  const caps = data.apiInfo?.storageApi?.capabilities ?? data.allowed?.capabilities ?? [];
  if (caps.length === 0) {
    fail('authorize returned no capability list; refusing to assume read-only');
  }
  const extra = caps.filter((c) => !ALLOWED_CAPABILITIES.includes(c));
  if (extra.length > 0) {
    fail(
      `this key holds ${extra.length} capability(ies) beyond read-only:\n` +
        `  ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ', …' : ''}\n\n` +
        `  Refusing to run an inventory with more authority than it needs.\n` +
        `  Use the bucket-scoped read key: ${ALLOWED_CAPABILITIES.join(' + ')}.`,
    );
  }
  // A key can ALSO be restricted to a `namePrefix`, independently of its
  // capabilities and bucket scope. One limited to `archives-monthly/2026-07/`
  // authorizes cleanly, passes both checks above, and then makes every
  // older object invisible to the listing — so the script would print a
  // later baseline, or NONE, and mask exactly the cuts it exists to find.
  const namePrefix = data.apiInfo?.storageApi?.namePrefix ?? data.allowed?.namePrefix;
  if (namePrefix) {
    fail(
      `this key is restricted to namePrefix "${namePrefix}" — it cannot see\n` +
        `  the whole family, so any baseline derived from it would be a\n` +
        `  floor on what this KEY can list, not on what the bucket holds.`,
    );
  }
  return {
    token: data.authorizationToken,
    apiUrl,
    // Needed by `b2_list_buckets`, which REQUIRES accountId — omitting it
    // made the master-key path fail before listing anything.
    accountId: data.accountId ?? data.apiInfo?.storageApi?.accountId,
    allowedBucketId: data.apiInfo?.storageApi?.bucketId ?? data.allowed?.bucketId,
    allowedBucketName: data.apiInfo?.storageApi?.bucketName ?? data.allowed?.bucketName,
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
  // BUCKET SCOPE IS REQUIRED, not merely honoured when present. The old
  // fallback resolved the configured bucket through `b2_list_buckets` for
  // an unscoped key — so routine discovery could run on a credential able
  // to list and read every bucket in the account, which is the same
  // least-authority failure as accepting the master, one notch quieter.
  // A read key for ONE bucket is the documented posture; anything wider
  // is a different key than the one this command is meant to certify.
  if (!auth.allowedBucketId) {
    fail(
      'this key is not bucket-scoped — it can reach every bucket in the\n' +
        '  account. Use the read key scoped to the backup bucket alone.',
    );
  }
  if (auth.allowedBucketName && auth.allowedBucketName !== BUCKET) {
    fail(
      `this key is scoped to bucket "${auth.allowedBucketName}" but ` +
        `BUCKET_NAME is "${BUCKET}" — refusing to report one bucket's ` +
        `periods under another's name`,
    );
  }
  return auth.allowedBucketId;
}

const PAGE_CAP = 500;

async function periodsUnder(auth, bucketId, prefix, tier) {
  const periods = new Set();
  let files = 0;
  let startFileName = null;
  let startFileId = null;
  for (let page = 0; ; page++) {
    if (page >= PAGE_CAP) {
      // FAIL, never return partial. Exiting quietly here would print an
      // "earliest" drawn from a prefix of the listing — and with a leaked
      // write key seeding lexically-early foreign names, that is exactly
      // how a wrong baseline gets committed. A cap that silently
      // truncates is worse than no cap.
      fail(
        `listing ${prefix} exceeded ${PAGE_CAP} pages without completing. ` +
          `Refusing to report a partial inventory as the baseline.`,
      );
    }
    // VERSIONS, not names. `b2_list_file_names` returns only CURRENT
    // versions, so an oldest cut that was administratively hidden — the
    // precise loss these declared baselines exist to detect — looks like a
    // period that never existed, and the baseline advances past it. The
    // bucket still holds the evidence; the wrong call was hiding it.
    const data = await b2(auth, 'b2_list_file_versions', {
      bucketId,
      prefix,
      maxFileCount: 1000,
      ...(startFileName ? { startFileName } : {}),
      ...(startFileId ? { startFileId } : {}),
    });
    for (const f of data.files ?? []) {
      files += 1;
      const rest = f.fileName.slice(prefix.length);
      if (!rest.includes('/')) continue;
      const seg = rest.split('/')[0];
      // Real calendar period, not merely the right width. `2026-00` passes
      // a width check AND sorts before every genuine month, so it would be
      // reported as the baseline and committed — then rejected by
      // `validateBaseline`, after the operator had already been told to
      // set it.
      if (isRealPeriod(tier, seg)) periods.add(seg);
    }
    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
    // `b2_list_file_versions` pages on the (name, id) PAIR — carrying only
    // the name re-reads the first version of that file forever.
    startFileId = data.nextFileId ?? null;
  }
  return { periods: [...periods].sort(), files };
}

const creds = loadCreds();
const auth = await authorize(creds.id, creds.key);
const bucketId = await resolveBucketId(auth);

console.log(`\nBucket: ${BUCKET}\n`);
const toSet = [];

for (const fam of FAMILIES) {
  const seen = new Set();
  let files = 0;
  for (const prefix of fam.prefixes) {
    const r = await periodsUnder(auth, bucketId, prefix, fam.tier);
    for (const p of r.periods) seen.add(p);
    files += r.files;
  }
  const periods = [...seen].sort();
  console.log(`── ${fam.label}`);
  console.log(`   prefixes: ${fam.prefixes.join(' + ')}`);
  console.log(`   objects:  ${files}`);
  if (periods.length === 0) {
    console.log(`   periods:  NONE — nothing written yet.`);
    console.log(`   → leave ${fam.env} UNSET. The healthcheck reports`);
    console.log(`     COVERAGE DEGRADED for this tier until one exists, which`);
    console.log(`     is the honest state rather than a fault.\n`);
    continue;
  }
  console.log(`   periods:  ${periods.length} (${periods[0]} … ${periods[periods.length - 1]})`);
  // Run the value through the SAME gate the healthcheck will. I imported
  // `isRealPeriod` and stopped there, which is half the validation: a
  // validly shaped FUTURE key (`manifests-yearly/2999/x`, stray or
  // planted) sorts first, would be reported as the baseline, and
  // `validateBaseline` would then reject it on every run — after the
  // operator had committed it.
  const earliest = periods[0];
  const check = validateBaseline({ [fam.tier]: earliest }, Date.now());
  if (!check.ok) {
    console.log(`   ✗ earliest period ${earliest} is NOT a usable baseline:`);
    for (const e of check.errors) console.log(`     ${e}`);
    console.log(`     Investigate that object before setting ${fam.env}.\n`);
    continue;
  }
  console.log(`   → ${fam.env}=${earliest}\n`);
  toSet.push(`${fam.env}=${earliest}`);
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
