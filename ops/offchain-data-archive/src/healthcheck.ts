/**
 * Weekly healthcheck. Confirms a recent nightly archive exists in
 * B2, decrypts cleanly, and its embedded SHA-256 matches the
 * manifest's archive.sha256 stamp. The most-frequent real-world
 * incident for nightly-backup systems is silent failure — the cron
 * stops firing or the upload errors silently for weeks before
 * someone notices. This catches that with a deterministic weekly
 * probe.
 *
 * Runs against the READ-scoped B2 key (listBuckets + listFiles +
 * readFiles). Cannot write, cannot delete — bounded blast radius if
 * the key leaks.
 *
 * Immutable archive naming (introduced in PR #248 round-2 after
 * Codex flagged the previous overwriteable scheme): archive keys
 * are `archives/YYYY-MM-DD/<32-hex-nonce>.bin`. The healthcheck
 * doesn't know the nonce in advance; it lists by date prefix and
 * picks the most recently uploaded object. Looking back 0..2 days
 * tolerates a single missed nightly without paging.
 */

import { decrypt, sha256Hex } from './crypto';
import type { B2Config } from './b2';
import type { Env } from './env';

export type TierName = 'daily' | 'monthly' | 'yearly';

export interface HealthOutcome {
  ok: boolean;
  reason: string;
  archiveKey?: string;
  manifestKey?: string;
  archiveAgeHours?: number;
  manifestSha?: string;
  actualSha?: string;
}

export interface TierOutcome extends HealthOutcome {
  tier: TierName;
  /**
   * True when nothing was found under the tier's prefixes at all, as
   * opposed to something found and rejected. Kept distinct because the
   * two need different operator responses — and because reporting an
   * absence as a plain pass is how this whole class of defect starts.
   */
  absent: boolean;
}

export interface HealthReport {
  ok: boolean;
  tiers: TierOutcome[];
}

/**
 * The prefix families the backup writes, and how far back to look for
 * each. ONE table, iterated by both the verifier and the alert
 * formatter.
 *
 * This table is the fix for #1476, and its shape is the point. The
 * healthcheck used to hard-code the daily prefix, so the monthly and
 * yearly families — written by the same backup pass, on the same
 * credential, under the same threat model — were never examined by
 * anything. A green weekly PASS therefore asserted a coverage it did
 * not have, which is worse than no check: the retention policy's
 * monthly floor was then justified in `lifecycle-policy.mjs` with
 * "the detector will catch it", and there was no detector.
 *
 * Adding a fourth tier means adding a row here; there is no second
 * place to remember.
 */
interface TierSpec {
  tier: TierName;
  manifestPrefix: string;
  archivePrefix: string;
  /** Period keys to try, newest first. */
  periodKeys: (now: number) => string[];
  /**
   * Whether finding nothing at all should fail the run.
   *
   * Monthly: yes. An object is written on the 1st of every month, so
   * two months of lookback finding nothing means the monthly write has
   * stopped. A deployment younger than one month also trips this; that
   * is a self-resolving false page and far cheaper than staying silent
   * about a monthly write that has genuinely stopped.
   *
   * Yearly: no. An object is written on Jan 1 only, so a deployment
   * that has not yet lived through one legitimately has none, and that
   * is a normal state lasting up to a year — unpageable without crying
   * wolf every week. It is still REPORTED on every run rather than
   * omitted, so the absence is visible instead of implied.
   */
  absenceIsFailure: boolean;
}

/** `YYYY-MM-DD` for `n` days before `now` (UTC). */
function dayKey(now: number, daysAgo: number): string {
  return new Date(now - daysAgo * 86400_000).toISOString().slice(0, 10);
}

/** `YYYY-MM` for `n` months before `now` (UTC). */
function monthKey(now: number, monthsAgo: number): string {
  const d = new Date(now);
  // Anchor to the 1st before stepping: `setUTCMonth` on the 31st of a
  // month rolls into the following month when the target is shorter,
  // so stepping back one month from Mar 31 would land on Mar 3.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 7);
}

/** `YYYY` for `n` years before `now` (UTC). */
function yearKey(now: number, yearsAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(0);
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d.toISOString().slice(0, 4);
}

export const TIERS: TierSpec[] = [
  {
    tier: 'daily',
    manifestPrefix: 'manifests/',
    archivePrefix: 'archives/',
    // 0..2 tolerates a single missed nightly without paging.
    periodKeys: (now) => [dayKey(now, 0), dayKey(now, 1), dayKey(now, 2)],
    absenceIsFailure: true,
  },
  {
    tier: 'monthly',
    manifestPrefix: 'manifests-monthly/',
    archivePrefix: 'archives-monthly/',
    // Written on the 1st. The previous month covers a run early on the
    // 1st itself, before that night's cron has fired.
    periodKeys: (now) => [monthKey(now, 0), monthKey(now, 1)],
    absenceIsFailure: true,
  },
  {
    tier: 'yearly',
    manifestPrefix: 'manifests-yearly/',
    archivePrefix: 'archives-yearly/',
    // Written on Jan 1. The previous year covers the whole of a year
    // whose Jan 1 write has not happened yet.
    periodKeys: (now) => [yearKey(now, 0), yearKey(now, 1)],
    absenceIsFailure: false,
  },
];

/** Memory ceiling on the healthcheck side — same constant as the
 *  backup path's MAX_ARCHIVE_BYTES. If an archive ever exceeds this,
 *  the check aborts before OOM-ing the Worker; the alert text steers
 *  the operator to the streaming follow-up. */
const MAX_HEALTHCHECK_BYTES = 100_000_000;

interface S3ListEntry {
  key: string;
  lastModified: string;
  size: number;
}

/** List objects under a prefix via the B2 S3-compatible API.
 *  Caller already holds a read-scoped key. Returns at most 100
 *  entries (the healthcheck only ever needs the latest from a
 *  one-day prefix — large nightly fan-outs would never produce 100
 *  archives for the same date). */
/**
 * Page through ListObjectsV2 for a prefix until exhausted or a hard
 * safety cap is hit. S3 listings are key-ordered (NOT time-ordered),
 * so the "newest" manifest within a prefix can land on a later page;
 * a single-page list would silently miss it in the
 * compromised-write-key threat model (attacker uploads many objects
 * under a single date prefix to push the honest newest manifest off
 * the first page).
 *
 * Safety cap: PAGINATION_HARD_LIMIT pages. At max-keys=1000 per page
 * that's 100k objects — orders of magnitude above what a single date
 * prefix should ever contain (one nightly = 1 archive + 1 manifest,
 * so even with monthly + yearly siblings + many attacker uploads we
 * stay well under). The cap exists to bound the Worker CPU budget
 * if a misconfigured prefix returns millions of entries; if we ever
 * hit it the healthcheck logs a warning and proceeds with what it
 * has, which still picks the newest of the first 100k entries.
 */
const PAGINATION_HARD_LIMIT = 100;
const PAGE_SIZE = 1000;

async function listPrefix(cfg: B2Config, prefix: string): Promise<S3ListEntry[]> {
  const entries: S3ListEntry[] = [];
  let continuationToken: string | undefined = undefined;
  for (let page = 0; page < PAGINATION_HARD_LIMIT; page++) {
    // Build the URL once; the signer below canonicalizes query
    // parameters (sorted by name, URI-encoded values) as SigV4
    // requires.
    const params: Record<string, string> = {
      'list-type': '2',
      'max-keys': String(PAGE_SIZE),
      prefix,
    };
    if (continuationToken) params['continuation-token'] = continuationToken;
    const url = `https://${cfg.endpoint}/${cfg.bucket}?${canonicalQueryString(params)}`;
    const res = await fetchSigned(cfg, 'GET', url, '');
    if (!res.ok) {
      throw new Error(`S3 list (${prefix}, page ${page}) failed: ${res.status}`);
    }
    const xml = await res.text();
    // Tiny XML extraction — S3 ListObjectsV2 output is well-bounded.
    // Avoid an XML parser dep; the response always has a fixed
    // `<Contents>...<Key>...</Key><LastModified>...</LastModified>
    // <Size>N</Size>...</Contents>` shape.
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1];
      const lm = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1];
      const size = block.match(/<Size>([^<]+)<\/Size>/)?.[1];
      if (key && lm && size) {
        entries.push({ key, lastModified: lm, size: parseInt(size, 10) });
      }
    }
    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!isTruncated) return entries;
    continuationToken =
      xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    if (!continuationToken) return entries;
  }
  console.warn(
    `[healthcheck] listPrefix(${prefix}) hit PAGINATION_HARD_LIMIT ` +
    `(${PAGINATION_HARD_LIMIT} pages × ${PAGE_SIZE} entries). Proceeding ` +
    `with the first ${entries.length} entries; this likely indicates an ` +
    `attacker filling the prefix with garbage uploads.`,
  );
  return entries;
}

/**
 * Build a SigV4-canonical query string: parameters sorted by name,
 * names and values URI-encoded (RFC 3986 — i.e. `encodeURIComponent`
 * is mostly right but needs `!` `'` `(` `)` `*` re-escaped). The
 * absence of this canonicalization in the prior shape would cause
 * B2 to compute a different signature than we sign for and reject
 * the list call with 403, falling through to "no manifest" false-
 * failures even when archives are intact.
 */
function canonicalQueryString(params: Record<string, string>): string {
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  return Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
}

/** Fetch a single object via signed GET. Used by the healthcheck
 *  alone — backup path doesn't read. */
async function getObject(cfg: B2Config, key: string): Promise<Response> {
  const url = `https://${cfg.endpoint}/${cfg.bucket}/${encodeURI(key)}`;
  const res = await fetchSigned(cfg, 'GET', url, '');
  if (!res.ok) {
    throw new Error(`S3 GET ${key} failed: ${res.status}`);
  }
  return res;
}

/**
 * Verify one prefix family: newest manifest under it, its sibling
 * archive, hash, byte length, decryptability.
 *
 * Split out of `runHealthcheck` for #1476 so the same verification
 * runs against every tier. Nothing in the body is tier-aware — the
 * differences live entirely in the `TierSpec`, which is what stops a
 * tier from being covered "differently" and therefore not at all.
 */
export async function verifyTier(
  env: Env,
  b2Cfg: B2Config,
  spec: TierSpec,
  now: number = Date.now(),
): Promise<TierOutcome> {
  const base = { tier: spec.tier, absent: false };
  let pickedManifest: S3ListEntry | undefined;
  const periods = spec.periodKeys(now);

  for (const period of periods) {
    const prefix = `${spec.manifestPrefix}${period}/`;
    let entries: S3ListEntry[];
    try {
      entries = await listPrefix(b2Cfg, prefix);
    } catch (err) {
      // A list failure on the newest period might be transient — fall
      // through to the older one rather than reporting an absence.
      console.warn(`[healthcheck] list ${prefix} failed: ${(err as Error).message}`);
      continue;
    }
    if (entries.length === 0) continue;
    // Newest by LastModified — covers the "uploaded twice by an
    // attacker" case where both an honest + a malicious manifest
    // exist for the same period. Picking newest forces the attacker
    // to land an upload AFTER our last honest run; the embedded
    // SHA check then catches the divergence.
    entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    pickedManifest = entries[0];
    break;
  }

  if (!pickedManifest) {
    const where = `${spec.manifestPrefix}{${periods.join(',')}}/`;
    return {
      ...base,
      absent: true,
      ok: !spec.absenceIsFailure,
      reason: spec.absenceIsFailure
        ? `no ${spec.tier} manifest under ${where} — that tier's writes have ` +
          `stopped (or this deployment is younger than one ${spec.tier} cycle)`
        : `no ${spec.tier} archive written yet (expected until this deployment ` +
          `lives through a Jan 1) — nothing verified for this tier`,
    };
  }

  // Fetch the manifest JSON.
  const manifestRes = await getObject(b2Cfg, pickedManifest.key).catch((err) => {
    return { error: (err as Error).message } as { error: string };
  });
  if ('error' in manifestRes) {
    return { ...base, ok: false, reason: `manifest GET failed: ${manifestRes.error}`, manifestKey: pickedManifest.key };
  }
  const manifestJson = (await manifestRes.json()) as {
    archive: { sha256: string; byteLength: number };
    createdAt: string;
  };

  // The archive's nonce + period come from the manifest's filename
  // structure: `<manifestPrefix><period>/<nonce>.json` → the archive
  // lives at `<archivePrefix><period>/<nonce>.bin`.
  //
  // Derived from the SPEC, never a hard-coded `manifests/` → `archives/`
  // rewrite: that pattern does not match `manifests-monthly/`, so it
  // would leave the prefix untouched and dereference a .bin under the
  // MANIFEST prefix — a GET 404 reported as a missing archive, on a
  // tier that was perfectly healthy.
  const archiveKey =
    spec.archivePrefix +
    pickedManifest.key.slice(spec.manifestPrefix.length).replace(/\.json$/, '.bin');

  // Pre-fetch size gate: refuse to OOM-page the Worker by trying to
  // pull a 500 MB archive into RAM. If we ever hit this, the
  // streaming follow-up is overdue.
  if (manifestJson.archive.byteLength > MAX_HEALTHCHECK_BYTES) {
    return {
      ...base,
      ok: false,
      reason: `manifest reports archive size ${manifestJson.archive.byteLength} bytes > ` +
              `MAX_HEALTHCHECK_BYTES (${MAX_HEALTHCHECK_BYTES}). Streaming healthcheck overdue.`,
      manifestKey: pickedManifest.key,
      archiveKey,
      manifestSha: manifestJson.archive.sha256,
    };
  }

  const archiveRes = await getObject(b2Cfg, archiveKey).catch((err) => {
    return { error: (err as Error).message } as { error: string };
  });
  if ('error' in archiveRes) {
    return { ...base, ok: false, reason: `archive GET failed: ${archiveRes.error}`, archiveKey, manifestKey: pickedManifest.key };
  }

  const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());
  const actualSha = await sha256Hex(archiveBytes);

  if (actualSha !== manifestJson.archive.sha256) {
    return {
      ...base,
      ok: false,
      reason: 'archive SHA-256 mismatch — bit-rot or upload corruption',
      archiveKey,
      manifestKey: pickedManifest.key,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  if (archiveBytes.byteLength !== manifestJson.archive.byteLength) {
    return {
      ...base,
      ok: false,
      reason: 'archive byte-length mismatch with manifest',
      archiveKey,
      manifestKey: pickedManifest.key,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  // Decryption probe — confirms the archive isn't merely well-
  // formed bytes but actually decrypts with the configured key.
  try {
    await decrypt(env.encryptionKey, archiveBytes);
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: `archive decryption failed: ${(err as Error).message}`,
      archiveKey,
      manifestKey: pickedManifest.key,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  const archiveAgeHours =
    (now - Date.parse(pickedManifest.lastModified)) / 3_600_000;

  return {
    ...base,
    ok: true,
    reason: 'manifest + archive paired, SHA matches, decrypts cleanly',
    archiveKey,
    manifestKey: pickedManifest.key,
    archiveAgeHours,
    manifestSha: manifestJson.archive.sha256,
    actualSha,
  };
}

/**
 * Verify EVERY tier and report each one.
 *
 * The run fails if any tier fails. Tiers are verified independently —
 * one tier's failure must not stop the others being examined, or the
 * first failure would mask everything behind it and the operator would
 * fix one thing a week.
 */
export async function runHealthcheck(
  env: Env,
  b2Cfg: B2Config,
  now: number = Date.now(),
): Promise<HealthReport> {
  const tiers: TierOutcome[] = [];
  for (const spec of TIERS) {
    try {
      tiers.push(await verifyTier(env, b2Cfg, spec, now));
    } catch (err) {
      // A thrown tier is a failed tier, not a failed run: the
      // remaining tiers still get checked and reported.
      tiers.push({
        tier: spec.tier,
        absent: false,
        ok: false,
        reason: `check threw: ${(err as Error).message}`,
      });
    }
  }
  return { ok: tiers.every((t) => t.ok), tiers };
}

/** Hand-rolled SigV4 GET / list. Same shape as `b2.ts`'s PUT signer
 *  but a separate file because b2.ts is intentionally write-only —
 *  keeping the read surface here prevents an accidental read-from-
 *  hot-path import. */
async function fetchSigned(
  cfg: B2Config,
  method: 'GET',
  fullUrl: string,
  payload: string,
): Promise<Response> {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const amzDate =
    `${dateStamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const url = new URL(fullUrl);
  const payloadHash = await sha256HexStr(payload);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const headerNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders =
    headerNames
      .map((h) => `${h}:${headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!].trim()}\n`)
      .join('');
  const signedHeaders = headerNames.join(';');
  // SigV4 canonical query string: params sorted by name, names and
  // values URI-encoded per RFC 3986. Even though `listPrefix`
  // already constructs the URL in canonical form, re-canonicalizing
  // here is defensive — `getObject` callers and any future caller
  // that builds a URL string by hand still produce signable bytes.
  // Re-parsing via URLSearchParams + the same `enc` helper used
  // by `canonicalQueryString` keeps a single source of truth for
  // the encoding rules.
  const canonicalQuery = (() => {
    const enc = (s: string) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      );
    const sp = new URLSearchParams(url.search);
    const pairs: [string, string][] = [];
    sp.forEach((value, key) => pairs.push([key, value]));
    return pairs
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&');
  })();
  const canonicalRequest = [
    method,
    url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256HexStr(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = toHex(await hmac(kSigning, stringToSign));

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return fetch(fullUrl, { method, headers });
}

async function hmac(key: string | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const keyBuf = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg));
}

function toHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256HexStr(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(d);
}
