/**
 * #2443 — whether a script is the one Node was started with, so a module that
 * is both a command and a library (its tests import it) runs its `main` only
 * when started directly.
 *
 * Node answers this itself, as `import.meta.main`, from the file it resolved
 * when it started. Nothing here compares paths. The sanctions services are
 * started through a link (`/opt/vaipakam-sanctions/current/…`, ops/sanctions/)
 * that the installer repoints, and a comparison of paths failed there twice
 * over: `process.argv[1]` keeps the link while Node loads the link's target,
 * so the two never matched as written and every run skipped its `main` and
 * exited 0 having done nothing. Resolving the link again later would race a
 * repoint made while the run was loading.
 *
 * `import.meta.main` is Node 22.18 and later. On an older Node it is absent,
 * and that is an error here rather than a quiet `false`, which would skip
 * `main` and report success again.
 */

/**
 * True when the module whose `import.meta` is `meta` is the one Node was
 * started with; false when another script imported it. Throws when this Node
 * does not report it.
 */
export function isEntryPoint(meta) {
  if (typeof meta.main !== 'boolean') {
    throw new Error(`Node ${process.versions.node} does not set import.meta.main, so this script cannot tell whether it was started directly: Node 22.18 or newer is needed`);
  }
  return meta.main;
}
