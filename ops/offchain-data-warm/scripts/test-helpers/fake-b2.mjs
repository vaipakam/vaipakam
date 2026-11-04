/**
 * An in-memory B2 for the watcher's and the decrypt tool's tests (#1473).
 * Not a test file itself: the suites under `scripts/*.test.mjs` import it.
 */

import { createHash } from 'node:crypto';

const DAY = 86_400_000;

/**
 * Enough of B2's native API for the watcher: authorize, versioned listing
 * with (name, id) paging, download by id, upload with file info and a
 * compliance retention (refused on a bucket without Object Lock), and a
 * retention update that may only lengthen.
 */
export function fakeB2({ pageSize = 2, now: NOW } = {}) {
  const buckets = new Map();
  const keys = new Map();
  let ids = 0;
  let clock = NOW - 10 * DAY;
  const api = 'https://api005.backblazeb2.com';
  const dl = 'https://f005.backblazeb2.com';
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const keyOf = (auth) => keys.get(auth);

  const b2 = {
    downloads: [],
    // Faults to inject, each used once: {match(path), status, store}. With
    // `store`, the request takes effect and the answer is still the error, as
    // B2 can do.
    faults: [],
    bucket(name, { lock = false } = {}) {
      buckets.set(name, { id: `bkt-${name}`, name, lock, versions: [], bytes: new Map() });
      return b2;
    },
    key(id, { bucket, capabilities, namePrefix = null }) {
      keys.set(id, { id, bucket, capabilities, namePrefix });
      return b2;
    },
    put(bucketName, fileName, body, at) {
      const b = buckets.get(bucketName);
      const fileId = `4_z${b.id}_f${++ids}`;
      const bytes = Buffer.from(body);
      b.versions.push({ action: 'upload', fileName, fileId, uploadTimestamp: at ?? (clock += 1000), contentLength: bytes.byteLength, fileInfo: {}, fileRetention: null });
      b.bytes.set(fileId, bytes);
      return fileId;
    },
    hide(bucketName, fileName) {
      buckets.get(bucketName).versions.push({ action: 'hide', fileName, fileId: `4_zh${++ids}`, uploadTimestamp: (clock += 1000), fileInfo: {} });
    },
    remove(bucketName, match) {
      const b = buckets.get(bucketName);
      b.versions = b.versions.filter((v) => !match(v));
    },
    versions(bucketName) {
      return buckets.get(bucketName).versions;
    },
    async fetch(url, init = {}) {
      const u = new URL(url);
      const i = b2.faults.findIndex((f) => f.match(u.pathname, init));
      if (i >= 0) {
        const [f] = b2.faults.splice(i, 1);
        if (f.store) await b2.handle(url, init);
        return json({ code: 'internal_error', message: 'incident' }, f.status);
      }
      return b2.handle(url, init);
    },
    async handle(url, init = {}) {
      const u = new URL(url);
      if (u.pathname.endsWith('/b2_authorize_account')) {
        const [id] = Buffer.from(init.headers.Authorization.slice(6), 'base64').toString().split(':');
        const k = keys.get(id);
        if (!k) return json({ message: 'bad key' }, 401);
        const b = buckets.get(k.bucket);
        return json({
          accountId: 'acct',
          authorizationToken: id,
          apiInfo: { storageApi: { apiUrl: api, downloadUrl: dl, capabilities: k.capabilities, bucketId: b.id, bucketName: b.name, namePrefix: k.namePrefix } },
        });
      }
      const k = keyOf(init.headers?.Authorization) ?? null;
      const b = k && buckets.get(k.bucket);
      if (u.pathname.endsWith('/b2_list_file_versions')) {
        const body = JSON.parse(init.body);
        const sorted = b.versions
          .filter((v) => v.fileName.startsWith(body.prefix))
          .sort((x, y) => (x.fileName < y.fileName ? -1 : x.fileName > y.fileName ? 1 : y.uploadTimestamp - x.uploadTimestamp));
        let start = 0;
        if (body.startFileName) start = sorted.findIndex((v) => v.fileName === body.startFileName && (!body.startFileId || v.fileId === body.startFileId));
        const page = sorted.slice(start, start + pageSize);
        const next = sorted[start + pageSize];
        const canRead = k.capabilities.includes('readFileRetentions');
        return json({
          files: page.map((v) => ({ ...v, fileRetention: { isClientAuthorizedToRead: canRead, value: canRead ? v.fileRetention : null } })),
          nextFileName: next?.fileName ?? null,
          nextFileId: next?.fileId ?? null,
        });
      }
      if (u.pathname.endsWith('/b2_download_file_by_id')) {
        b2.downloads.push(u.searchParams.get('fileId'));
        const bytes = b.bytes.get(u.searchParams.get('fileId'));
        return bytes ? new Response(bytes) : json({ message: 'not found' }, 404);
      }
      if (u.pathname.endsWith('/b2_get_upload_url')) {
        // B2 hands out upload URLs on its pod hosts, under backblaze.com.
        return json({ uploadUrl: `https://pod-000-1005-03.backblaze.com/upload/${b.name}`, authorizationToken: k.id });
      }
      if (u.pathname.startsWith('/upload/')) {
        if (!k.capabilities.includes('writeFiles')) return json({ message: 'unauthorized' }, 401);
        if (init.headers['X-Bz-File-Retention-Mode'] && !b.lock) return json({ message: 'file lock is not enabled' }, 400);
        const fileInfo = {};
        for (const [h, v] of Object.entries(init.headers)) if (h.startsWith('X-Bz-Info-')) fileInfo[h.slice(10)] = decodeURIComponent(v);
        // B2's own limit on an Object Lock bucket: the name and the file info
        // together, at most 2,048 bytes.
        const infoBytes = Buffer.byteLength(decodeURIComponent(init.headers['X-Bz-File-Name'])) + Object.entries(fileInfo).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
        if (b.lock && infoBytes > 2048) return json({ message: `file name and info are ${infoBytes} bytes, over 2048` }, 400);
        const fileId = `4_z${b.id}_f${++ids}`;
        b.versions.push({
          action: 'upload',
          fileName: decodeURIComponent(init.headers['X-Bz-File-Name']),
          fileId,
          uploadTimestamp: b2.now ?? NOW,
          contentLength: Buffer.byteLength(init.body),
          contentSha1: createHash('sha1').update(init.body).digest('hex'),
          fileInfo,
          fileRetention: { mode: init.headers['X-Bz-File-Retention-Mode'], retainUntilTimestamp: Number(init.headers['X-Bz-File-Retention-Retain-Until-Timestamp']) },
        });
        b.bytes.set(fileId, Buffer.from(init.body));
        return json({ fileId });
      }
      if (u.pathname.endsWith('/b2_update_file_retention')) {
        const body = JSON.parse(init.body);
        const v = b.versions.find((x) => x.fileId === body.fileId);
        if (body.fileRetention.retainUntilTimestamp < v.fileRetention.retainUntilTimestamp) return json({ message: 'cannot shorten' }, 403);
        v.fileRetention = { ...body.fileRetention };
        return json({ fileId: v.fileId });
      }
      return json({ message: `unhandled ${u.pathname}` }, 500);
    },
  };
  return b2;
}
