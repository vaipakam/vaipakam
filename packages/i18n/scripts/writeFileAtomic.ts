/**
 * Atomic file replacement for the translation SCRIPTS.
 *
 * Deliberately NOT in `src/bundleOps.ts`, and not exported from the
 * package barrel. `src/` is browser-facing — `apps/www` and
 * `apps/alpha02` import `@vaipakam/i18n` into client code — so a
 * `node:fs` import there breaks their typecheck outright and would
 * drag a filesystem dependency into a browser bundle. The scripts are
 * the only consumers; sharing between them belongs here, not one level
 * up (Codex #1563 r22 asked for it shared, and I shared it in the
 * wrong place).
 */
import fs from 'node:fs';

/**
 * Write `contents` to `target` without ever leaving it partially
 * written: a temp file beside it, then an atomic same-directory
 * rename. The temp file is removed if anything fails.
 *
 * Catching a write error is not enough on its own — `writeFileSync`
 * TRUNCATES the destination before it writes, so a disk that fills
 * mid-write leaves the locale empty or half-written while the caller
 * reports a tidy failure over a bundle that has already lost its
 * translations (Codex #1563 r21).
 */
export function writeFileAtomic(target: string, contents: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}
