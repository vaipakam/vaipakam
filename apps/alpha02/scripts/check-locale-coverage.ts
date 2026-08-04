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
 * Sections known to be untranslated across every translated locale,
 * tracked as follow-up work. Each entry is a key PREFIX plus the issue
 * that will clear it.
 *
 * Deliberately a per-SECTION allowlist rather than a global "allow N
 * missing" tolerance: a count silently absorbs the next regression,
 * while a named section has to be removed here when it is filled, and a
 * NEW untranslated section fails even though the total is unchanged.
 *
 * Shrink this list — never grow it. A new section belongs in the
 * translation pass that ships it, not here.
 */
const KNOWN_GAPS: ReadonlyArray<{ prefix: string; issue: string }> = [
  { prefix: 'copy.offset.', issue: '#1560 follow-up' },
  { prefix: 'copy.tariff.', issue: '#1560 follow-up' },
  { prefix: 'copy.earlyRepay.', issue: '#1560 follow-up' },
  { prefix: 'copy.transferOb.', issue: '#1560 follow-up' },
  { prefix: 'copy.saleHold.', issue: '#1560 follow-up' },
  { prefix: 'copy.loanSale.', issue: '#1560 follow-up' },
  { prefix: 'copy.match.', issue: '#1560 follow-up' },
  { prefix: 'copy.seo.', issue: '#1560 follow-up' },
  { prefix: 'copy.errors.', issue: '#1560 follow-up' },
  { prefix: 'copy.settingsPage.', issue: '#1560 follow-up' },
  { prefix: 'contractError.', issue: '#1560 follow-up' },
];

/**
 * Leaves where a locale legitimately omits an interpolation token the
 * English carries. Keyed `<locale>:<path>`, and every entry needs a
 * linguistic reason — not just "it fails".
 *
 * Introducing an UNKNOWN token has no escape hatch: i18next has nothing
 * to substitute, so the user sees literal braces.
 */
const ALLOWED_OMISSIONS: Readonly<Record<string, string>> = {
  // Arabic has a grammatical dual: the `_two` form already means "two
  // days" in the noun itself ("يومان"), so restating {{count}} would
  // render "2 يومان" — "2 two-days".
  'ar:copy.units.durationDay_two': 'Arabic dual encodes the count in the noun',
  'ar:copy.units.durationMonth_two': 'Arabic dual encodes the count in the noun',
  'ar:copy.units.durationYear_two': 'Arabic dual encodes the count in the noun',
};

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
    (key) => !KNOWN_GAPS.some(({ prefix }) => key.startsWith(prefix)),
  );
  if (unexplained.length > 0) {
    problems.push(
      `${code}: missing ${unexplained.length} key(s) — ${unexplained
        .slice(0, 8)
        .join(', ')}${unexplained.length > 8 ? ', …' : ''}`,
    );
  }

  for (const { path: key, unknown, dropped } of placeholderDrift(en, bundle)) {
    if (unknown.length > 0) {
      problems.push(
        `${code}: ${key} introduces {{${unknown.join('}}, {{')}}} — not in the English`,
      );
    }
    if (dropped.length > 0 && ALLOWED_OMISSIONS[`${code}:${key}`] === undefined) {
      problems.push(
        `${code}: ${key} drops {{${dropped.join('}}, {{')}}} present in the English`,
      );
    }
  }
}

// A gap every locale has since filled must leave KNOWN_GAPS, otherwise
// the allowlist quietly re-opens that section to regression.
const bundles = translated.map(read);
for (const { prefix } of KNOWN_GAPS) {
  const stillMissingSomewhere = bundles.some((bundle) => {
    const missing = missingSubtree(en, bundle);
    return (missing ? leafPaths(missing) : []).some((key) =>
      key.startsWith(prefix),
    );
  });
  if (!stillMissingSomewhere) {
    problems.push(
      `KNOWN_GAPS entry "${prefix}" is fully translated everywhere — remove it`,
    );
  }
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
