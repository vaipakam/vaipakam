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

interface HealthOutcome {
  ok: boolean;
  reason: string;
  archiveKey?: string;
  manifestKey?: string;
  archiveAgeHours?: number;
  manifestSha?: string;
  actualSha?: string;
}

/** Memory ceiling on the healthcheck side — same constant as the
 *  backup path's MAX_ARCHIVE_BYTES. If an archive ever exceeds this,
 *  the check aborts before OOM-ing the Worker; the alert text steers
 *  the operator to the streaming follow-up. */
const MAX_HEALTHCHECK_BYTES = 100_000_000;

/** YYYY-MM-DD for `n` days ago (UTC). */
function isoDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return d.toISOString().slice(0, 10);
}

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
async function listPrefix(cfg: B2Config, prefix: string): Promise<S3ListEntry[]> {
  const url =
    `https://${cfg.endpoint}/${cfg.bucket}` +
    `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=100`;
  const res = await fetchSigned(cfg, 'GET', url, '');
  if (!res.ok) {
    throw new Error(`S3 list (${prefix}) failed: ${res.status}`);
  }
  const xml = await res.text();
  // Tiny XML extraction — S3 ListObjectsV2 output is well-bounded.
  // Avoid an XML parser dep; the response always has a fixed
  // `<Contents>...<Key>...</Key><LastModified>...</LastModified>
  // <Size>N</Size>...</Contents>` shape.
  const entries: S3ListEntry[] = [];
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
  return entries;
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

export async function runHealthcheck(env: Env, b2Cfg: B2Config): Promise<HealthOutcome> {
  // Look back 0..2 days for the most recent manifest. Archives live
  // under `archives/<date>/<nonce>.bin`; we look at the matching
  // manifest prefix (`manifests/<date>/`) because manifests are
  // smaller (faster list, fewer bytes to fetch).
  let pickedManifest: S3ListEntry | undefined;

  for (let i = 0; i <= 2; i++) {
    const dateKey = isoDate(i);
    const prefix = `manifests/${dateKey}/`;
    let entries: S3ListEntry[];
    try {
      entries = await listPrefix(b2Cfg, prefix);
    } catch (err) {
      // A list failure on i==0 might be transient — try i==1.
      console.warn(`[healthcheck] list ${prefix} failed: ${(err as Error).message}`);
      continue;
    }
    if (entries.length === 0) continue;
    // Newest by LastModified — covers the "uploaded twice by an
    // attacker" case where both an honest + a malicious manifest
    // exist for the same date. Picking newest forces the attacker
    // to land an upload AFTER our last honest run; the embedded
    // SHA check then catches the divergence.
    entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    pickedManifest = entries[0];
    break;
  }

  if (!pickedManifest) {
    return {
      ok: false,
      reason: 'no manifest in B2 for the last 3 days (cron likely stopped firing)',
    };
  }

  // Fetch the manifest JSON.
  const manifestRes = await getObject(b2Cfg, pickedManifest.key).catch((err) => {
    return { error: (err as Error).message } as { error: string };
  });
  if ('error' in manifestRes) {
    return { ok: false, reason: `manifest GET failed: ${manifestRes.error}`, manifestKey: pickedManifest.key };
  }
  const manifestJson = (await manifestRes.json()) as {
    archive: { sha256: string; byteLength: number };
    createdAt: string;
  };

  // The archive's nonce + date come from the manifest's filename
  // structure: `manifests/<date>/<nonce>.json` → archive lives at
  // `archives/<date>/<nonce>.bin`. Compute the sibling key.
  const archiveKey = pickedManifest.key
    .replace(/^manifests\//, 'archives/')
    .replace(/\.json$/, '.bin');

  // Pre-fetch size gate: refuse to OOM-page the Worker by trying to
  // pull a 500 MB archive into RAM. If we ever hit this, the
  // streaming follow-up is overdue.
  if (manifestJson.archive.byteLength > MAX_HEALTHCHECK_BYTES) {
    return {
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
    return { ok: false, reason: `archive GET failed: ${archiveRes.error}`, archiveKey, manifestKey: pickedManifest.key };
  }

  const archiveBytes = new Uint8Array(await archiveRes.arrayBuffer());
  const actualSha = await sha256Hex(archiveBytes);

  if (actualSha !== manifestJson.archive.sha256) {
    return {
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
      ok: false,
      reason: `archive decryption failed: ${(err as Error).message}`,
      archiveKey,
      manifestKey: pickedManifest.key,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  const archiveAgeHours =
    (Date.now() - Date.parse(pickedManifest.lastModified)) / 3_600_000;

  return {
    ok: true,
    reason: 'manifest + archive paired, SHA matches, decrypts cleanly',
    archiveKey,
    manifestKey: pickedManifest.key,
    archiveAgeHours,
    manifestSha: manifestJson.archive.sha256,
    actualSha,
  };
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
  const canonicalRequest = [
    method,
    url.pathname || '/',
    url.search.replace(/^\?/, ''),
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
