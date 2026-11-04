/**
 * Module hooks that let `node --test` load the Worker's own source (#1463).
 *
 * The Worker is bundled by wrangler, so its files import each other without
 * extensions and import `recipients.json` without an import attribute. Node
 * needs both spelled out. These hooks supply them for files under `src/` and
 * for the committed recipients file only, so the nightly itself can be run in
 * a test, rather than a copy of it.
 */

import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, next) {
  const fromSrc = context.parentURL?.includes('/ops/offchain-data-warm/src/');
  if (fromSrc && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('/backup-recipients/recipients.json')) {
    return { format: 'module', source: `export default ${await readFile(new URL(url), 'utf8')};`, shortCircuit: true };
  }
  return next(url, context);
}
