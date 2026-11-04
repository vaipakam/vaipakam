/**
 * Typed Worker environment.
 *
 * The Worker is WRITE-ONLY in every sense (#1463, #1469; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §4):
 *
 *   - It holds ONE B2 key, write-scoped (`listBuckets` + `writeFiles`). It
 *     cannot list, read or delete an archive, and it never learns an existing
 *     archive's name.
 *   - It holds NO decryption key. Each archive is encrypted to the recipient
 *     public keys committed in `backup-recipients/recipients.json` and bundled
 *     at build time; the private keys are offline. So a compromise of this
 *     Worker yields no plaintext from any archive it wrote.
 *
 * The read key, the weekly healthcheck that used it and the symmetric
 * `BACKUP_ENCRYPTION_KEY` were removed in slice 2. The checks the healthcheck
 * made now run in the backup watcher (`scripts/backup-ledger.mjs`), outside
 * Cloudflare, under its own keys.
 */

export interface Env {
  // D1 binding — read-only (the Worker never writes).
  DB_ARCHIVE: D1Database;
  // R2 binding — read-only (the Worker never writes to legal-vault).
  R2_LEGAL_VAULT: R2Bucket;
  // Operator-configured (wrangler secret put; see wrangler.jsonc for why).
  B2_ENDPOINT: string;
  B2_BUCKET: string;
  TG_OPS_CHAT_ID: string;
  // Write-scoped B2 Application Key (capabilities: listBuckets + writeFiles;
  // bucket-scoped — NOT listFiles, #1450 r27). A compromise exfiltrating it
  // can write FUTURE archives (each one caught by the watcher as an extra
  // version or an ambiguous period) and cannot read, list or delete any.
  B2_WRITE_ACCESS_KEY_ID: string;
  B2_WRITE_SECRET_ACCESS_KEY: string;
  TG_OPS_BOT_TOKEN: string;
}
