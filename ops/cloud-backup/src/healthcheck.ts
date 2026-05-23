/**
 * Weekly healthcheck. Confirms the most recent nightly archive
 * actually exists in B2, decrypts cleanly, and its embedded SHA-256
 * matches the manifest's archive.sha256 stamp. The most-frequent
 * real-world incident for nightly-backup systems is silent failure —
 * the cron stops firing or the upload errors silently for weeks
 * before someone notices. This catches that with a deterministic
 * weekly probe.
 */

import { decrypt, sha256Hex } from './crypto';
import type { B2Config } from './b2';
import { headObject } from './b2';
import type { Env } from './env';

interface HealthOutcome {
  ok: boolean;
  reason: string;
  archiveKey?: string;
  archiveAgeHours?: number;
  manifestSha?: string;
  actualSha?: string;
}

/** YYYY-MM-DD for `n` days ago (UTC). */
function isoDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return d.toISOString().slice(0, 10);
}

export async function runHealthcheck(env: Env, b2Cfg: B2Config): Promise<HealthOutcome> {
  // Look back 0..2 days for the most recent archive — the cron runs
  // at 03:17 UTC nightly, so a Monday 09:00 UTC healthcheck should
  // always see today's or yesterday's date. Two days of slack covers
  // a single missed cron without false-positive paging.
  let archiveKey: string | undefined;
  let manifestKey: string | undefined;
  let archiveAgeHours: number | undefined;

  for (let i = 0; i <= 2; i++) {
    const dateKey = isoDate(i);
    const ak = `archives/${dateKey}.bin`;
    const mk = `manifests/${dateKey}.json`;
    const head = await headObject(b2Cfg, ak).catch(() => null);
    if (head !== null) {
      archiveKey = ak;
      manifestKey = mk;
      const lm = head.headers.get('last-modified');
      if (lm) archiveAgeHours = (Date.now() - Date.parse(lm)) / 3_600_000;
      break;
    }
  }

  if (!archiveKey || !manifestKey) {
    return {
      ok: false,
      reason: 'no archive in B2 for the last 3 days (cron likely stopped firing)',
    };
  }

  // Fetch the manifest + archive via signed GETs. Reuse the B2 client's
  // signature shape with method GET; the existing `putObject` /
  // `headObject` are PUT/HEAD only, so this is a hand-rolled GET via
  // signed fetch.
  const manifest = await fetchSigned(b2Cfg, `${b2Cfg.bucket}/${manifestKey}`);
  if (!manifest.ok) {
    return { ok: false, reason: 'manifest GET failed', archiveKey, manifestSha: undefined };
  }
  const manifestJson = (await manifest.json()) as {
    archive: { sha256: string; byteLength: number };
  };

  const archive = await fetchSigned(b2Cfg, `${b2Cfg.bucket}/${archiveKey}`);
  if (!archive.ok) {
    return { ok: false, reason: 'archive GET failed', archiveKey };
  }
  const archiveBytes = new Uint8Array(await archive.arrayBuffer());
  const actualSha = await sha256Hex(archiveBytes);

  if (actualSha !== manifestJson.archive.sha256) {
    return {
      ok: false,
      reason: 'archive SHA-256 mismatch — bit-rot or upload corruption',
      archiveKey,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  if (archiveBytes.byteLength !== manifestJson.archive.byteLength) {
    return {
      ok: false,
      reason: 'archive byte-length mismatch with manifest',
      archiveKey,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  // Decryption probe — confirms the archive isn't merely well-formed
  // bytes but actually decrypts with the configured key (i.e. a key
  // rotation didn't desynchronise the Worker from the archives).
  try {
    await decrypt(env.encryptionKey, archiveBytes);
  } catch (err) {
    return {
      ok: false,
      reason: `archive decryption failed: ${(err as Error).message}`,
      archiveKey,
      manifestSha: manifestJson.archive.sha256,
      actualSha,
    };
  }

  return {
    ok: true,
    reason: 'archive present + manifest match + decrypts cleanly',
    archiveKey,
    archiveAgeHours,
    manifestSha: manifestJson.archive.sha256,
    actualSha,
  };
}

/**
 * Hand-rolled signed GET. We don't want to fold this into b2.ts
 * because that file's public surface is intentionally narrow (PUT +
 * HEAD only — the backup pipeline never reads back, by design). The
 * healthcheck IS allowed to read; keeping the GET path here means a
 * future Codex / human reviewer reading b2.ts can't accidentally
 * call it from the backup hot path.
 */
async function fetchSigned(cfg: B2Config, path: string): Promise<Response> {
  const url = `https://${cfg.endpoint}/${path}`;
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const amzDate =
    `${dateStamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const payloadHash = await sha256HexStr('');
  const headers: Record<string, string> = {
    host: new URL(url).host,
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
    'GET',
    new URL(url).pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256HexStr(canonicalRequest)].join('\n');

  const kDate = await hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = toHex(await hmac(kSigning, stringToSign));

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;

  return fetch(url, { method: 'GET', headers });
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
