/**
 * The Backblaze B2 native API, as the backup watcher and the ledger setup
 * use it (#1469, #1473).
 *
 * WHY A MODULE. The watcher holds two keys with different authority, and the
 * property it rests on is that each key holds exactly the capabilities its
 * job needs and is confined to one bucket. Checking that once, here, with one
 * allowlist rule, is what keeps the two callers from disagreeing about it.
 *
 * Every B2 script in this folder signs in and calls through this module
 * (#3032): the watcher, the ledger setup, the decrypt tool, the archive
 * bucket setup, the baseline finder and the lifecycle applier.
 *
 * API VERSION 4 (#3222). A key made by today's B2 CLI (`b2 key create
 * --bucket …`) is refused by the version 3 sign-in, while every older key
 * still signs in on version 4, so version 4 is the only one here. Its
 * sign-in reports a key's bucket restriction as a LIST of buckets
 * (`allowed.buckets`), never as one bucket id, and its key calls take and
 * return `bucketIds`. The version lives in one constant, so no call can
 * drift onto another.
 *
 * Every endpoint comes from B2's own authorize response, and every host is
 * pinned to Backblaze before it is called, so a tampered response cannot
 * redirect a credentialed request elsewhere.
 */

import { createHash } from 'node:crypto';

/** The one B2 native API version every call here uses. */
export const API_VERSION = 'v4';
const AUTHORIZE_URL = `https://api.backblazeb2.com/b2api/${API_VERSION}/b2_authorize_account`;

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
 * `buckets` is the key's bucket restriction as B2 states it: `null` for a key
 * that may reach every bucket in the account, otherwise the buckets it is
 * confined to, each `{id, name}`. A key may be confined to several.
 *
 * @returns {Promise<{token: string, apiUrl: string, downloadUrl: string,
 *   s3ApiUrl: string | null, accountId: string, capabilities: string[],
 *   buckets: {id: string, name: string | null}[] | null,
 *   namePrefix: string | null}>}
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
  const api = data.apiInfo?.storageApi;
  const allowed = api?.allowed;
  // The version 4 shape, and only it. A response without
  // `storageApi.allowed` is not one this module can read a key's authority
  // from, so it is refused rather than read as "no restriction".
  if (!api || !allowed || !Array.isArray(allowed.capabilities)) {
    throw new Error('b2_authorize_account answered without apiInfo.storageApi.allowed; cannot tell what this key may do');
  }
  if (allowed.buckets != null && !Array.isArray(allowed.buckets)) {
    throw new Error('b2_authorize_account answered with a bucket restriction that is not a list');
  }
  return {
    token: data.authorizationToken,
    apiUrl: pinned(api.apiUrl, 'apiUrl'),
    downloadUrl: pinned(api.downloadUrl, 'downloadUrl'),
    s3ApiUrl: api.s3ApiUrl ?? null,
    accountId: data.accountId,
    capabilities: allowed.capabilities,
    buckets: allowed.buckets == null ? null : allowed.buckets.map((b) => ({ id: b.id, name: b.name ?? null })),
    namePrefix: allowed.namePrefix ?? null,
  };
}

/**
 * The one bucket a key is confined to, or why it is not confined to exactly
 * one. A key that may reach every bucket, or several, is not the
 * least-authority key any job here runs on.
 */
export function soleBucket(auth) {
  if (auth.buckets == null) return { ok: false, reason: 'it may reach every bucket in the account' };
  if (auth.buckets.length !== 1) return { ok: false, reason: `it is confined to ${auth.buckets.length} buckets, not one` };
  return { ok: true, bucket: auth.buckets[0] };
}

/** True for the account's master key: it may mint keys and reach every bucket. */
export function isMasterKey(auth) {
  return auth.capabilities.includes('writeKeys') && auth.buckets == null;
}

/**
 * How a listed key (a `b2_list_keys` entry) differs from the scope a setup
 * script would create it with: exactly one bucket, exactly these
 * capabilities, no name prefix. Empty when it matches. Both setup scripts
 * reuse an existing key only when this is empty, so they share one rule.
 */
export function keyScopeDrift(key, { bucketId, capabilities }) {
  const out = [];
  const ids = key.bucketIds ?? null;
  if (!(Array.isArray(ids) && ids.length === 1 && ids[0] === bucketId)) {
    out.push(`buckets ${ids == null ? 'all' : `[${ids.join(', ')}]`}, expected [${bucketId}]`);
  }
  const live = [...(key.capabilities ?? [])].sort();
  const want = [...capabilities].sort();
  if (live.join(',') !== want.join(',')) {
    out.push(`capabilities [${live.join(', ')}], expected [${want.join(', ')}]`);
  }
  if (key.namePrefix) out.push(`name prefix "${key.namePrefix}", expected none`);
  return out;
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
  const sole = soleBucket(auth);
  if (!sole.ok) {
    throw new Error(`the ${label} key is not confined to one bucket (${sole.reason}); use a key scoped to ${bucket} alone`);
  }
  if (sole.bucket.name !== bucket) {
    throw new Error(`the ${label} key is scoped to ${sole.bucket.name ?? 'an unnamed bucket'}, not ${bucket}`);
  }
  if (auth.namePrefix) {
    throw new Error(`the ${label} key is restricted to the name prefix "${auth.namePrefix}" and cannot see the whole bucket`);
  }
  return sole.bucket.id;
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
const IDEMPOTENT = new Set(['b2_list_file_versions', 'b2_get_upload_url', 'b2_update_file_retention', 'b2_list_buckets', 'b2_list_keys', 'b2_update_bucket']);

/**
 * One native API call. A non-2xx answer throws with B2's own message, its
 * status and, when B2 names one, its error `code` (such as
 * `duplicate_key_name`), so a caller can tell a refusal it expects from any
 * other.
 */
export async function call(auth, endpoint, body, io = {}) {
  const res = await send(
    `${auth.apiUrl}/b2api/${API_VERSION}/${endpoint}`,
    { method: 'POST', headers: { Authorization: auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { ...io, retry: IDEMPOTENT.has(endpoint) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    let code;
    try {
      code = JSON.parse(text)?.code;
    } catch {
      code = undefined;
    }
    const err = new Error(`${endpoint} failed: ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    if (typeof code === 'string') err.code = code;
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
  const url = `${auth.downloadUrl}/b2api/${API_VERSION}/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`;
  const res = await send(pinned(url, 'download URL'), { headers: { Authorization: auth.token } }, { ...io, retry: true });
  if (!res.ok) {
    throw new Error(`download of ${fileId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

/**
 * The SHA-256 and length of one file version, computed from the bytes as they
 * arrive, and its first `headBytes` bytes. Nothing past those is kept in
 * memory, so an archive's size is not a limit.
 */
export async function digestById(auth, fileId, { headBytes = 0, ...io } = {}) {
  const res = await download(auth, fileId, io);
  const hash = createHash('sha256');
  let length = 0;
  // The first `headBytes` bytes are kept, so the caller can check a header
  // without a second download; nothing past them is held.
  const head = [];
  let held = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    length += chunk.byteLength;
    if (held < headBytes) {
      const part = chunk.subarray(0, headBytes - held);
      head.push(Buffer.from(part));
      held += part.byteLength;
    }
  }
  return { sha256: hash.digest('hex'), length, head: Buffer.concat(head) };
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
