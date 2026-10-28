/**
 * The Backblaze B2 native API, as the backup watcher and the ledger setup
 * use it (#1469, #1473).
 *
 * WHY A MODULE. The watcher holds two keys with different authority, and the
 * property it rests on is that each key holds exactly the capabilities its
 * job needs and is confined to one bucket. Checking that once, here, with one
 * allowlist rule, is what keeps the two callers from disagreeing about it.
 *
 * The older scripts in this folder (`setup-backblaze.mjs`,
 * `find-archive-baselines.mjs`) still carry their own copies of `authorize`
 * and the POST helper; moving them onto this module is #3032, kept apart so
 * this change does not alter two scripts it cannot test against a live
 * account.
 *
 * Every endpoint comes from B2's own authorize response, and every host is
 * pinned to Backblaze before it is called, so a tampered response cannot
 * redirect a credentialed request elsewhere.
 */

import { createHash } from 'node:crypto';

const AUTHORIZE_URL = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';

/** A Backblaze host, by name. Anything else is refused before it is called. */
export function isBackblazeHost(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return /(^|\.)backblazeb2\.com$/.test(host) && new URL(url).protocol === 'https:';
}

function pinned(url, what) {
  if (!isBackblazeHost(url)) {
    throw new Error(`refusing to call a non-Backblaze ${what}: ${String(url).slice(0, 120)}`);
  }
  return url;
}

/**
 * Authorize a key and report what it can do.
 *
 * @returns {Promise<{token: string, apiUrl: string, downloadUrl: string,
 *   accountId: string, capabilities: string[], bucketId: string | null,
 *   bucketName: string | null, namePrefix: string | null}>}
 */
export async function authorize(keyId, appKey, { fetchImpl = fetch } = {}) {
  if (!keyId || !appKey) throw new Error('a B2 key id and application key are required');
  const res = await fetchImpl(AUTHORIZE_URL, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` },
  });
  if (!res.ok) {
    throw new Error(`b2_authorize_account failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const api = data.apiInfo?.storageApi ?? {};
  return {
    token: data.authorizationToken,
    apiUrl: pinned(api.apiUrl ?? data.apiUrl, 'apiUrl'),
    downloadUrl: pinned(api.downloadUrl ?? data.downloadUrl, 'downloadUrl'),
    accountId: data.accountId ?? api.accountId,
    capabilities: api.capabilities ?? data.allowed?.capabilities ?? [],
    bucketId: api.bucketId ?? data.allowed?.bucketId ?? null,
    bucketName: api.bucketName ?? data.allowed?.bucketName ?? null,
    namePrefix: api.namePrefix ?? data.allowed?.namePrefix ?? null,
  };
}

/**
 * Refuse a key whose authority differs from the job's, in either direction.
 *
 * `allowed` is an ALLOWLIST: a capability outside it is refused, so a key
 * that can also delete, or bypass a retention, cannot be used by accident.
 * `required` is what the job cannot run without. The key must be confined to
 * `bucket`, and to the whole of it: a key restricted to a name prefix sees
 * only part of the bucket, and every check built on its listing would be a
 * check of that part.
 */
export function requireScope(auth, { label, bucket, allowed, required }) {
  const caps = auth.capabilities ?? [];
  const extra = caps.filter((c) => !allowed.includes(c));
  if (extra.length > 0) {
    throw new Error(
      `the ${label} key holds capabilities this job must not have: ${extra.join(', ')} ` +
        `(allowed: ${allowed.join(', ')})`,
    );
  }
  const missing = required.filter((c) => !caps.includes(c));
  if (missing.length > 0) {
    throw new Error(`the ${label} key is missing required capabilities: ${missing.join(', ')}`);
  }
  if (!auth.bucketId) {
    throw new Error(`the ${label} key is not confined to one bucket; use a key scoped to ${bucket}`);
  }
  if (auth.bucketName !== bucket) {
    throw new Error(`the ${label} key is scoped to ${auth.bucketName ?? 'an unnamed bucket'}, not ${bucket}`);
  }
  if (auth.namePrefix) {
    throw new Error(`the ${label} key is restricted to the name prefix "${auth.namePrefix}" and cannot see the whole bucket`);
  }
  return auth.bucketId;
}

/** One native API call. A non-2xx answer throws with B2's own message. */
export async function call(auth, endpoint, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${auth.apiUrl}/b2api/v3/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${endpoint} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

export const LIST_PAGE_CAP = 500;

/**
 * Every file VERSION under `prefix`, hide markers included.
 *
 * Versions, never names: a plain name listing shows only the current version,
 * so an overwrite or a hide would replace what a reader sees. A listing that
 * does not finish within the page cap throws rather than returning part of
 * the bucket, because every check built on it would then be a check of that
 * part.
 */
export async function listAllVersions(auth, bucketId, prefix, { fetchImpl = fetch, pageCap = LIST_PAGE_CAP } = {}) {
  const out = [];
  let startFileName = null;
  let startFileId = null;
  for (let page = 0; ; page++) {
    if (page >= pageCap) {
      throw new Error(`listing ${prefix} did not finish within ${pageCap} pages; refusing a partial listing`);
    }
    const data = await call(
      auth,
      'b2_list_file_versions',
      {
        bucketId,
        prefix,
        maxFileCount: 1000,
        ...(startFileName ? { startFileName } : {}),
        ...(startFileId ? { startFileId } : {}),
      },
      { fetchImpl },
    );
    out.push(...(data.files ?? []));
    if (!data.nextFileName) return out;
    // Versions page on the (name, id) pair; the name alone re-reads the
    // first version of that file forever.
    startFileName = data.nextFileName;
    startFileId = data.nextFileId ?? null;
  }
}

async function download(auth, fileId, fetchImpl) {
  const url = `${auth.downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`;
  const res = await fetchImpl(pinned(url, 'download URL'), { headers: { Authorization: auth.token } });
  if (!res.ok) {
    throw new Error(`download of ${fileId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

/**
 * The SHA-256 and length of one file version, computed from the bytes as they
 * arrive. Nothing is kept in memory past the digest, so an archive's size is
 * not a limit.
 */
export async function digestById(auth, fileId, { fetchImpl = fetch } = {}) {
  const res = await download(auth, fileId, fetchImpl);
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), length };
}

/** One small file version's bytes, refused past `maxBytes`. */
export async function bytesById(auth, fileId, { fetchImpl = fetch, maxBytes = 1 << 20 } = {}) {
  const res = await download(auth, fileId, fetchImpl);
  const parts = [];
  let length = 0;
  for await (const chunk of res.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error(`${fileId} is larger than ${maxBytes} bytes; refusing to read it`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * Upload one file under a compliance-mode retention.
 *
 * Compliance mode is the point: nobody, the master key included, can delete
 * the version or shorten its retention before `retainUntil`. The upload is
 * refused outright when the bucket has no Object Lock, which is what keeps a
 * misconfigured ledger bucket from being used as if it were locked.
 */
export async function uploadLocked(auth, bucketId, { fileName, bytes, contentType, fileInfo, retainUntil }, { fetchImpl = fetch } = {}) {
  const target = await call(auth, 'b2_get_upload_url', { bucketId }, { fetchImpl });
  const headers = {
    Authorization: target.authorizationToken,
    'X-Bz-File-Name': encodeURIComponent(fileName).replace(/%2F/g, '/'),
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'X-Bz-Content-Sha1': createHash('sha1').update(bytes).digest('hex'),
    'X-Bz-File-Retention-Mode': 'compliance',
    'X-Bz-File-Retention-Retain-Until-Timestamp': String(retainUntil),
  };
  for (const [k, v] of Object.entries(fileInfo ?? {})) {
    headers[`X-Bz-Info-${k}`] = encodeURIComponent(String(v));
  }
  const res = await fetchImpl(pinned(target.uploadUrl, 'upload URL'), { method: 'POST', headers, body: bytes });
  if (!res.ok) {
    throw new Error(`upload of ${fileName} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** Lengthen one version's compliance retention. B2 refuses a shortening. */
export async function extendRetention(auth, { fileName, fileId, retainUntil }, { fetchImpl = fetch } = {}) {
  return call(
    auth,
    'b2_update_file_retention',
    { fileName, fileId, fileRetention: { mode: 'compliance', retainUntilTimestamp: retainUntil } },
    { fetchImpl },
  );
}
