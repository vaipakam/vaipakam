/**
 * Size limits shared by the nightly, the healthcheck and the backup watcher
 * (#1473). One copy, so the watcher's "larger than the nightly can write"
 * cannot drift from what the nightly actually writes.
 *
 * Deliberately imports nothing, so `node --test` and the watcher can load it
 * directly without the Worker bundler.
 */

/**
 * The nightly's hard ceiling on an archive's plaintext. Cloudflare Workers'
 * isolate cap is 128 MB; 100 MB leaves headroom for stack and transient
 * buffers during encryption and upload. The nightly aborts above it.
 */
export const MAX_ARCHIVE_BYTES = 100_000_000;

/**
 * What the current (symmetric) format adds to the plaintext: a 12-byte IV
 * and a 16-byte GCM tag. The public-key format of slice 2 (#1463) changes
 * this and must update it with the format.
 */
export const ARCHIVE_FORMAT_OVERHEAD_BYTES = 28;

/** The largest archive object the nightly can store. */
export const MAX_STORED_ARCHIVE_BYTES = MAX_ARCHIVE_BYTES + ARCHIVE_FORMAT_OVERHEAD_BYTES;

/** A manifest is a few hundred bytes; anything near this is hostile. */
export const MAX_MANIFEST_BYTES = 256_000;
