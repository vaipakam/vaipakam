/**
 * SHA-256 as lowercase hex, for the manifest's archive digest, the R2 object
 * digests and the schema hashes.
 *
 * The archive encryption itself is in `./archiveFormat` (#1463). The
 * symmetric AES key this file used to import, and the decrypt that the weekly
 * healthcheck used, were removed with the healthcheck: no code that opens an
 * archive is part of the Worker (design: docs/DesignsAndPlans/BackupSecurityDesign.md §3).
 */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(d);
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).padStart(2, '0');
  }
  return s;
}
