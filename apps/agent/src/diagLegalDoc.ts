/**
 * 2026-05-17 — T-075: legal-document handling for the diagnostics
 * legal-hold flow.
 *
 * When a protocol admin places a hold they upload the authorising
 * legal document (the e-signed order / scanned letter) through the
 * protocol console. This module is the Worker-side receiver: it
 * validates the upload, computes its SHA-256, and stores it in a
 * private R2 bucket.
 *
 * Two properties the rest of the flow relies on:
 *
 *  - **The hash is computed here, server-side, over the exact bytes
 *    received** — so the `legal_doc_sha256` recorded on the hold
 *    provably matches the stored object. The browser also computes
 *    the hash (to put it in the message the admin signs), but that
 *    client value is only ever *compared* against this one, never
 *    trusted as the stored value.
 *  - **The R2 object is content-addressed** — keyed by its own
 *    SHA-256 — so storing is idempotent and the key cannot be
 *    forged to point at a different document than the one hashed.
 */

/** Hard cap on an uploaded legal document. A scanned multi-page
 *  order is comfortably under this; anything larger is rejected
 *  rather than streamed into storage. */
export const MAX_LEGAL_DOC_BYTES = 15 * 1024 * 1024;

/** `%PDF-` — the PDF magic number every real PDF starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** SHA-256 of a byte buffer, lowercase hex. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reject anything that isn't a sane PDF before it touches storage:
 * non-empty, within the size cap, and starting with the PDF magic
 * number. This is a cheap sanity gate, not a full PDF parse — the
 * document is operator-supplied from a legal order, not hostile
 * user input, so deep validation isn't warranted.
 */
export function validateLegalDocument(
  bytes: ArrayBuffer,
): { ok: true } | { ok: false; reason: string } {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'document is empty' };
  }
  if (bytes.byteLength > MAX_LEGAL_DOC_BYTES) {
    return { ok: false, reason: 'document exceeds the 15 MB limit' };
  }
  const head = new Uint8Array(bytes.slice(0, PDF_MAGIC.length));
  if (head.length < PDF_MAGIC.length || !PDF_MAGIC.every((b, i) => head[i] === b)) {
    return { ok: false, reason: 'document is not a PDF' };
  }
  return { ok: true };
}

/** The content-addressed R2 key for a document with the given hash. */
export function legalDocKey(sha256: string): string {
  return `legal-holds/${sha256}.pdf`;
}

/**
 * Store a (pre-validated, pre-hashed) legal document in the private
 * R2 bucket under its content-addressed key. Idempotent — re-storing
 * the same document overwrites the identical object at the same key.
 *
 * @returns the R2 key, which becomes the hold's `legal_doc_ref`.
 */
export async function storeLegalDocument(
  bucket: R2Bucket,
  bytes: ArrayBuffer,
  sha256: string,
): Promise<string> {
  const key = legalDocKey(sha256);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
  });
  return key;
}
