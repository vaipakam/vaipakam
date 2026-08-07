#!/usr/bin/env node
/**
 * Run the SHARED translate script against apps/defi's locale bundles.
 *
 *     pnpm --filter @vaipakam/defi translate -- [flags] [codes...]
 *
 * This is a launcher, not a translator: every rule about what may be
 * written — interpolation-token parity, unknown-key and leaf-type
 * rejection, empty-translation rejection, short-response detection,
 * required-literal enforcement, atomic writes — lives in
 * `packages/i18n/scripts/translate-i18n.ts` and is shared with every
 * other surface. apps/defi previously carried a full FORK of that
 * script, which meant only one of the two ever learned a lesson
 * (#1582).
 *
 * Why a launcher rather than a package-script one-liner: the shared
 * script resolves a relative `--locales-dir` against `INIT_CWD`, which
 * is wherever the developer happened to invoke pnpm from — so a
 * relative path in package.json silently points somewhere else
 * depending on the caller's directory. Resolving from THIS file's own
 * location is invariant, and an absolute path makes `INIT_CWD`
 * irrelevant.
 *
 * `--policy` is not passed: the shared script looks for
 * `<locales-dir>/../translation-policy.json` by convention, which is
 * exactly where apps/defi's policy file lives. Passing it explicitly
 * would be a second place to update if it ever moves.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '..', 'src', 'i18n', 'locales');
const SHARED = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'i18n',
  'scripts',
  'translate-i18n.ts',
);

const { status } = spawnSync(
  'tsx',
  [SHARED, '--locales-dir', LOCALES_DIR, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: false },
);

// Propagate the shared script's exit code verbatim. Collapsing a
// failure to 0 here would let a rejected translation response read as
// a successful run.
process.exit(status ?? 1);
