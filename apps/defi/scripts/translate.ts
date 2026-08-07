#!/usr/bin/env tsx
/**
 * Run the SHARED translate script against apps/defi's locale bundles.
 *
 *     pnpm --filter @vaipakam/defi translate -- [flags] [codes...]
 *
 * This is a launcher plus ONE app-specific preflight — it contains no
 * translation logic. Every rule about what may be written
 * (interpolation-token parity, unknown-key and leaf-type rejection,
 * empty-translation rejection, short-response detection, required-
 * literal enforcement, atomic writes) lives in
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_CONFIRM_WORD } from '../src/lib/recoveryConfirm.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(HERE, '..', 'src', 'i18n', 'locales');
const POLICY_PATH = path.resolve(HERE, '..', 'src', 'i18n', 'translation-policy.json');
const SHARED = path.resolve(
  HERE, '..', '..', '..', 'packages', 'i18n', 'scripts', 'translate-i18n.ts',
);

/**
 * App-specific preflight, kept when the fork was deleted.
 *
 * The shared script enforces the literals the POLICY FILE declares; it
 * has no reason to know that `VaultRecover` compares typed input
 * against `RECOVERY_CONFIRM_WORD`. If that constant changes and the
 * policy keeps the old word, the shared script would happily enforce
 * the OBSOLETE literal — spending API calls and rewriting bundles that
 * preserve a word the gate can no longer accept.
 *
 * `translationPolicy.test.ts` covers the same drift in CI, which is the
 * stronger guard because it blocks a PR. This one exists because
 * `translate` is run by hand and does not run that test: it is the
 * difference between finding out now and finding out after the API
 * bill and the diff (Codex #1595 r1).
 */
function assertConfirmWordPolicy(): void {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')) as {
    requiredLiterals?: Record<string, string[]>;
  };
  const declared = policy.requiredLiterals?.['vaultRecover.modalConfirmPrompt'] ?? [];
  // Exactly one: the gate compares against a single word, so a policy
  // naming two would let a locale satisfy the check with the wrong one.
  if (declared.length !== 1 || declared[0] !== RECOVERY_CONFIRM_WORD) {
    console.error(
      `translation-policy.json requiredLiterals["vaultRecover.modalConfirmPrompt"] is ` +
        `${JSON.stringify(declared)}, expected exactly ["${RECOVERY_CONFIRM_WORD}"] — ` +
        'the word VaultRecover compares typed input against.',
    );
    process.exit(1);
  }
}

/**
 * `--missing` was this command's documented way to ask for "only the
 * locales with no bundle yet". The shared script spells that as the
 * DEFAULT mode and rejects unknown flags, so forwarding it verbatim
 * would turn a previously-documented invocation into an error. Since
 * the two mean the same thing, translate rather than break it
 * (Codex #1595 r1).
 */
function mapLegacyFlags(argv: string[]): string[] {
  return argv.flatMap((a) => {
    if (a !== '--missing') return [a];
    console.log(
      '`--missing` is the shared script\'s default mode — dropping the flag.',
    );
    return [];
  });
}

assertConfirmWordPolicy();

const { status } = spawnSync(
  'tsx',
  [SHARED, '--locales-dir', LOCALES_DIR, ...mapLegacyFlags(process.argv.slice(2))],
  { stdio: 'inherit', shell: false },
);

// Propagate the shared script's exit code verbatim. Collapsing a
// failure to 0 here would let a rejected translation response read as
// a successful run.
process.exit(status ?? 1);
