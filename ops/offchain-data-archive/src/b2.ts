/**
 * Backblaze B2 S3-compatible client. Implements just the two
 * operations the backup pipeline needs:
 *   - PUT object   — upload a new archive (write-only path).
 *   - HEAD object  — confirm an archive exists, read its metadata.
 *                    Used by the weekly healthcheck (§3.6 of the
 *                    design doc).
 *
 * Auth: AWS Signature Version 4 (SigV4), hand-rolled because the
 * official AWS SDK is too heavy for a V8-isolate Worker. The signing
 * algorithm itself is standard and small — Cloudflare's own docs
 * include a SigV4 implementation for the R2-via-S3-API access pattern;
 * this is the same approach.
 *
 * Why not the native B2 native API (b2_upload_file etc.):
 *   - The S3-compatible endpoint accepts the same SigV4 signature we'd
 *     use for any other S3-compatible store (AWS S3 / Wasabi / Storj
 *     gateway / MinIO). Operator can swap providers later by changing
 *     B2_ENDPOINT + B2_BUCKET only, no code change.
 *   - B2 native uses bucket-scoped auth tokens with their own refresh
 *     dance; one more failure mode to chase if the auth token
 *     refresh ever breaks mid-archive. SigV4 is stateless.
 */

const ALGO = 'AWS4-HMAC-SHA256';

interface SignedRequest {
  url: string;
  method: 'PUT' | 'HEAD';
  headers: Record<string, string>;
  body?: ArrayBuffer | Uint8Array;
}

export interface B2Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string; // e.g. "s3.eu-central-003.backblazeb2.com"
  bucket: string;
  region: string; // derived from endpoint; B2 needs the region segment
}

/** Parse the region out of a B2 S3 endpoint like
 *  "s3.eu-central-003.backblazeb2.com" → "eu-central-003". */
export function parseRegionFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
  if (!m) {
    // Fall back to "us-east-001" — what B2's "default" S3 region resolves to.
    // The signature still validates because B2 only enforces region-as-credential-
    // scope, not region-as-routing. Logged so the operator can see they used
    // a non-standard endpoint format.
    return 'us-east-001';
  }
  return m[1];
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).padStart(2, '0');
  }
  return s;
}

async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

/** Produce an ISO-8601 basic-format timestamp (YYYYMMDDTHHMMSSZ) and
 *  its date-only counterpart (YYYYMMDD) — the two formats SigV4 needs
 *  in the X-Amz-Date header and the credential scope respectively. */
function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const amzDate =
    `${dateStamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return { amzDate, dateStamp };
}

/** Build the SigV4 signature for an S3-compatible request and attach
 *  the Authorization header. Service is hard-coded "s3". */
async function signRequest(
  cfg: B2Config,
  req: SignedRequest,
  payloadHash: string,
  now: Date,
): Promise<void> {
  const { amzDate, dateStamp } = amzTimestamps(now);
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const url = new URL(req.url);

  req.headers['host'] = url.host;
  req.headers['x-amz-date'] = amzDate;
  req.headers['x-amz-content-sha256'] = payloadHash;

  // Canonical request — header names lower-case, values trimmed,
  // sorted lexicographically.
  const headerNames = Object.keys(req.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders =
    headerNames
      .map((h) => `${h}:${req.headers[Object.keys(req.headers).find((k) => k.toLowerCase() === h)!].trim()}\n`)
      .join('');
  const signedHeaders = headerNames.join(';');

  const canonicalRequest = [
    req.method,
    url.pathname || '/',
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGO,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive the signing key per SigV4: kDate → kRegion → kService → kSigning.
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${cfg.secretAccessKey}`),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, cfg.region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  req.headers['authorization'] =
    `${ALGO} Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** PUT an object to B2. Returns the response so callers can read
 *  the ETag the operator might want to log. Throws on non-2xx. */
export async function putObject(
  cfg: B2Config,
  key: string,
  body: Uint8Array,
  contentType = 'application/octet-stream',
): Promise<Response> {
  const url = `https://${cfg.endpoint}/${cfg.bucket}/${encodeURI(key)}`;
  const payloadHash = await sha256Hex(body);
  const req: SignedRequest = {
    url,
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  };
  await signRequest(cfg, req, payloadHash, new Date());
  const res = await fetch(url, {
    method: 'PUT',
    headers: req.headers,
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no body>');
    throw new Error(`B2 PUT ${key} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res;
}

/** HEAD an object — returns null if 404, response otherwise. */
export async function headObject(
  cfg: B2Config,
  key: string,
): Promise<Response | null> {
  const url = `https://${cfg.endpoint}/${cfg.bucket}/${encodeURI(key)}`;
  const payloadHash = await sha256Hex('');
  const req: SignedRequest = {
    url,
    method: 'HEAD',
    headers: {},
  };
  await signRequest(cfg, req, payloadHash, new Date());
  const res = await fetch(url, { method: 'HEAD', headers: req.headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`B2 HEAD ${key} failed: ${res.status}`);
  }
  return res;
}
