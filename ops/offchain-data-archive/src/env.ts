/**
 * Typed Worker environment.
 *
 * Two B2 key pairs are exposed — one write-scoped (the nightly
 * uploader), one read-scoped (the weekly healthcheck). The split is
 * a load-bearing security boundary: if the weekly healthcheck shared
 * the nightly uploader's write-only key, the healthcheck's signed
 * GETs would fail at B2's `Unauthorized` boundary every week even
 * when archives are intact (per the round-2 finding on PR #248).
 * Splitting the keys lets us keep the nightly path write-only
 * (so a CF compromise that exfiltrates the write key can't read past
 * archives) AND lets the weekly healthcheck actually fetch + verify.
 * Loss of EITHER scoped key has bounded blast-radius:
 *   - write-key compromise: attacker can corrupt FUTURE backups but
 *     cannot read past archives (no readFiles) and cannot delete
 *     them (no deleteFiles). The immutable-naming nonce + the
 *     weekly healthcheck catch new corrupt uploads.
 *   - read-key compromise: attacker can read past archives but they
 *     are AES-256-GCM ciphertext; the encryption key lives offline
 *     and is not in CF or B2.
 *
 * The CryptoKey field doesn't exist on the raw Cloudflare `Env` —
 * it's derived once at Worker boot from the `BACKUP_ENCRYPTION_KEY`
 * secret and threaded through the rest of the pipeline as a
 * non-extractable WebCrypto handle.
 */

export interface Env {
  // D1 bindings — read-only (the Worker never writes).
  DB_ARCHIVE: D1Database;
  DB_LZ_ALERTS: D1Database;
  // R2 binding — read-only (the Worker never writes to legal-vault).
  R2_LEGAL_VAULT: R2Bucket;
  // Vars (set in wrangler.jsonc).
  B2_ENDPOINT: string;
  B2_BUCKET: string;
  TG_OPS_CHAT_ID: string;
  // Secrets (wrangler secret put).
  BACKUP_ENCRYPTION_KEY: string;
  // Write-scoped B2 Application Key (capabilities:
  // listBuckets + listFiles + writeFiles; bucket-scoped).
  // Used by the nightly backup path. A CF compromise exfiltrating
  // these keys cannot read or delete past archives.
  B2_WRITE_ACCESS_KEY_ID: string;
  B2_WRITE_SECRET_ACCESS_KEY: string;
  // Read-scoped B2 Application Key (capabilities:
  // listBuckets + listFiles + readFiles; bucket-scoped).
  // Used by the weekly healthcheck path only. A CF compromise
  // exfiltrating these keys yields AES ciphertext only — the
  // archive plaintext stays protected by the offline encryption
  // key.
  B2_READ_ACCESS_KEY_ID: string;
  B2_READ_SECRET_ACCESS_KEY: string;
  TG_BOT_TOKEN: string;
  // Derived at boot — not a binding, attached by `withEncryptionKey`.
  encryptionKey: CryptoKey;
}
