/**
 * AES-256-GCM client-side encryption for the nightly off-chain backup
 * archives. Stage A of the off-chain data resilience plan (issue #30 /
 * T-077). See docs/DesignsAndPlans/OffChainDataResilience.md §3.3 for
 * the threat model — TL;DR: client-side encryption ensures that even
 * a fully compromised Backblaze B2 account can't read past archives
 * without the offline key the operator holds outside Cloudflare.
 *
 * Format of an encrypted archive:
 *   byte[ 0..11 ]   — 12-byte random IV (GCM-recommended length).
 *   byte[ 12..N ]   — ciphertext + 16-byte GCM auth tag (appended by
 *                     WebCrypto). The auth tag protects against
 *                     ciphertext tampering — a flipped bit anywhere
 *                     in the encrypted region or the IV makes
 *                     decryption throw.
 *
 * The key is loaded once at Worker boot via `importKey(rawHex)` from
 * the env-injected `BACKUP_ENCRYPTION_KEY` secret. It NEVER leaves the
 * Worker memory in plaintext past that import — every subsequent
 * encryption / decryption hands the CryptoKey handle to WebCrypto,
 * which is opaque to the Worker process.
 */

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

/** Parse a 64-char hex string into a raw AES-256 key. */
export async function importBackupKey(rawHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(rawHex)) {
    throw new Error(
      'BACKUP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256)',
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(rawHex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey('raw', bytes, ALGO, false, ['encrypt', 'decrypt']);
}

/** Encrypt a plaintext buffer with a fresh random IV. */
export async function encrypt(key: CryptoKey, plaintext: ArrayBuffer): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: ALGO, iv }, key, plaintext);
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

/**
 * Decrypt a buffer produced by `encrypt`. Throws if the auth tag
 * doesn't validate (i.e. the ciphertext was tampered with or the
 * key is wrong). Used by the healthcheck path to verify the most
 * recent archive is intact; also called from the restore script
 * (run locally, not in the Worker — see docs/ops/OffChainRestore.md).
 */
export async function decrypt(key: CryptoKey, buf: Uint8Array): Promise<ArrayBuffer> {
  if (buf.byteLength < IV_BYTES + 16) {
    throw new Error('ciphertext too short to contain IV + GCM tag');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const ct = buf.subarray(IV_BYTES);
  return crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
}

/** SHA-256 digest as lowercase hex — used in the archive manifest so
 *  the healthcheck can spot bit-rot / silent storage corruption. */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(d);
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).padStart(2, '0');
  }
  return s;
}
