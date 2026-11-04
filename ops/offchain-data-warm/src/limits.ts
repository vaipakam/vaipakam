/**
 * Size limits shared by the nightly and the backup watcher
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
 * The most the archive format (`./archiveFormat`, #1463) adds to the
 * plaintext: the 11-byte prefix (magic and header length), a header of at
 * most MAX_HEADER_BYTES (16,384) and the 16-byte GCM tag. Written out here
 * rather than imported, so this file keeps importing nothing; a test pins it
 * to the format's own constants.
 */
export const ARCHIVE_FORMAT_OVERHEAD_BYTES = 11 + 16_384 + 16;

/** The largest archive object the nightly can store. */
export const MAX_STORED_ARCHIVE_BYTES = MAX_ARCHIVE_BYTES + ARCHIVE_FORMAT_OVERHEAD_BYTES;

/** A manifest is a few hundred bytes; anything near this is hostile. */
export const MAX_MANIFEST_BYTES = 256_000;
