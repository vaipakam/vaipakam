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
 * also runnable on its own — `pnpm --filter @vaipakam/alpha02
 * i18n:coverage` — which is what you
 * want mid-translation, without booting a test runner.
 *
 * The `{}` placeholder bundles for locales OUTSIDE `TRANSLATED_LOCALES`
 * are deliberate and out of scope: they exist so URL routing and the
 * language picker have a file to resolve, and English fallback is the
 * documented behaviour there.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containsToken,
  emptyTranslations,
  leafAt,
  leafPaths,
  leafTypeDrift,
  missingSubtree,
  placeholderDrift,
  type Bundle,
} from '@vaipakam/i18n';
import { TRANSLATED_LOCALES } from '../src/i18n/localeConfig.ts';
import { CONFIRM_WORD, RECOVERY_ACK_TEXT } from '../src/lib/recoveryAck.ts';

const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'i18n',
  'locales',
);

/**
 * The exact `(key, locale)` pairs still untranslated, tracked as #1560
 * follow-up. Generated — regenerate with `pnpm --filter @vaipakam/alpha02 i18n:coverage -- --prune`,
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
 * Per-(locale, key) exemptions, read from the COMMITTED record at
 * `src/i18n/translation-policy.json`.
 *
 * In a file rather than inline here because the shared `merge-patch`
 * and `translate --missing-only` scripts need the same answers, and
 * their only channel used to be repeated command-line flags. Restating
 * an exemption on every run is how an escape hatch becomes a reflex —
 * and a flag people always pass guards nothing (Codex #1563 r16). One
 * committed record, every path into these bundles reads it.
 *
 * `omissions` binds to the EXACT `<locale>:<path>` → token list, not
 * just the leaf (Codex #1563 r1): a leaf-level exemption would keep
 * passing if the English later gained a SECOND live value and the
 * locale dropped that one too, silently deleting a real value under an
 * exemption granted for something else. Introducing an UNKNOWN token
 * has no escape hatch at all — i18next has nothing to substitute, so
 * the user sees literal braces.
 *
 * `empty` covers leaves i18next renders BLANK rather than falling back,
 * which no other check can see: the key is present, the value is a
 * valid string, and there are no tokens to compare.
 */
interface PolicyRecord {
  requiredLiterals: Record<string, string[]>;
  omissions: Record<string, { tokens: string[]; reason: string }>;
  empty: Record<string, string>;
}
const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'i18n',
  'translation-policy.json',
);
const POLICY = JSON.parse(
  fs.readFileSync(POLICY_PATH, 'utf8'),
) as PolicyRecord;
const ALLOWED_OMISSIONS = POLICY.omissions;
const ALLOWED_EMPTY = POLICY.empty;

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
const REQUIRED_LITERALS: Readonly<Record<string, readonly string[]>> =
  POLICY.requiredLiterals;

/**
 * The recovery declaration this repo's nine translations were authored
 * against, as a SHA-256 of `RECOVERY_ACK_TEXT`.
 *
 * `copy.recover.ackTextTranslation` is the reading aid shown beside the
 * signed declaration, labelled as saying what that declaration says.
 * Its English source IS the declaration (they share one definition now,
 * so those two cannot drift) — but the nine translations are authored
 * text, and nothing can derive them. Change the declaration to match a
 * new on-chain `RECOVERY_ACK_TEXT_HASH` and every locale keeps its
 * translation of the OLD one, still labelled as explaining what the
 * user is signing. No other check sees this: the key is present, a
 * string, non-empty, token-clean, and different from English, so
 * coverage, type, placeholder and echo-back checks all pass (Codex
 * #1563 r11).
 *
 * Pinning the source is what makes that unshippable rather than
 * unnoticed. A build-time gate is deliberately stronger than a runtime
 * one here: suppressing the aid at runtime would ship a page that
 * quietly stops explaining the declaration, while this stops the
 * release until someone re-translates it — one string in nine
 * languages, against a contract change that is itself rare and
 * deliberate.
 *
 * WHEN THIS FAILS: re-author `ackTextTranslation` in all nine locale
 * bundles against the new declaration, then update this hash. Updating
 * the hash alone silences the guard and reinstates exactly the bug it
 * exists to catch.
 */
const ACK_TEXT_TRANSLATED_AGAINST =
  '32457a8662663726ac9c701a5786520c82ed28e35aee3306218b9a75865f918f';


const read = (code: string): Bundle =>
  JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'),
  ) as Bundle;

/**
 * `read`, but reporting damage instead of throwing it.
 *
 * This guard's whole promise is ONE consolidated report across every
 * locale — that is why it is a script rather than a per-locale
 * assertion that stops at its first arm. An unguarded parse breaks that
 * promise in the worst way: the first damaged bundle aborts with a raw
 * `Object.hasOwn` stack and every LATER locale's problems stay hidden,
 * so the operator cannot get a complete repair list from a run (Codex
 * #1563 r14). A damaged bundle is one problem among others, not a
 * reason to stop looking.
 */
function readOrDamaged(code: string): Bundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Bundle;
}

const en = read('en');
const translated = TRANSLATED_LOCALES.filter((code) => code !== 'en');
const problems: string[] = [];

// The policy file is data, so it can drift from the constant the app
// actually compares against. Cross-check rather than trust it: a guard
// reading a stale literal is the same failure as a guard restating one
// (Codex #1563 r14/r17).
if (!REQUIRED_LITERALS['copy.recover.confirmPrompt']?.includes(CONFIRM_WORD)) {
  problems.push(
    'translation-policy.json requiredLiterals["copy.recover.confirmPrompt"] does not ' +
      `list "${CONFIRM_WORD}" — the word Recover.tsx compares typed input against`,
  );
}

/** Missing-key paths per locale, computed ONCE in the validation loop
 *  below and reused by the stale-baseline check and `--prune`. Both of
 *  those used to re-read and re-scan the whole bundle per BASELINE PAIR
 *  — 1,467 full parses and traversals of nine ~200 KB files on every
 *  `typecheck`, for nine distinct answers (Codex #1563 r9). A locale
 *  with NO entry here is one whose file is missing entirely: its
 *  bundle was never read, so nothing is known about it. */
const missingByLocale = new Map<string, ReadonlySet<string>>();

for (const code of translated) {
  const file = path.join(LOCALES_DIR, `${code}.json`);
  if (!fs.existsSync(file)) {
    problems.push(`${code}: locales/${code}.json is missing entirely`);
    continue;
  }
  const bundle = readOrDamaged(code);
  if (bundle === null) {
    problems.push(
      `${code}: locales/${code}.json is unreadable — malformed JSON or a ` +
        'non-object root. Every other check for this locale is skipped.',
    );
    continue;
  }

  const missing = missingSubtree(en, bundle);
  const missingKeys = new Set(missing ? leafPaths(missing) : []);
  missingByLocale.set(code, missingKeys);
  const unexplained = [...missingKeys].filter((key) => !isKnownGap(code, key));
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

  // An empty translation renders as nothing at all, and no other check
  // can see it.
  for (const key of emptyTranslations(en, bundle)) {
    if (ALLOWED_EMPTY[`${code}:${key}`] !== undefined) continue;
    problems.push(
      `${code}: ${key} is empty while the English is not — i18next renders ` +
        'blank rather than falling back',
    );
  }

  checkRequiredLiterals(code, bundle);
}

// ENGLISH TOO. The loop above walks `translated`, which excludes `en` —
// so with the nine locales updated for a changed CONFIRM_WORD, the
// English prompt could go on saying "Type CONFIRM" while the button
// requires the new word, and both this guard and the en.json template
// test would pass (Codex #1563 r15). English is the source every other
// locale is translated FROM; it is the last place that should be
// exempt from the literal it defines.
checkRequiredLiterals('en', en);

// The declaration the nine reading-aid translations were authored
// against — see ACK_TEXT_TRANSLATED_AGAINST.
const ackTextHash = crypto
  .createHash('sha256')
  .update(RECOVERY_ACK_TEXT, 'utf8')
  .digest('hex');
if (ackTextHash !== ACK_TEXT_TRANSLATED_AGAINST) {
  problems.push(
    'the recovery declaration changed — every locale\'s ' +
      'copy.recover.ackTextTranslation is now a translation of the OLD text ' +
      'while the page labels it as saying what the user is signing. ' +
      're-author it in all nine bundles, THEN set ' +
      `ACK_TEXT_TRANSLATED_AGAINST to ${ackTextHash}`,
  );
}

/**
 * Report any `REQUIRED_LITERALS` entry this bundle fails to carry
 * verbatim. Extracted so the ENGLISH source runs the same check as the
 * translations — see the call site below the per-locale loop.
 */
function checkRequiredLiterals(code: string, bundle: Bundle): void {
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
    // No entry = the locale's file is missing (already reported above),
    // so its gaps are unrefuted, not stale.
    const missing = missingByLocale.get(code);
    if (missing !== undefined && !missing.has(key)) {
      stalePairs.push(`${code}:${key}`);
    }
  }
}
const pruning = process.argv.includes('--prune');
// In prune mode the stale pairs are about to be REMOVED, so they aren't
// a problem — but every other problem still is (see below).
if (stalePairs.length > 0 && !pruning) {
  problems.push(
    `${stalePairs.length} baseline entr(y/ies) already translated — run ` +
      `\`pnpm --filter @vaipakam/alpha02 i18n:coverage -- --prune\`: ` +
      `${stalePairs.slice(0, 6).join(', ')}` +
      (stalePairs.length > 6 ? ', …' : ''),
  );
}

// `--prune` rewrites the baseline with the still-missing pairs only. It
// can only SHRINK: every pair it writes was independently observed
// missing just now, so it cannot be used to paper over a regression the
// way a hand-edited allowlist could.
if (pruning) {
  const pruned: Record<string, string[]> = {};
  for (const code of translated) {
    const missing = missingByLocale.get(code);
    if (missing === undefined) {
      // File missing entirely — nothing was observed, so carry this
      // locale's baseline through untouched rather than pruning every
      // pair on the strength of a bundle we never read.
      for (const [key, codes] of Object.entries(KNOWN_GAPS)) {
        if (codes.includes(code)) (pruned[key] ??= []).push(code);
      }
      continue;
    }
    for (const key of missing) {
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
  // Deliberately NOT exiting here. Pruning fixes exactly one class of
  // problem — stale baseline entries — and every other finding above
  // (a new missing key, leaf-type drift, a malformed placeholder, a
  // lost CONFIRM literal) is still real. Exiting 0 from the documented
  // maintenance command would have reported a broken locale as healthy
  // at precisely the moment someone is editing translations (Codex
  // #1563 r3). Fall through to the normal verdict.
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
