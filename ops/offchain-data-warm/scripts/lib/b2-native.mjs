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

/**
 * A Backblaze host, by name, over https. Anything else is refused before it is
 * called. Two domains, because B2 uses two: the API and download hosts are
 * under `backblazeb2.com`, and the upload URLs `b2_get_upload_url` hands out
 * are on `pod-….backblaze.com`. The match is on whole labels, so a host that
 * merely ends in either string does not pass.
 */
export function isBackblazeHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.port === '' && /(^|\.)(backblaze|backblazeb2)\.com$/.test(u.hostname);
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
export async function authorize(keyId, appKey, io = {}) {
  if (!keyId || !appKey) throw new Error('a B2 key id and application key are required');
  // lgtm[js/file-data-in-outbound-network-request]
  // codeql[js/file-data-in-outbound-network-request]
  // Sending the key to B2's fixed authorize endpoint is this call's purpose:
  // the credential is read from the environment (or, for the one-time setup,
  // the repo `.env`) and goes nowhere else. Every later host comes from this
  // response and is pinned to Backblaze before it is called.
  const { fetchImpl = fetch, sleep = realSleep } = io;
  let res;
  for (let attempt = 0; ; attempt++) {
    // Retried like every idempotent call (see `send`), with the request kept
    // here so the one place the key leaves this process stays in view.
    try {
      res = await fetchImpl(AUTHORIZE_URL, {
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` },
      });
    } catch (e) {
      if (attempt === ATTEMPTS - 1) throw e;
      await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1));
      continue;
    }
    if (res.ok || !isTransientStatus(res.status) || attempt === ATTEMPTS - 1) break;
    await res.body?.cancel?.().catch(() => {});
    await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1));
  }
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

export const ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000];
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failure worth trying again: throttling, a timeout or B2's own fault. */
export function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * One HTTP request, tried up to ATTEMPTS times when `retry` is set and the
 * failure is transient (a network error or a transient status). B2 answers a
 * small share of requests with a 500 "internal incident" and asks clients to
 * retry them (#3048). Returns the last response, ok or not; throws only the
 * last network error. Only a request that is safe to repeat may set `retry`.
 */
async function send(url, init, { fetchImpl = fetch, sleep = realSleep, retry = false } = {}) {
  const tries = retry ? ATTEMPTS : 1;
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1));
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastError = e;
      continue;
    }
    if (res.ok || !isTransientStatus(res.status) || attempt === tries - 1) return res;
    await res.body?.cancel?.().catch(() => {});
  }
  throw lastError;
}

/**
 * The native calls that read, or that leave the same state however often they
 * run, and so are retried. Creating a bucket or a key is not on it.
 */
const IDEMPOTENT = new Set(['b2_list_file_versions', 'b2_get_upload_url', 'b2_update_file_retention', 'b2_list_buckets', 'b2_list_keys']);

/** One native API call. A non-2xx answer throws with B2's own message and its status. */
export async function call(auth, endpoint, body, io = {}) {
  const res = await send(
    `${auth.apiUrl}/b2api/v3/${endpoint}`,
    { method: 'POST', headers: { Authorization: auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { ...io, retry: IDEMPOTENT.has(endpoint) },
  );
  if (!res.ok) {
    const err = new Error(`${endpoint} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
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
export async function listAllVersions(auth, bucketId, prefix, { pageCap = LIST_PAGE_CAP, ...io } = {}) {
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
      io,
    );
    out.push(...(data.files ?? []));
    if (!data.nextFileName) return out;
    // Versions page on the (name, id) pair; the name alone re-reads the
    // first version of that file forever.
    startFileName = data.nextFileName;
    startFileId = data.nextFileId ?? null;
  }
}

async function download(auth, fileId, io) {
  const url = `${auth.downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`;
  const res = await send(pinned(url, 'download URL'), { headers: { Authorization: auth.token } }, { ...io, retry: true });
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
export async function digestById(auth, fileId, io = {}) {
  const res = await download(auth, fileId, io);
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    length += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), length };
}

/**
 * One small file version's bytes, or `null` past `maxBytes`. Oversize is a
 * fact about the file, which a caller judges; a failed download is an error.
 */
export async function bytesById(auth, fileId, { maxBytes = 1 << 20, ...io } = {}) {
  const res = await download(auth, fileId, io);
  const parts = [];
  let length = 0;
  for await (const chunk of res.body) {
    length += chunk.byteLength;
    if (length > maxBytes) {
      await res.body.cancel?.().catch(() => {});
      return null;
    }
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
 *
 * The upload itself is tried ONCE. A failed upload is indeterminate: B2 can
 * store a file and still answer with an error, and a request cut off in
 * flight can still commit after the caller has given up on it. A second
 * upload in the same run could then leave a second compliance-locked version,
 * which the watcher reads as tampering, and no listing taken now can rule
 * that out. So a transient failure (a network error, 408, 429 or 5xx) throws
 * with `transient` set, for the caller to leave to the next run, when the
 * first request has long settled and the run's own listing says whether it
 * landed. Anything else is a refusal and throws plainly.
 */
export async function uploadLocked(auth, bucketId, { fileName, bytes, contentType, fileInfo, retainUntil }, io = {}) {
  const target = await call(auth, 'b2_get_upload_url', { bucketId }, io);
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
  const url = pinned(target.uploadUrl, 'upload URL');
  let res;
  try {
    res = await (io.fetchImpl ?? fetch)(url, { method: 'POST', headers, body: bytes });
  } catch (e) {
    throw Object.assign(new Error(`upload of ${fileName} failed: network: ${String(e?.message ?? e).slice(0, 200)}`), { transient: true });
  }
  if (res.ok) return res.json();
  // The body is diagnostics only; failing to read it changes nothing.
  const text = await res.text().catch(() => '<no body>');
  throw Object.assign(new Error(`upload of ${fileName} failed: ${res.status} ${text.slice(0, 300)}`), {
    transient: isTransientStatus(res.status),
  });
}

/** Lengthen one version's compliance retention. B2 refuses a shortening. */
export async function extendRetention(auth, { fileName, fileId, retainUntil }, io = {}) {
  return call(
    auth,
    'b2_update_file_retention',
    { fileName, fileId, fileRetention: { mode: 'compliance', retainUntilTimestamp: retainUntil } },
    io,
  );
}
