/**
 * #2443 — whether a script is the one Node was started with, so a module that
 * is both a command and a library (its tests import it) runs its `main` only
 * when started directly.
 *
 * The comparison is between the two REAL files, never between the paths as
 * written. The sanctions services are started through a link
 * (`/opt/vaipakam-sanctions/current/…`, ops/sanctions/), and Node gives the
 * main module the link's TARGET as its `import.meta.url` while
 * `process.argv[1]` keeps the path it was given. Compared as written, the two
 * never matched there: every run skipped its `main` and exited 0, reporting
 * success for work it never did. Resolving both sides also holds under
 * `--preserve-symlinks-main`, where Node keeps the link path instead.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the file
 * `argv1` (default `process.argv[1]`) names, both resolved through any links.
 * False when there is no such file to compare, as under `node -e`, or when
 * Node was started with another script that imported this one.
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
