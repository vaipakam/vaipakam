/**
 * Typed Worker environment. The CryptoKey field doesn't exist on the
 * raw Cloudflare `Env` — it's derived once at Worker boot from the
 * `BACKUP_ENCRYPTION_KEY` secret and threaded through the rest of the
 * pipeline as a non-extractable WebCrypto handle.
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
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_ACCESS_KEY: string;
  TG_BOT_TOKEN: string;
  // Derived at boot — not a binding, attached by `withEncryptionKey`.
  encryptionKey: CryptoKey;
}
