/**
 * Merge hand-authored translation patches into locale bundles.
 *
 *     pnpm --filter @vaipakam/i18n merge-patch -- \
 *         --locales-dir apps/alpha02/src/i18n/locales \
 *         --patches path/to/patches   # <code>.json per locale
 *
 * Pass `--reorder` to additionally normalise each bundle to `en.json`'s
 * key order (and drop keys the template no longer has). Off by default:
 * on a bundle whose order has already drifted it rewrites most of the
 * file, which buries the translations you actually want reviewed. Run
 * it as its own mechanical commit instead.
 *
 * The counterpart to `translate-i18n.ts --missing-only` for the case
 * where the translations did not come from the API: a human translator's
 * hand-back, a vendor delivery, or an agent authoring them inline. Same
 * guarantees either way — existing values are never overwritten unless
 * the patch names that exact key, and anything the patch failed to cover
 * is reported rather than passing as complete.
 *
 * Each patch file is a partial bundle: the same nesting as `en.json`,
 * carrying only the keys being supplied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_LOCALES, LOCALE_NAMES, type LocaleCode } from '../src/glossary.ts';
import {
  deepMerge,
  leafPaths,
  missingSubtree,
  orderLike,
  type Bundle,
} from '../src/bundleOps.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const localesDirArg = flag('--locales-dir');
const patchesDirArg = flag('--patches');
const reorder = args.includes('--reorder');
if (!localesDirArg || !patchesDirArg) {
  console.error('Usage: --locales-dir <path> --patches <path>');
  process.exit(1);
}
// pnpm --filter runs with cwd = the package dir; INIT_CWD is where the
// user actually typed the command, so relative paths resolve as written.
const base = process.env.INIT_CWD ?? process.cwd();
const LOCALES_DIR = path.resolve(base, localesDirArg);
const PATCHES_DIR = path.resolve(base, patchesDirArg);
for (const dir of [LOCALES_DIR, PATCHES_DIR]) {
  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
}

const enJson = JSON.parse(
  fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'),
) as Bundle;

const patchFiles = fs
  .readdirSync(PATCHES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
if (patchFiles.length === 0) {
  console.error(`No .json patches in ${PATCHES_DIR}`);
  process.exit(1);
}

const known = new Set<string>(SUPPORTED_LOCALES);
let failures = 0;

for (const file of patchFiles) {
  const code = path.basename(file, '.json') as LocaleCode;
  if (code === 'en') {
    console.error(`✗ ${file}: en.json is generated from copy.ts — patch that instead`);
    failures += 1;
    continue;
  }
  if (!known.has(code)) {
    console.error(`✗ ${file}: not a supported locale code`);
    failures += 1;
    continue;
  }

  const targetPath = path.join(LOCALES_DIR, `${code}.json`);
  const existing: Bundle = fs.existsSync(targetPath)
    ? (JSON.parse(fs.readFileSync(targetPath, 'utf8')) as Bundle)
    : {};
  const patch = JSON.parse(
    fs.readFileSync(path.join(PATCHES_DIR, file), 'utf8'),
  ) as Bundle;

  const before = missingSubtree(enJson, existing);
  const spliced = deepMerge(existing, patch);
  const merged = reorder ? orderLike(enJson, spliced) : spliced;
  const after = missingSubtree(enJson, merged);

  const filled =
    (before ? leafPaths(before).length : 0) - (after ? leafPaths(after).length : 0);
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');

  const remaining = after ? leafPaths(after).length : 0;
  console.log(
    `✓ ${code} (${LOCALE_NAMES[code]}): filled ${filled}, ${remaining} still missing`,
  );
}

if (failures > 0) process.exitCode = 1;
