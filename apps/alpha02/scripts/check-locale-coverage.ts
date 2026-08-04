/**
 * Guardrail (#1560, #1362): fail if a locale advertised in
 * `TRANSLATED_LOCALES` has fallen behind `locales/en.json`, or if one of
 * its strings mangles an interpolation token.
 *
 *     pnpm --filter @vaipakam/alpha02 i18n:coverage
 *
 * `enTemplate.test.ts` guards copy.ts → en.json. NOTHING guarded
 * en.json → <locale>.json, and the gap was not theoretical: nine
 * locales had silently drifted 291 keys behind, including every string
 * on the stuck-token recovery page. i18next falls back to the English
 * `defaultValue` per key, so the app never breaks — a user who picked
 * Tamil just gets a page that switches to English partway down. That is
 * precisely the kind of failure a build should catch instead of a user,
 * and it is invisible in review because every bundle looks complete.
 *
 * WHY A SCRIPT, NOT A VITEST. Both would gate — alpha02's vitest suite
 * is blocking via `defi-vitest.yml` (#1111), and `typecheck` is a
 * required check too. It is a script because it belongs next to
 * `check-hardcoded-strings.mjs`, the guardrail for the sibling failure
 * (a string never reaching the catalog at all): same command surface,
 * same place to look, and one consolidated report across every locale
 * instead of a per-locale assertion that stops at the first arm. It is
 * also runnable on its own — `pnpm i18n:coverage` — which is what you
 * want mid-translation, without booting a test runner.
 *
 * The `{}` placeholder bundles for locales OUTSIDE `TRANSLATED_LOCALES`
 * are deliberate and out of scope: they exist so URL routing and the
 * language picker have a file to resolve, and English fallback is the
 * documented behaviour there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  leafPaths,
  leafTypeDrift,
  missingSubtree,
  placeholderDrift,
  type Bundle,
} from '@vaipakam/i18n';
import { TRANSLATED_LOCALES } from '../src/i18n/localeConfig.ts';

const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'i18n',
  'locales',
);

/**
 * The exact `(key, locale)` pairs still untranslated, tracked as #1560
 * follow-up. Generated — regenerate with `pnpm i18n:coverage --prune`,
 * which can only REMOVE entries.
 *
 * Per-PAIR, not per-section, and that precision is the point (Codex
 * #1563 r2). A section-prefix allowlist stayed active until the LAST
 * locale finished it, so during the ordinary window where one locale is
 * done and the others aren't, deleting a key from the finished locale
 * was still excused — the guard passed while that locale silently
 * regressed to English. A pair excuses exactly one locale's one key and
 * nothing else, so filling a section for `fr` immediately protects `fr`
 * from losing it again, even while `ta` is still pending.
 *
 * Shrink it — never grow it. A newly shipped surface belongs in the
 * translation pass that ships it, not here.
 */
const BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'i18n',
  'untranslated-baseline.json',
);
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = JSON.parse(
  fs.readFileSync(BASELINE_PATH, 'utf8'),
) as Record<string, string[]>;

/** Is this locale's missing key one of the recorded, still-open gaps? */
const isKnownGap = (code: string, key: string): boolean =>
  KNOWN_GAPS[key]?.includes(code) ?? false;

/**
 * Leaves where a locale legitimately omits an interpolation token the
 * English carries. Keyed `<locale>:<path>`, and every entry names the
 * EXACT token it excuses plus a linguistic reason.
 *
 * Binding to the token, not just the leaf, is the point (Codex #1563
 * r1): a bare leaf-level exemption would keep passing if the English
 * string later gained a SECOND live value and the locale dropped that
 * one too — silently deleting a real value from the sentence under an
 * exemption granted for something else.
 *
 * Introducing an UNKNOWN token has no escape hatch at all: i18next has
 * nothing to substitute, so the user sees literal braces.
 */
const ALLOWED_OMISSIONS: Readonly<
  Record<string, { tokens: readonly string[]; reason: string }>
> = {
  // Arabic has a grammatical dual: the `_two` form already means "two
  // days" in the noun itself ("يومان"), so restating {{count}} would
  // render "2 يومان" — "2 two-days".
  'ar:copy.units.durationDay_two': {
    tokens: ['count, number'],
    reason: 'Arabic dual encodes the count in the noun',
  },
  'ar:copy.units.durationMonth_two': {
    tokens: ['count, number'],
    reason: 'Arabic dual encodes the count in the noun',
  },
  'ar:copy.units.durationYear_two': {
    tokens: ['count, number'],
    reason: 'Arabic dual encodes the count in the noun',
  },
};

/** Is every dropped token covered by this leaf's exemption? */
function omissionAllowed(code: string, leafPath: string, dropped: string[]): boolean {
  const exemption = ALLOWED_OMISSIONS[`${code}:${leafPath}`];
  if (!exemption) return false;
  return dropped.every((token) => exemption.tokens.includes(token));
}

/**
 * Strings that must survive translation VERBATIM because the app
 * compares user input against them, keyed by their catalog path.
 *
 * The glossary the translation prompt carries is guidance, and
 * `verifyGlossaryPreserved` downgrades a loss to a warning — neither
 * can stop a locale shipping with this broken, and the coverage checks
 * above look only at keys and interpolation tokens (Codex #1563 r1).
 *
 * `CONFIRM` is the live case: `Recover.tsx` compares the user's typed
 * input against the English literal `CONFIRM_WORD`. A locale that
 * translated the prompt would tell the user to type a word that can
 * never match, permanently disabling signing on the recovery page for
 * every speaker of that language — a dead end with no error message,
 * because from the app's side the user simply hasn't typed it yet.
 */
const REQUIRED_LITERALS: Readonly<Record<string, readonly string[]>> = {
  'copy.recover.confirmPrompt': ['CONFIRM'],
};

/**
 * Does `value` contain `literal` as a STANDALONE token?
 *
 * Substring matching was not enough (Codex #1563 r2): Spanish
 * "Escribe CONFIRMAR" and English "Type CONFIRMATION" both contain
 * `CONFIRM` while instructing the user to type something that can
 * never equal it — the exact dead end the check exists to prevent.
 *
 * The boundary is ASCII-alphanumeric only, deliberately. The failure
 * mode is a Latin word EXTENDING the token (CONFIRMAR / CONFIRMATION);
 * a locale that abuts it with its own script — Japanese
 * "CONFIRMと入力" — is typing the right word and must pass.
 */
function containsToken(value: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(value);
}

/** Read a dot-path leaf, or undefined. */
function leafAt(bundle: Bundle, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' && !Array.isArray(node)
          ? (node as Record<string, unknown>)[key]
          : undefined,
      bundle,
    );
}

const read = (code: string): Bundle =>
  JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'),
  ) as Bundle;

const en = read('en');
const translated = TRANSLATED_LOCALES.filter((code) => code !== 'en');
const problems: string[] = [];

for (const code of translated) {
  const file = path.join(LOCALES_DIR, `${code}.json`);
  if (!fs.existsSync(file)) {
    problems.push(`${code}: locales/${code}.json is missing entirely`);
    continue;
  }
  const bundle = read(code);

  const missing = missingSubtree(en, bundle);
  const unexplained = (missing ? leafPaths(missing) : []).filter(
    (key) => !isKnownGap(code, key),
  );
  if (unexplained.length > 0) {
    problems.push(
      `${code}: missing ${unexplained.length} key(s) — ${unexplained
        .slice(0, 8)
        .join(', ')}${unexplained.length > 8 ? ', …' : ''}`,
    );
  }

  for (const { path: key, unknown, dropped, malformed } of placeholderDrift(en, bundle)) {
    if (unknown.length > 0) {
      problems.push(
        `${code}: ${key} introduces {{${unknown.join('}}, {{')}}} — not in the English`,
      );
    }
    if (dropped.length > 0 && !omissionAllowed(code, key, dropped)) {
      problems.push(
        `${code}: ${key} drops {{${dropped.join('}}, {{')}}} present in the English`,
      );
    }
    if (malformed.length > 0) {
      problems.push(
        `${code}: ${key} has malformed brace run(s) ${malformed.join(', ')} — ` +
          'i18next renders these literally',
      );
    }
  }

  // A leaf that is present but not a string renders as NOTHING in
  // i18next (it only logs), so a key-count check calls the locale
  // complete while the sentence is blank.
  for (const { path: key, expected, actual } of leafTypeDrift(en, bundle)) {
    problems.push(`${code}: ${key} is ${actual}, expected ${expected}`);
  }

  // Typed-confirmation words must survive verbatim or the gate they
  // guard becomes unpassable in that language.
  for (const [key, literals] of Object.entries(REQUIRED_LITERALS)) {
    const value = leafAt(bundle, key);
    if (typeof value !== 'string') continue; // absent/drifted — reported above
    for (const literal of literals) {
      if (!containsToken(value, literal)) {
        problems.push(
          `${code}: ${key} must contain the standalone token "${literal}" — the app ` +
            'compares typed input against it, so a translated or extended word can never match',
        );
      }
    }
  }
}

// A recorded gap a locale has since FILLED must leave the baseline, or
// the exemption quietly re-opens that key to regression for that
// locale. Checked per pair, so a section finished for one language is
// protected there while it is still pending elsewhere.
const stalePairs: string[] = [];
for (const [key, codes] of Object.entries(KNOWN_GAPS)) {
  for (const code of codes) {
    if (!translated.includes(code as (typeof translated)[number])) {
      stalePairs.push(`${code}:${key} (not a translated locale)`);
      continue;
    }
    const missing = missingSubtree(en, read(code));
    const stillMissing = (missing ? leafPaths(missing) : []).includes(key);
    if (!stillMissing) stalePairs.push(`${code}:${key}`);
  }
}
if (stalePairs.length > 0) {
  problems.push(
    `${stalePairs.length} baseline entr(y/ies) already translated — run ` +
      `\`pnpm i18n:coverage --prune\`: ${stalePairs.slice(0, 6).join(', ')}` +
      (stalePairs.length > 6 ? ', …' : ''),
  );
}

// `--prune` rewrites the baseline with the still-missing pairs only. It
// can only SHRINK: every pair it writes was independently observed
// missing just now, so it cannot be used to paper over a regression the
// way a hand-edited allowlist could.
if (process.argv.includes('--prune')) {
  const pruned: Record<string, string[]> = {};
  for (const code of translated) {
    const missing = missingSubtree(en, read(code));
    for (const key of missing ? leafPaths(missing) : []) {
      if (!isKnownGap(code, key)) continue; // a NEW gap is a failure, not a baseline entry
      (pruned[key] ??= []).push(code);
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(pruned)
      .sort()
      .map((k) => [k, pruned[k].sort()]),
  );
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n');
  const pairs = Object.values(sorted).flat().length;
  console.log(`[check-locale-coverage] pruned baseline → ${Object.keys(sorted).length} key(s), ${pairs} pair(s)`);
  process.exit(0);
}

if (problems.length > 0) {
  console.error('[check-locale-coverage] FAILED\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nFill the gaps rather than widening KNOWN_GAPS:\n' +
      '  pnpm --filter @vaipakam/i18n translate -- \\\n' +
      '    --locales-dir apps/alpha02/src/i18n/locales --missing-only\n' +
      'or merge hand-authored patches with `merge-patch`. See\n' +
      'src/i18n/locales/README.md.',
  );
  process.exit(1);
}

console.log(
  `[check-locale-coverage] OK — ${translated.length} translated locale(s) cover en.json ` +
    'and keep every interpolation token.',
);
