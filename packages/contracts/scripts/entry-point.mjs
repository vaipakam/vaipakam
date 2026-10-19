/**
 * #2443 — whether a script is the one Node was started with, so a module that
 * is both a command and a library (its tests import it) runs its `main` only
 * when started directly.
 *
 * Node answers this itself, as `import.meta.main`, from the file it resolved
 * when it started. That answer compares no paths. The sanctions services are
 * started through a link (`/opt/vaipakam-sanctions/current/…`, ops/sanctions/)
 * that the installer repoints, and a comparison of paths failed there twice
 * over: `process.argv[1]` keeps the link while Node loads the link's target,
 * so the two never matched as written and every run skipped its `main` and
 * exited 0 having done nothing. Resolving the link again later would race a
 * repoint made while the run was loading.
 *
 * `import.meta.main` is Node 22.18 and later; the installer requires it for
 * the services. The workspace still allows earlier Node 22 releases, where it
 * is absent. There, being imported must keep working (the tests import these
 * modules), and being started must never quietly skip `main`, which would
 * report success for work not done. So on such a Node, anything that looks
 * like a direct start is an error, and only what plainly is not one answers
 * false.
 */
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module whose `import.meta` is `meta` is the one Node was
 * started with; false when another script imported it. On a Node that does
 * not set `import.meta.main`, throws when `argv1` (default
 * `process.argv[1]`) looks like a start of this module.
 */
export function isEntryPoint(meta, argv1 = process.argv[1]) {
  if (typeof meta.main === 'boolean') return meta.main;
  if (looksStartedDirectly(fileURLToPath(meta.url), argv1)) {
    throw new Error(`Node ${process.versions.node} does not set import.meta.main, so this script cannot tell for certain that it was started directly: run it with Node 22.18 or newer`);
  }
  return false;
}

/**
 * Whether `argv1` names `file` by its own name, through links at any depth,
 * or resolves to it now. Each test alone misses a case the other covers: a
 * link to the file under another name, and a link the installer repointed
 * after Node resolved it. A wrong "yes" only raises an error; neither test can
 * turn a start into a quiet "no" unless both miss at once.
 */
function looksStartedDirectly(file, argv1) {
  if (!argv1) return false;
  if (basename(argv1) === basename(file)) return true;
  try {
    return realpathSync(argv1) === realpathSync(file);
  } catch {
    return false;
  }
}
