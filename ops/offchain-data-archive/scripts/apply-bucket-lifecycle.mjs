#!/usr/bin/env node
/**
 * Declare, verify and apply the B2 archive bucket's lifecycle rules.
 *
 * WHY THIS EXISTS. The bucket's retention behaviour was live state that
 * existed nowhere in the repo. Nobody could review it, nothing detected drift
 * in it, and it took an ad-hoc API query to discover that superseded versions
 * were being deleted after ONE day — which is what made a forged archive
 * unrecoverable rather than merely detectable (#1469). Configuration that
 * only exists in a provider console is configuration nobody can be
 * accountable for.
 *
 * (An earlier draft of this comment claimed `OffChainRestore.md` §1 recreates
 * the bucket without lifecycle rules, making this a restore gap. That is
 * FALSE — B2 is the SURVIVING side of a Cloudflare-loss restore and is
 * correctly not recreated. The claim was corrected in the commit message and
 * left standing here, which is its own small instance of the two-copies
 * problem this file exists to fix.)
 *
 * The real second consequence is narrower and concerns SETUP, not restore:
 * `setup-backblaze.mjs` used to hardcode its own copy of these rules, so
 * rerunning the documented setup flow would silently revert a change applied
 * here. It now reads this declaration.
 *
 * WHAT THE NUMBERS MEAN, since `daysFromHidingToDeleting` is easy to
 * misread. It governs a version that is no longer current — either hidden by
 * the `daysFromUploadingToHiding` rule, or SUPERSEDED by a newer upload at
 * the same key. It was 1. That is the value that matters for the threat model
 * in #1469: the archive Worker's B2 key has `writeFiles` but NOT
 * `deleteFiles` (verified), so an attacker who compromises the Worker can
 * only OVERWRITE an archive, never delete one. The genuine version therefore
 * survives — until our own lifecycle rule removes it a day later. Raising it
 * to 30 means the real archive is recoverable for a month after a forged
 * overwrite, and it is the cheap reversible half of #1469.
 *
 * Note the same setting also extends how long ordinary hidden versions live,
 * so the daily series retains ~60 days rather than ~31. That is deliberate
 * and stated rather than incidental — at ~445 KiB per nightly it is a
 * fraction of a cent per month.
 *
 * USAGE
 *   node scripts/apply-bucket-lifecycle.mjs --check    # read-only, no writes
 *   node scripts/apply-bucket-lifecycle.mjs --print-live
 *   node scripts/apply-bucket-lifecycle.mjs --apply
 *
 * CREDENTIALS. Reads `BACKBLAZE_KEY_ID` / `BACKBLAZE_APP_KEY` from the
 * environment.
 *
 *   --check / --print-live need only `listBuckets`, so the ordinary
 *   bucket-scoped READ-ONLY key works. That is deliberate: drift must be
 *   observable without holding anything dangerous.
 *
 *   --apply needs `writeBucketLifecycleRules`, which NEITHER of the
 *   pipeline's two keys has, on purpose — the write key exists to push
 *   objects, not to reconfigure the bucket. Use a temporary key scoped to
 *   this bucket with `listBuckets` + `readBucketLifecycleRules` +
 *   `writeBucketLifecycleRules`, and delete it afterwards. Do NOT reach for
 *   the master key: it also carries `deleteBuckets`, `deleteFiles` and
 *   `bypassGovernance`, none of which this task needs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECL = join(HERE, '..', 'bucket-lifecycle.json');

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--print-live')
    ? 'print'
    : 'check';

const keyId = process.env.BACKBLAZE_KEY_ID;
const appKey = process.env.BACKBLAZE_APP_KEY;
if (!keyId || !appKey) {
  console.error('Set BACKBLAZE_KEY_ID and BACKBLAZE_APP_KEY.');
  process.exit(2);
}

/** The four fields B2 round-trips, in a stable order, for comparison. */
function normalise(rules) {
  return [...rules]
    .map((r) => ({
      fileNamePrefix: r.fileNamePrefix,
      daysFromUploadingToHiding: r.daysFromUploadingToHiding ?? null,
      daysFromHidingToDeleting: r.daysFromHidingToDeleting ?? null,
      daysFromStartingToCancelingUnfinishedLargeFiles:
        r.daysFromStartingToCancelingUnfinishedLargeFiles ?? null,
    }))
    .sort((a, b) => a.fileNamePrefix.localeCompare(b.fileNamePrefix));
}

const fmt = (rules) =>
  normalise(rules)
    .map(
      // EVERY normalised field (#1471 r1). Omitting the
      // unfinished-large-file field meant a drift confined to it printed two
      // identical-looking blocks, leaving the operator unable to see what
      // `--apply` would change. A diff that does not show the difference is
      // worse than no diff.
      (r) =>
        `    ${r.fileNamePrefix.padEnd(22)} hide@${r.daysFromUploadingToHiding}d  ` +
        `delete@+${r.daysFromHidingToDeleting}d  ` +
        `cancelUnfinished@${r.daysFromStartingToCancelingUnfinishedLargeFiles ?? 'none'}`,
    )
    .join('\n');

async function b2(url, init = {}) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // B2's own message is safe to surface — it never echoes the app key.
    throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname}: ${body.code ?? res.status} ${body.message ?? ''}`.trim());
  }
  return body;
}

async function main() {
  const declared = JSON.parse(readFileSync(DECL, 'utf8'));

  const auth = await b2('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}`,
    },
  });
  const api = auth.apiInfo.storageApi;
  const token = auth.authorizationToken;

  // A bucket-restricted key MUST scope b2_list_buckets, or B2 returns a bare
  // `unauthorized` that reads like a bad credential rather than a bad call.
  const bucketId = api.bucketId;
  const qs = new URLSearchParams({ accountId: auth.accountId });
  if (bucketId) qs.set('bucketId', bucketId);
  else qs.set('bucketName', declared.bucket);

  const listed = await b2(`${api.apiUrl}/b2api/v3/b2_list_buckets?${qs}`, {
    headers: { Authorization: token },
  });
  const bucket = listed.buckets.find((b) => b.bucketName === declared.bucket);
  if (!bucket) {
    console.error(`Bucket ${declared.bucket} not found (key sees: ${listed.buckets.map((b) => b.bucketName).join(', ') || 'none'}).`);
    process.exit(1);
  }

  // An ABSENT `lifecycleRules` is not the same as "no rules" (#1471 r1).
  // B2 omits the field when the key lacks `readBucketLifecycleRules`, and
  // treating that as an empty set would report permanent false drift on a
  // correctly configured bucket — then, under `--apply`, present a diff whose
  // "from" side is fiction.
  //
  // NOTE the review premise was narrower than stated: the pipeline read-only
  // key (`listBuckets, listFiles, readFiles`) DOES surface the field — checked
  // against the live bucket, which is how the drift in this PR was observed at
  // all. But "it happens to work with today's key" is not a reason to infer
  // from silence, so absence is now an explicit failure rather than a guess.
  if (bucket.lifecycleRules == null) {
    console.error(
      `${declared.bucket}: B2 returned no \`lifecycleRules\` field. That means the ` +
        'key cannot read them, NOT that none are set — this key needs ' +
        '`readBucketLifecycleRules` (or at least `listBuckets` on a key permitted ' +
        'to see them). Refusing to report drift against an unknown live state.',
    );
    process.exit(2);
  }
  const live = normalise(bucket.lifecycleRules);
  const want = normalise(declared.rules);

  if (mode === 'print') {
    console.log(`live rules on ${bucket.bucketName}:`);
    console.log(fmt(live) || '    (none — B2 default: every version kept forever)');
    return 0;
  }

  const same = JSON.stringify(live) === JSON.stringify(want);

  if (mode === 'check') {
    if (same) {
      console.log(`bucket lifecycle: live rules MATCH bucket-lifecycle.json.`);
      return 0;
    }
    console.error('bucket lifecycle: DRIFT — live rules differ from the declaration.\n');
    console.error('  live:');
    console.error(fmt(live) || '    (none)');
    console.error('\n  declared:');
    console.error(fmt(want));
    console.error('\nApply with --apply (needs writeBucketLifecycleRules), or update the declaration if the live state is intended.');
    return 1;
  }

  // ── apply ────────────────────────────────────────────────────────────
  if (same) {
    console.log('bucket lifecycle: already matches the declaration; nothing to do.');
    return 0;
  }
  console.log('applying:\n  from:');
  console.log(fmt(live) || '    (none)');
  console.log('  to:');
  console.log(fmt(want));

  await b2(`${api.apiUrl}/b2api/v3/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketId: bucket.bucketId,
      lifecycleRules: want,
    }),
  });

  // Read back rather than trusting the write — the whole point of codifying
  // this is not to have to take the provider's word for the live state.
  const after = await b2(`${api.apiUrl}/b2api/v3/b2_list_buckets?${qs}`, {
    headers: { Authorization: token },
  });
  const now = normalise(
    after.buckets.find((b) => b.bucketName === declared.bucket).lifecycleRules ?? [],
  );
  if (JSON.stringify(now) !== JSON.stringify(want)) {
    console.error('applied, but the READBACK does not match the declaration:');
    console.error(fmt(now));
    return 1;
  }
  console.log('applied and verified by readback.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  },
);
