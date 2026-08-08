/**
 * Guardrail (#1560, #1362): fail if a locale advertised in
 * `TRANSLATED_LOCALES` has fallen behind `locales/en.json`, or if one of
 * its strings mangles an interpolation token.
 *
 *     pnpm --filter @vaipakam/alpha02 i18n:coverage
 *
 * TWO different questions, because one of them stayed invisible after
 * the other was answered. Does the locale HAVE the key, and does it
 * hold anything other than the English string? Key presence went to
 * zero gaps and read as "fully translated" while `hi` alone still
 * rendered 283 English leaves — `missingSubtree` compares presence, so
 * it goes quiet the moment a key exists, whatever is in it (#1596).
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
  emptyTranslations,
  leafAt,
  leafPaths,
  leafTypeDrift,
  missingSubtree,
  placeholderDrift,
  requiredLiteralProblems,
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
 * The `(key, locale)` pairs where the key EXISTS but still holds the
 * English string, tracked as #1596. Same shape, same prune command and
 * same shrink-only rule as the missing-key baseline above.
 *
 * A separate file because it is a separate claim. `missingSubtree`
 * compares key PRESENCE, so it goes quiet the moment a key exists —
 * and a bundle can be 100% present while a reader still meets English
 * partway down the page. That is exactly what happened: the missing-key
 * baseline reached zero and read as "fully translated", while `hi`
 * alone still rendered 283 English leaves.
 */
const ENGLISH_VALUED_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'i18n',
  'english-valued-baseline.json',
);
interface EnglishValuedEntry {
  /** The English text these locales are recorded as still showing. */
  source: string;
  locales: string[];
}
const ENGLISH_VALUED: Readonly<Record<string, EnglishValuedEntry>> = JSON.parse(
  fs.readFileSync(ENGLISH_VALUED_PATH, 'utf8'),
) as Record<string, EnglishValuedEntry>;

const isKnownEnglishValued = (code: string, key: string): boolean =>
  ENGLISH_VALUED[key]?.locales.includes(code) ?? false;

/**
 * Entries whose recorded English no longer matches en.json.
 *
 * Without this the record rots INVISIBLY, in the direction that loses
 * debt. Say `hi` is recorded as showing the English "Approval" and
 * someone rewords the English to "Approval updated". `hi` now differs
 * from the source, so it stops being detected — and the stale sweep
 * concludes the entry was translated and tells you to prune it. Prune
 * obeys, the entry disappears, and `hi` goes on showing "Approval": a
 * locale that is still untranslated, no longer recorded, and no longer
 * detectable, produced by following the guard's own advice (Codex
 * #1607 r1).
 *
 * Inequality is not proof of translation. It is only proof of
 * inequality, and there are two ways to get there.
 */
function reauditNeeded(): Map<string, string> {
  // key → why, RAW keys. An earlier revision pushed the annotated
  // string (`key (no longer a string leaf…)`) into the set that the
  // stale sweep and `--prune` then queried by bare key, so an entry
  // whose English was DELETED reported correctly and was pruned away
  // anyway — the annotation made it invisible to the very guard that
  // produced it (Codex #1607 r2). Format at the edge, never in the key.
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(ENGLISH_VALUED)) {
    const current = leafOrElement(en, key);
    if (typeof current !== 'string') {
      out.set(key, 'no longer a string leaf in en.json');
    } else if (current !== entry.source) {
      out.set(key, 'the English was reworded');
    }
  }
  return out;
}

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
interface AcceptedAsTranslatedEntry {
  reason: string;
  /** The English value this exemption was granted against. If en.json
   *  moves on, the exemption is stale rather than silently inherited. */
  source: string;
  /**
   * The locales it applies to — REQUIRED, never an implicit "all".
   *
   * Equality can be right in one language and wrong in the next.
   * `copy.consentParts.suffix` is `.` in English, `.` in Arabic, and
   * `。` in Chinese: a key-wide exemption would excuse Chinese
   * regressing to the ASCII period, and no exemption leaves Arabic as
   * permanent debt it does not owe. Neither is acceptable, and only a
   * per-locale scope avoids both (Codex #1607 r2).
   */
  locales: string[];
  /**
   * The exact accepted value, per locale, where it is NOT the English
   * one. Defaults to `source`.
   *
   * The comparison asks whether everything the reader sees can be built
   * out of the English source's own words — so a translation made of
   * those words is flagged however it arranges them, which is necessary,
   * because a rearranged English sentence still reads as English.
   * French `Mode strict` for `Strict mode` is the case where that is
   * wrong, and no rule can tell it from `content to Skip` without
   * knowing French. Recording the accepted value makes the
   * judgement explicit AND self-expiring: reword the French and it no
   * longer matches, so the scope reports as unused rather than
   * standing guard over a string nobody looked at again.
   */
  values?: Record<string, string>;
}
interface PolicyRecord {
  requiredLiterals: Record<string, string[]>;
  omissions: Record<string, { tokens: string[]; reason: string }>;
  empty: Record<string, string>;
  /** key → why this leaf is correct despite matching the English word
   *  for word, bound to the English value the reason was written
   *  against (#1596). */
  acceptedAsTranslated?: Record<string, AcceptedAsTranslatedEntry>;
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

/**
 * Leaves whose value is legitimately the same in every language, so
 * being identical to the English is not evidence of anything.
 *
 * TWO MECHANICAL RULES, no bookkeeping — a string made only of
 * interpolation tokens and separators (`{{amount}}{{suffix}}`) has no
 * words to translate, and one with no letters at all (`—`) has nothing
 * to translate either. Requiring a policy entry for those would mean a
 * new entry every time someone adds a template string, which is the
 * kind of ceremony people learn to skip.
 *
 * Everything else needs an explicit `acceptedAsTranslated` entry WITH A
 * REASON, because "it looks like a proper noun" is a judgement and
 * judgements belong in the record rather than in a regex. The list is
 * deliberately short — read it; it is not summarized here, because a
 * summary of a list is the list stated twice. Common UI words that
 * happen to be untranslated — `Alerts`, `Close`, `Revoke` — are NOT
 * exempt; they go in the shrinkable baseline, because they are a
 * translation job rather than a decision.
 *
 * Named for what it ASSERTS — "this locale's value is correct" — not
 * for the shape that triggered the check. Most entries are identical to
 * the English, but not all are: `values` records a locale value built
 * from the same words in a different order, which is equally correct
 * and equally invisible to a word comparison.
 */
const ACCEPTED_AS_TRANSLATED: Readonly<
  Record<string, AcceptedAsTranslatedEntry>
> = POLICY.acceptedAsTranslated ?? {};

/** The exact value this exemption accepts for `code`. */
const acceptedValue = (entry: AcceptedAsTranslatedEntry, code: string): string =>
  entry.values?.[code] ?? entry.source;

/**
 * The shape above is a TypeScript interface over parsed JSON, which is
 * erased at run time and asserted, not checked — so `reason` was a
 * requirement in name only. Removing it from an entry left the guard
 * passing, meaning an exemption could suppress findings with no
 * committed justification at all, which is the one thing this section
 * exists to prevent (Codex #1607 r2). Validated here, before any entry
 * is allowed to excuse anything.
 */
for (const [key, entry] of Object.entries(ACCEPTED_AS_TRANSLATED)) {
  const where = `translation-policy.json acceptedAsTranslated["${key}"]`;
  if (typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
    throw new Error(`${where} has no reason — an exemption without a written justification is not reviewable`);
  }
  if (typeof entry.source !== 'string') {
    throw new Error(`${where} has no source — record the English value the reason was granted against`);
  }
  if (!Array.isArray(entry.locales) || entry.locales.length === 0) {
    throw new Error(`${where} has no locales — name them explicitly; equality can be right in one language and wrong in the next`);
  }
  const unknown = entry.locales.filter(
    (c) => !TRANSLATED_LOCALES.includes(c as (typeof TRANSLATED_LOCALES)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(`${where} names locale(s) that are not translated: ${unknown.join(', ')}`);
  }
  // A `values` override for a locale the entry does not cover accepts
  // nothing — it reads as an exemption and is inert, which is worse
  // than absent.
  for (const [code, value] of Object.entries(entry.values ?? {})) {
    if (!entry.locales.includes(code)) {
      throw new Error(`${where} records a value for "${code}", which is not in its locales`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${where} records an empty value for "${code}" — record the exact accepted string`);
    }
  }
}

/**
 * `acceptedAsTranslated` scopes that are ARMED but not currently in
 * use: the policy names a locale whose value has, right now, moved
 * away from the one the entry accepts.
 *
 * An exemption is a statement about the present ("this locale reads the
 * same and that is correct"), not a standing permission. If the locale
 * has since been localized — or was named by mistake — the entry sits
 * there waiting, and the day that locale regresses to the English the
 * guard says nothing. Reported so the scope is narrowed instead
 * (Codex #1607 r3). The neighbouring `omissions` / `empty` sections are
 * swept for staleness the same way.
 */
function unusedPolicyScopes(): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(ACCEPTED_AS_TRANSLATED)) {
    for (const code of entry.locales) {
      const bundle = bundleByLocale.get(code);
      if (bundle === undefined) continue; // unreadable/missing — reported elsewhere
      // Against the ACCEPTED value, not the English one. An entry whose
      // recorded French is reworded has had its judgement overtaken,
      // and that is precisely when it should stop excusing anything.
      //
      // Still the loose comparison, not exact equality. A value that is
      // near the accepted one — the brand name lowercased — fails the
      // exact test in `englishValuedLeaves` and is reported there, with
      // the advice to fix the casing. Reporting it here TOO would add a
      // second message advising the opposite (narrow the scope), and
      // one edit producing two contradictory instructions is worse than
      // one clear one.
      if (!stillEnglish(acceptedValue(entry, code), leafOrElement(bundle, key))) {
        out.push(`${code}:${key}`);
      }
    }
  }
  return out;
}

/**
 * `acceptedAsTranslated` entries whose recorded English no longer
 * matches, so the written reason may no longer describe the string it
 * excuses.
 *
 * There are deliberately NO pattern-based exemptions. An earlier draft
 * excused any value made only of interpolation tokens, and any value
 * with no letters in it — on the theory that neither has anything to
 * translate. The second is simply false: `copy.consentParts.suffix` is
 * `.` in English and `。` in Chinese, so punctuation IS localized, and
 * a blanket rule would have let Chinese regress to the ASCII period
 * with the guard still green (Codex #1607 r1). The first was justified
 * as avoiding ceremony — but measured, the whole bundle contains ONE
 * token-only leaf and two letterless ones. Three explicit entries is
 * not a tax; a rule that quietly excuses a class nobody counted is.
 */
function policyReauditNeeded(): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(ACCEPTED_AS_TRANSLATED)) {
    const current = leafOrElement(en, key);
    if (typeof current !== 'string') {
      out.push(`${key} (no longer a string leaf in en.json)`);
    } else if (current !== entry.source) {
      out.push(key);
    }
  }
  return out;
}

/**
 * Leaves this locale carries with the English string still in them.
 * Only leaves the locale actually HAS — a missing key is the other
 * baseline's business, and reporting it here too would make one gap
 * produce two failures.
 */
/**
 * Is this locale's value still, for practical purposes, the English one?
 *
 * NOT byte equality. Exact inequality is not evidence that the language
 * changed: the Korean bundle carries 40 leaves that differ from English
 * only in capitalization — `approving… ({{c}} of {{t}})` against
 * `Approving… ({{c}} of {{t}})` — and a Korean reader sees English
 * either way (Codex #1607 r3). Case and surrounding whitespace are
 * normalized away before deciding.
 *
 * Six of the nine advertised locales have no letter case at all, so a
 * case-only difference is essentially never a translation. Where it
 * genuinely is one, that is what the per-locale policy is for.
 */
/**
 * The words in a value, for deciding whether it is still English.
 *
 * NFKC, not NFC: compatibility normalization folds the visually
 * equivalent forms an orthographic edit can hide behind — `Ｓettings`
 * with a full-width S reads as English and rendered as English, but
 * survived a codepoint comparison (Codex #1607 r5).
 *
 * `\p{L}\p{N}`, not `\w`: JavaScript's `\w` stays ASCII-only even under
 * the `u` flag, so the first version silently dropped every non-Latin
 * character. That was not merely a missed detection — it made
 * `Reclaim tokens करें` compare EQUAL to `Reclaim tokens`, which would
 * have reported a partly-translated Hindi string as untranslated. A
 * guard that invents debt is as bad as one that loses it.
 *
 * NFKC deliberately does NOT fold `。` into `.`, so the wordless
 * fallback below still tells the Chinese full stop apart from the
 * English one.
 */
/**
 * Default-ignorable code points removed. They render as nothing, so
 * they can never be the difference between two visible strings — and
 * every comparison below is about what a reader sees, so every one of
 * them drops these first.
 */
const stripIgnorable = (value: string): string =>
  value.replace(/\p{Default_Ignorable_Code_Point}/gu, '');

/**
 * The visible MARKS, with all spacing removed.
 *
 * Spacing is not a language, and the worded branch has never treated it
 * as one — `wordsOf` tokenizes, so separators disappear before anything
 * is compared. The wordless branch trimmed only the ends, which left
 * one arrangement uncovered: `.` written as `. .` is two English full
 * stops to the reader and an undecomposable stream to the guard, so it
 * passed (Codex #1607 r19). Same treatment, same branch.
 *
 * Measured: no wordless verdict on the committed bundles changes.
 */
const marksOf = (value: string): string =>
  stripIgnorable(value.normalize('NFKC')).replace(/\s+/gu, '');

/** What a reader actually sees, ends trimmed. */
const visibleForm = (value: string): string =>
  // NFKC, matching `wordsOf`: compatibility-equivalent punctuation is
  // the same mark on screen. `．` (U+FF0E) is the English full stop
  // wearing a wide glyph, and comparing NFC let it through (Codex
  // #1607 r10). NFKC folds it to `.` while leaving `。` alone, which
  // is the distinction rounds 1 and 4 turned on.
  stripIgnorable(value.normalize('NFKC')).trim();

/**
 * Does this value contain any LETTER at all, once interpolation tokens
 * are removed?
 *
 * `wordsOf` counts a digit run as a word, which is right for comparing
 * vocabulary — `Step 1 of 2` and `Step 1/2` differ by the word `of`,
 * and dropping the digits would lose that. It is wrong for asking
 * "is there prose here": a label replaced by `123` has a word by that
 * measure and no readable text by any other, and it passed every check
 * in the file (Codex #1607 r14). The two questions need two tests.
 */
const hasLetters = (value: string): boolean =>
  // Invisible letters do not count. U+115F HANGUL CHOSEONG FILLER is
  // simultaneously `\p{L}`, default-ignorable, and a Hangul character
  // the Korean bundle is allowed to contain — so appending it to `…`
  // satisfied this test, the script rule and the still-English rule at
  // once, while rendering as punctuation (Codex #1607 r15). Every other
  // comparison in this file drops ignorables first; this one did not.
  /\p{L}/u.test(stripIgnorable(value.replace(/\{\{[^}]*\}\}/g, ' ')));

const wordsOf = (value: string): string[] =>
  (stripIgnorable(
    value
      // Interpolation tokens are removed first. They are not prose, and
      // their identifiers are not words: `({{c}} of {{t}})` reordered to
      // `({{t}} of {{c}})` produced a different "word" sequence and was
      // called a translation, while every visible word stayed English —
      // and `placeholderDrift` deliberately PERMITS that reordering,
      // because grammar requires it. Whether the tokens are right is its
      // job; whether the prose is English is this one's (Codex #1607 r8).
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .normalize('NFKC'),
  )
    // Invisible characters are dropped BEFORE tokenizing, not after.
    // A zero-width space inside a word splits it into two: `Set​tings`
    // tokenized as `set` + `tings`, which matches no English word list
    // and passed as a translation while rendering as "Settings" (Codex
    // #1607 r11). The wordless path already stripped them; the worded
    // path did not, so the same character defeated one check and not
    // the other.
    .toLowerCase()
    // LETTERS only — digits are not vocabulary. Keeping them let a
    // digit dropped INSIDE a word break the decomposition: `Set1tings`
    // produced a stream no arrangement of `settings` could cover, so
    // mangled English read as translated (Codex #1607 r14 asked the
    // same question of prose and got `123`; r18 found the inverse).
    // Nothing is lost: a value differing from the English only in its
    // numbers is not a translation either.
    .match(/\p{L}+/gu) ?? []);

const stillEnglish = (source: string, candidate: unknown): boolean => {
  if (typeof candidate !== 'string') return false;
  const sourceWords = wordsOf(source);
  const candidateWords = wordsOf(candidate);
  // Wordless on either side — the punctuation IS the content. This is
  // the case that makes a blanket punctuation-strip wrong:
  // `copy.consentParts.suffix` is `.` in English and `。` in Chinese,
  // and both reduce to zero words. Stripping punctuation would call a
  // correct localization "still English" (Codex #1607 r4).
  //
  // The SAME question as the worded branch, asked of characters instead
  // of words: can what the reader sees be built entirely out of the
  // source's own marks? Exact comparison was the earlier answer and it
  // excused a repetition — `.` doubled to `..` is not a translation
  // into anything, and it passed (r18). `。` is not among the English
  // marks, so a real localization still reads as translated.
  //
  // Default-ignorable code points are removed first. They render as
  // nothing, so `.` followed by a zero-width space IS the English full
  // stop on screen while differing in bytes — a regression that looked
  // like a translation (r6).
  if (sourceWords.length === 0 || candidateWords.length === 0) {
    const sourceMarks = marksOf(source);
    const candidateMarks = marksOf(candidate);
    if (candidateMarks === sourceMarks) return true;
    return coveredBySourceWords(candidateMarks, [...new Set(sourceMarks)]);
  }
  // Otherwise compare the WORDS, on ONE rule: is everything the reader
  // sees made only of THIS SOURCE's words?
  //
  //   Skip to content -> content to Skip          reordered
  //   Skip to content -> Skip content             a word deleted
  //   Settings        -> Settings Settings        repeated
  //   Settings        -> Einstellungen Settings   has a German word
  //
  // The first three are English on screen; only the fourth has a word
  // from somewhere else. Counts, order and separators are bookkeeping a
  // reader cannot see: `Refinance carry-over collateral shortfall` in
  // Hindi against `Refinance carry over collateral shortfall` in
  // English is English with a hyphen added, and `Mock USD Coin（{{s}}）`
  // is English with localized brackets — 11 such leaves were passing.
  //
  // Five revisions each caught one arrangement and left the next:
  // sequence order (Codex #1607 r11), then equal-length multisets,
  // which excused deletions (r13 — eight committed leaves, Hindi
  // `loan asset` for `the loan asset`, Korean `permission signing…`
  // for `Signing the permission…`), then sub-multisets, which still
  // excused repetition because `Settings Settings` is LONGER than its
  // source and fell out of the length shortcut (r14), then the word
  // set, which could not see punctuation dropped inside a word (r16),
  // then concatenated letters, which could not see that repeated (r17).
  // Each fix was correct about the case in front of it and blind to
  // the next arrangement of the same thing.
  //
  // SAY THE RULE PRECISELY. The loose form — "is every word an English
  // word?" — promises what this cannot deliver: `Open Settings` for
  // `Settings` is entirely English and passes, because `open` is not in
  // the source (r15). The loose form was measured before being
  // rejected: all 1,801 words of en.json as a dictionary adds 17 pairs,
  // and reading them, essentially all are correct translations sharing
  // vocabulary with English — French `Plus`, `Principal`,
  // `Type de NFT`, `1 an`, and `{{noun}} n°{{id}} — {{what}}`, the
  // value defended one round earlier AS localization. Telling those
  // from a real English rewrite needs a language identifier, not a set
  // operation; #1611 carries it.
  //
  // The asymmetry is deliberate: a candidate with a word THIS SOURCE
  // does not have is treated as a translation someone started, because
  // flagging it would invent debt — the failure `\p{L}` over `\w` was
  // fixed to avoid in round 5.
  //
  // Applied to the LETTERS, not the tokens, because the word boundaries
  // are themselves editable. `Set-tings` splits into `set` + `tings`,
  // neither a source word — so a token-level test reads two foreign
  // words where a reader sees one mangled English one (r16). Comparing
  // the concatenated letters fixed that and then failed on
  // `Set-tings Set-tings`, whose letters are `settings` twice (r17).
  //
  // So: can the candidate's letter stream be cut ENTIRELY into source
  // words? That is one question covering all of it — reordering,
  // deletion, repetition, and any punctuation moved, added or removed,
  // in any combination. Measured against the committed bundles it flags
  // exactly what the two rules it replaces flagged and nothing more.
  return coveredBySourceWords(candidateWords.join(''), sourceWords);
};

/**
 * Can `stream` be cut, end to end, into words drawn from `vocabulary`?
 *
 * A word may be used any number of times or not at all, so this covers
 * every rearrangement of the source's own words. `settingssettings`
 * decomposes into `settings` twice; `kontoeinstellungen` cannot be
 * decomposed by `{settings}` at all, so real German is untouched.
 *
 * Linear in the stream, scanning the vocabulary at each reachable
 * position — bundles are hundreds of characters and a handful of words
 * per leaf, so the cost is invisible next to reading ten JSON files.
 */
function coveredBySourceWords(stream: string, vocabulary: string[]): boolean {
  if (stream === '' || vocabulary.length === 0) return false;
  const reachable = new Array<boolean>(stream.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < stream.length; i++) {
    if (!reachable[i]) continue;
    for (const word of vocabulary) {
      if (word !== '' && stream.startsWith(word, i)) reachable[i + word.length] = true;
    }
  }
  return reachable[stream.length];
}

/**
 * Resolve a leaf path that may address an ARRAY ELEMENT (`a.b[2]`).
 *
 * `leafPaths` stops at an array and `leafAt` hands back the whole
 * array, so an element-wise check needs its own accessor. Without one,
 * every element of `copy.help.risks` and `copy.recover.warnings` — 8
 * displayed strings per locale — was skipped outright, and replacing a
 * Spanish warning with the English text left the guard green
 * (Codex #1607 r3).
 */
function leafOrElement(bundle: Bundle, key: string): unknown {
  const m = /^(.*)\[(\d+)\]$/.exec(key);
  if (!m) return leafAt(bundle, key);
  const arr = leafAt(bundle, m[1]);
  return Array.isArray(arr) ? arr[Number(m[2])] : undefined;
}

/** Every English leaf path, with array elements expanded to `path[i]`. */
function englishLeafPaths(): string[] {
  const out: string[] = [];
  for (const key of leafPaths(en)) {
    const source = leafAt(en, key);
    if (Array.isArray(source)) {
      source.forEach((element, index) => {
        if (typeof element === 'string') out.push(`${key}[${index}]`);
      });
    } else if (typeof source === 'string') {
      out.push(key);
    }
  }
  return out;
}

function englishValuedLeaves(code: string, bundle: Bundle): string[] {
  const found: string[] = [];
  for (const key of englishLeafPaths()) {
    const source = leafOrElement(en, key);
    if (typeof source !== 'string') continue;
    const value = leafOrElement(bundle, key);
    if (!stillEnglish(source, value)) continue;
    // The exemption is granted against an EXACT string. A normalized
    // match is not that string: Spanish `copy.app.name` as `vaipakam`
    // is a brand-casing regression the glossary forbids, and the
    // acronym entries would likewise have excused `gtc` / `Aon`. Let
    // anything short of exact fall through to the baseline check
    // (Codex #1607 r4).
    const exemption = ACCEPTED_AS_TRANSLATED[key];
    if (exemption?.locales.includes(code) && value === acceptedValue(exemption, code)) {
      continue;
    }
    found.push(key);
  }
  return found;
}
/**
 * The writing systems each bundle may contain, BESIDES Latin.
 *
 * Latin is allowed everywhere — brand names, ticker symbols and units
 * appear untranslated in every locale, and the English source is Latin.
 * Anything outside a locale's own scripts is not a translation into
 * that language; it is a mangled string.
 *
 * WHY THIS EXISTS. Every check above compares what a reader SEES, and
 * that is exactly what a homoglyph defeats: `Sеttings` with a Cyrillic
 * `е` renders as "Settings" and is byte-different from it, so the word
 * comparison sees a different word and calls it German (Codex #1607
 * r12). NFKC does not fold across scripts, and rightly — Cyrillic `е`
 * and Latin `e` are different letters, not two spellings of one.
 *
 * A confusables table (UTS #39 skeletons) would answer the narrow
 * question "does this look like that", and would need either a new
 * dependency or a hand-maintained mapping of every ASCII lookalike —
 * the same open-ended list-of-special-cases that the chapter counter in
 * #1594 had to be abandoned for. This asks a closed question instead:
 * WHICH ALPHABETS is this language written in? That is nine short
 * declarations, it needs no table, and it rejects the whole class —
 * Greek, Cherokee and Armenian lookalikes as well as Cyrillic — rather
 * than the characters someone remembered to enumerate.
 *
 * It does NOT catch a lookalike from a script the locale legitimately
 * uses (Latin `l` for `I`, or Han for Han). Stated rather than implied:
 * this closes cross-script substitution, not every possible confusable.
 */
const LOCALE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  ar: ['Arabic'],
  de: [],
  es: [],
  fr: [],
  hi: ['Devanagari'],
  ja: ['Hiragana', 'Katakana', 'Han'],
  ko: ['Hangul', 'Han'],
  ta: ['Tamil'],
  zh: ['Han'],
};

/**
 * Matches one LETTER OR COMBINING MARK outside the locale's alphabets.
 *
 * Marks as well as letters, because a mark is script-bearing and a
 * misplaced one is doubly invisible: the tokenizer treats it as a word
 * boundary, so a Hebrew point dropped inside `Settings` splits the word
 * into `set` + `tings`, matching no English word, while the screen
 * still reads Settings. A letters-only test missed it entirely, since
 * the mark is `\p{Mn}` and not `\p{L}` (Codex #1607 r13).
 *
 * `Inherited` is allowed — that is what ordinary diacritics carry
 * (a combining acute takes the script of the letter it sits on), so
 * excluding it would reject correctly accented French and German.
 * A mark that names a script of its OWN, like the Hebrew point, is
 * not a diacritic on a Latin letter; it is text from another writing
 * system.
 *
 * The lookahead is load-bearing: `[^…]` alone cannot express "is a
 * letter or mark AND is not one of these scripts", because a negated
 * class conjoins its negations — `[^\P{L}\P{M}]` asks for a character
 * that is both a letter and a mark, which is nothing at all.
 *
 * Punctuation, digits, emoji and interpolation braces are untouched;
 * they are neither letters nor marks and carry no script.
 *
 * `scx` (Script_Extensions), not `Script`. The Arabic tatweel and the
 * Japanese prolonged-sound mark are both `Script=Common`, so a
 * `Script=` test flags two characters that belong in exactly the
 * bundles they appear in.
 */
const foreignLetterRe = (code: string): RegExp =>
  new RegExp(
    `(?=[\\p{L}\\p{M}])[^${['Latin', 'Inherited', ...(LOCALE_SCRIPTS[code] ?? [])]
      .map((s) => `\\p{scx=${s}}`)
      .join('')}]`,
    'u',
  );

/**
 * The only characters allowed in a bundle beyond letters, marks,
 * numbers, punctuation and spaces.
 *
 * MEASURED, not guessed: these twelve are every such character in all
 * ten bundles today. `$` `+` `=` `~` `°` `×` `←` `→` `≈` `≥`, the
 * fullwidth `＋` a CJK bundle uses, and the soft hyphen (a hyphenation
 * hint, invisible but legitimate).
 *
 * An ALLOWLIST, because the blocklist polarity kept losing. Rounds 5,
 * 10, 11, 12, 13, 15 and 16 each named one more character that renders
 * as something other than its bytes — a full-width `Ｓ`, a full-width
 * period, a zero-width space, a Cyrillic `е`, a Hebrew point, an
 * invisible Hangul filler, a NUL — and each fix closed exactly the one
 * named. Round 17 then produced two more: U+2800 BRAILLE PATTERN BLANK,
 * a `So` character that renders empty and belongs to no ignorable
 * class, and the bidi overrides U+202A–202E / U+2066–2069, which are
 * default-ignorable and so were being STRIPPED — meaning `‮sgnitteS`
 * compared as gibberish while a browser renders it as `Settings`.
 *
 * Enumerating what may appear ends the sequence. Anything outside these
 * categories fails, so the next character with a surprising rendering
 * is rejected before anyone has to discover it — and adding one is a
 * deliberate edit here, with the reason visible in review.
 */
const ALLOWED_SYMBOLS = '$+=~­°×←→≈≥＋';
const DISALLOWED_RE = new RegExp(
  `[^\\p{L}\\p{M}\\p{N}\\p{P}\\p{Zs}${ALLOWED_SYMBOLS}]`,
  'u',
);

/**
 * Leaves holding a character that does not belong in this locale's
 * text — a letter or mark from another alphabet, or a character
 * outside the allowed categories.
 */
function foreignScriptLeaves(code: string, bundle: Bundle): string[] {
  const re = foreignLetterRe(code);
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'string') {
      const disallowed = DISALLOWED_RE.exec(node);
      const m = disallowed ?? re.exec(node);
      if (m) {
        const ch = m[0];
        const point = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
        // The code point ALONE for a disallowed character. Echoing it
        // would put a control or a bidi override into the terminal and
        // into CI logs, where it is invisible or actively reorders the
        // surrounding text — the same property that let it hide in the
        // bundle. Script violations are real glyphs, so those print.
        out.push(disallowed ? `${prefix} (${point})` : `${prefix} (${ch} ${point})`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((element, index) => walk(element, `${prefix}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        walk(value, prefix ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(bundle, '');
  return out;
}

/**
 * Leaves where the English is PROSE and the locale value has no
 * letters at all.
 *
 * `stillEnglish` cannot see these. Its wordless branch exists for the
 * case where punctuation IS the content on both sides (`.` against
 * `。`), and it compares the two strings exactly — so a worded English
 * against a wordless locale value comes out UNEQUAL, which the caller
 * reads as "not English, therefore translated". Replacing a German
 * label with `…` passed every check in the file (Codex #1607 r13), and
 * so did `123` — a digit run counts as a word to `wordsOf`, which is
 * right for comparing vocabulary and wrong for asking whether there is
 * anything to read (r14), so this asks about LETTERS.
 *
 * Not translation debt, so not the baseline: a value with no letters
 * where the source has a sentence is a mangled string, and the reader
 * sees punctuation or digits where text should be.
 *
 * Empty values are skipped — `emptyTranslations` and the `empty` policy
 * scope already own that case, and reporting it twice would make one
 * fault produce two failures with two different remedies.
 */
function letterlessForProseLeaves(code: string, bundle: Bundle): string[] {
  const out: string[] = [];
  for (const key of englishLeafPaths()) {
    const source = leafOrElement(en, key);
    // LETTERS, not words. A digit run counts as a word to `wordsOf`,
    // so a label replaced by `123` looked wordful and skipped this
    // check entirely while showing the reader no text at all
    // (Codex #1607 r14).
    if (typeof source !== 'string' || !hasLetters(source)) continue;
    const value = leafOrElement(bundle, key);
    if (typeof value !== 'string' || visibleForm(value) === '') continue;
    if (hasLetters(value)) continue;
    // Same scope the still-English check consults. A sentence split
    // into parts can legitimately leave one part as bare punctuation
    // in a language that puts the words elsewhere — three locales do
    // exactly that with the offer footer's tail — and that is a written
    // judgement, not a pattern.
    const exemption = ACCEPTED_AS_TRANSLATED[key];
    if (exemption?.locales.includes(code) && value === acceptedValue(exemption, code)) {
      continue;
    }
    out.push(`${key} (${JSON.stringify(value)})`);
  }
  return out;
}

const problems: string[] = [];

// The English source too. A homoglyph there poisons every comparison
// downstream — the source word would no longer match any locale that
// spells it correctly, so nine locales would read as translated at
// once, and the record would be pruned away as debt already paid.
{
  const foreign = foreignScriptLeaves('en', en);
  if (foreign.length > 0) {
    problems.push(
      `en: ${foreign.length} leaf/leaves contain a character that does not ` +
        'belong in English text — a letter or mark from another alphabet, or ' +
        'something outside the allowed categories and declared symbols: ' +
        `${foreign.slice(0, 6).join(', ')}` +
        (foreign.length > 6 ? ', …' : ''),
    );
  }
}

// What the bundles ACTUALLY do, so a policy exemption that no longer
// corresponds to anything can be reported (see the stale-exemption
// check below).
const observedDropped = new Set<string>();
const observedEmpty = new Set<string>();

// The policy file is data, so it can drift from the constant the app
// actually compares against. Cross-check rather than trust it: a guard
// reading a stale literal is the same failure as a guard restating one
// (Codex #1563 r14/r17).
// EXACTLY this word, not merely "contains" it (Codex #1563 r20).
// `includes` proves the live word was ADDED but not that a superseded
// one was removed, and every listed token is REQUIRED — so a policy
// left as ["CONFIRM", "PROCEED"] would pass here and then reject every
// correct prompt saying only "PROCEED". The gate compares against one
// word, so the policy must name one word.
const declaredConfirm = REQUIRED_LITERALS['copy.recover.confirmPrompt'] ?? [];
if (declaredConfirm.length !== 1 || declaredConfirm[0] !== CONFIRM_WORD) {
  problems.push(
    'translation-policy.json requiredLiterals["copy.recover.confirmPrompt"] is ' +
      `${JSON.stringify(declaredConfirm)}, expected exactly ["${CONFIRM_WORD}"] — ` +
      'the word Recover.tsx compares typed input against',
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
/** Same idea for the English-valued leaves — computed once per locale
 *  and reused by the stale-baseline check and `--prune` (#1596). */
const englishValuedByLocale = new Map<string, ReadonlySet<string>>();
/** The parsed bundles, kept so the policy-scope sweep below does not
 *  re-read and re-parse nine ~200 KB files — the very cost this file's
 *  header already calls out for the missing-key check. */
const bundleByLocale = new Map<string, Bundle>();

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

  const foreign = foreignScriptLeaves(code, bundle);
  if (foreign.length > 0) {
    problems.push(
      `${code}: ${foreign.length} leaf/leaves contain a character that does ` +
        `not belong in ${code} text — a letter or mark from another alphabet, ` +
        'or something outside letters/marks/numbers/punctuation/spaces and ' +
        'the declared symbol list. A lookalike renders as the English while ' +
        'comparing as a different word; anything else is a mangled string: ' +
        `${foreign.slice(0, 6).join(', ')}` +
        (foreign.length > 6 ? ', …' : ''),
    );
  }

  const wordless = letterlessForProseLeaves(code, bundle);
  if (wordless.length > 0) {
    problems.push(
      `${code}: ${wordless.length} leaf/leaves hold no letters where the ` +
        'English is prose — the reader sees punctuation or digits where words ' +
        'should be: ' +
        `${wordless.slice(0, 6).join(', ')}` +
        (wordless.length > 6 ? ', …' : ''),
    );
  }

  for (const key of emptyTranslations(en, bundle)) observedEmpty.add(`${code}:${key}`);
  for (const { path: key, unknown, dropped, malformed } of placeholderDrift(en, bundle)) {
    for (const token of dropped) observedDropped.add(`${code}:${key}:${token}`);
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
  const reportedEmpty = new Set<string>();
  for (const key of emptyTranslations(en, bundle)) {
    if (ALLOWED_EMPTY[`${code}:${key}`] !== undefined) continue;
    reportedEmpty.add(key);
    problems.push(
      `${code}: ${key} is empty while the English is not — i18next renders ` +
        'blank rather than falling back',
    );
  }

  // VISIBLY empty: a value made only of default-ignorable characters is
  // not the empty string, so `emptyTranslations` walks past it — and it
  // is not equal to the English either, so the still-English check calls
  // it translated. A `zh` suffix of U+200B alone rendered nothing and
  // passed both (Codex #1607 r7). Falling through two checks because it
  // sits between their definitions is exactly the gap this PR is about.
  for (const key of englishLeafPaths()) {
    if (reportedEmpty.has(key)) continue; // already reported as empty
    if (ALLOWED_EMPTY[`${code}:${key}`] !== undefined) continue;
    const source = leafOrElement(en, key);
    const value = leafOrElement(bundle, key);
    if (typeof source !== 'string' || typeof value !== 'string') continue;
    if (value === '' || visibleForm(source) === '') continue;
    if (visibleForm(value) === '') {
      problems.push(
        `${code}: ${key} contains only invisible characters while the English ` +
          'is not empty — it renders as nothing',
      );
    }
  }

  // PRESENT but still in English. `missingSubtree` cannot see this —
  // it compares key presence, so it goes quiet the moment the key
  // exists, whatever is in it.
  bundleByLocale.set(code, bundle);
  const englishValued = englishValuedLeaves(code, bundle);
  englishValuedByLocale.set(code, new Set(englishValued));
  const unexplainedEnglish = englishValued.filter(
    (key) => !isKnownEnglishValued(code, key),
  );
  if (unexplainedEnglish.length > 0) {
    problems.push(
      `${code}: ${unexplainedEnglish.length} key(s) still hold the English ` +
        `string — ${unexplainedEnglish.slice(0, 8).join(', ')}` +
        `${unexplainedEnglish.length > 8 ? ', …' : ''}`,
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
/**
 * Delegates to the SHARED check rather than restating it.
 *
 * The local copy skipped an absent leaf, on the same "reported above"
 * assumption the shared helper used to make — and here that assumption
 * fails in a specific, quiet way: rename `confirmPrompt` in copy.ts
 * while the policy keeps the old path, and the exact-word cross-check
 * still passes (it compares the policy to CONFIRM_WORD, not to the
 * catalog), the template test accepts the rename, and this function
 * ignores the now-missing old leaf. Every alpha02 check green while the
 * NEW prompt is unguarded and free to be translated (Codex #1563 r26).
 *
 * A stale policy path must fail loudly, so absence is reported. The
 * bundles are COMPLETE here, so no `partial` exemption applies.
 */
function checkRequiredLiterals(code: string, bundle: Bundle): void {
  for (const line of requiredLiteralProblems(bundle, REQUIRED_LITERALS)) {
    problems.push(`${code}: ${line}`);
  }
}

// An exemption whose case has been FIXED must leave the policy, for the
// same reason a filled baseline pair must leave the baseline: it is a
// hole that stays open. Correct Arabic's dual to restore
// {{count, number}} and the entry sits there armed — so if a later
// patch or API response drops that token again, BOTH the ingestion
// validators and this guard wave it through, and the regression is
// invisible precisely where a human already decided the omission was
// deliberate (Codex #1563 r20).
//
// Checked against what the bundles observably do, not against a
// separate record, so it cannot drift in turn.
const staleExemptions: string[] = [];
for (const [pair, entry] of Object.entries(ALLOWED_OMISSIONS)) {
  const [code] = pair.split(':');
  // A locale whose file is unreadable or absent was never scanned —
  // nothing observed there is evidence of anything.
  if (!missingByLocale.has(code)) continue;
  for (const token of entry.tokens) {
    if (!observedDropped.has(`${pair}:${token}`)) {
      staleExemptions.push(`omission ${pair}:${token} (the locale no longer drops it)`);
    }
  }
}
for (const pair of Object.keys(ALLOWED_EMPTY)) {
  const [code] = pair.split(':');
  if (!missingByLocale.has(code)) continue;
  if (!observedEmpty.has(pair)) {
    staleExemptions.push(`empty ${pair} (the locale no longer leaves it blank)`);
  }
}
if (staleExemptions.length > 0) {
  problems.push(
    `${staleExemptions.length} stale exemption(s) in translation-policy.json — ` +
      'delete them, or they stay armed for a future regression: ' +
      staleExemptions.slice(0, 6).join(', ') +
      (staleExemptions.length > 6 ? ', …' : ''),
  );
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
// A changed English source is reported BEFORE the stale sweep, and
// suppresses it for those keys: "the English moved" and "the locale was
// translated" are different events that look identical from here, and
// only one of them means the debt is gone.
const needsReaudit = reauditNeeded();
const policyStale = policyReauditNeeded();
const policyUnused = unusedPolicyScopes();

// Same stale sweep for the English-valued baseline: an entry that has
// since been translated must LEAVE, or the exemption silently re-opens
// that key to regressing back to English.
const staleEnglishValued: string[] = [];
for (const [key, entry] of Object.entries(ENGLISH_VALUED)) {
  for (const code of entry.locales) {
    if (!translated.includes(code as (typeof translated)[number])) {
      staleEnglishValued.push(`${code}:${key} (not a translated locale)`);
      continue;
    }
    const observed = englishValuedByLocale.get(code);
    // No entry = the bundle was never read; its entries are unrefuted.
    // A key pending re-audit is NOT stale — it stopped matching because
    // the English moved, which is reported separately above.
    if (observed !== undefined && !observed.has(key) && !needsReaudit.has(key)) {
      staleEnglishValued.push(`${code}:${key}`);
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

if (needsReaudit.size > 0) {
  problems.push(
    `${needsReaudit.size} english-valued baseline entr(y/ies) record an ` +
      'English string that en.json no longer has — the recorded locales may ' +
      'now be showing STALE English rather than being translated. Re-check ' +
      'each and update or remove it by hand: ' +
      [...needsReaudit].slice(0, 6).map(([k, why]) => `${k} (${why})`).join(', ') +
      (needsReaudit.size > 6 ? ', …' : ''),
  );
}
if (policyUnused.length > 0) {
  problems.push(
    `${policyUnused.length} acceptedAsTranslated scope(s) name a locale that ` +
      'does not currently hold the value the entry accepts — an exemption is a statement ' +
      'about the present, and one left armed will silently excuse a future ' +
      `regression. Narrow the locale list: ${policyUnused.slice(0, 6).join(', ')}` +
      (policyUnused.length > 6 ? ', …' : ''),
  );
}
if (policyStale.length > 0) {
  problems.push(
    `${policyStale.length} acceptedAsTranslated polic(y/ies) record an English ` +
      'string that en.json no longer has — the written reason may no longer ' +
      `describe what it excuses: ${policyStale.slice(0, 6).join(', ')}` +
      (policyStale.length > 6 ? ', …' : ''),
  );
}
if (staleEnglishValued.length > 0 && !pruning) {
  problems.push(
    `${staleEnglishValued.length} english-valued baseline entr(y/ies) already ` +
      `translated — run \`pnpm --filter @vaipakam/alpha02 i18n:coverage -- --prune\`: ` +
      `${staleEnglishValued.slice(0, 6).join(', ')}` +
      (staleEnglishValued.length > 6 ? ', …' : ''),
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

  // The English-valued baseline prunes on exactly the same rule: every
  // pair written was independently OBSERVED still-English just now, so
  // this can only shrink the record, never excuse a fresh regression.
  const prunedEnglish: Record<string, string[]> = {};
  for (const code of translated) {
    const observed = englishValuedByLocale.get(code);
    if (observed === undefined) {
      for (const [key, entry] of Object.entries(ENGLISH_VALUED)) {
        if (entry.locales.includes(code)) (prunedEnglish[key] ??= []).push(code);
      }
      continue;
    }
    for (const key of observed) {
      if (!isKnownEnglishValued(code, key)) continue; // a NEW one is a failure
      (prunedEnglish[key] ??= []).push(code);
    }
  }
  // A key whose English MOVED is carried through untouched. Pruning it
  // would delete the very debt the re-audit exists to preserve, which
  // is the failure the r1 finding described.
  for (const [key, entry] of Object.entries(ENGLISH_VALUED)) {
    if (needsReaudit.has(key)) prunedEnglish[key] = [...entry.locales];
  }
  const sortedEnglish = Object.fromEntries(
    Object.keys(prunedEnglish)
      .sort()
      .map((k) => [
        k,
        {
          source: ENGLISH_VALUED[k]?.source ?? (leafOrElement(en, k) as string),
          locales: prunedEnglish[k].sort(),
        },
      ]),
  );
  fs.writeFileSync(ENGLISH_VALUED_PATH, JSON.stringify(sortedEnglish, null, 2) + '\n');
  const englishPairs = Object.values(sortedEnglish).flatMap((e) => e.locales).length;
  console.log(
    `[check-locale-coverage] pruned english-valued baseline → ` +
      `${Object.keys(sortedEnglish).length} key(s), ${englishPairs} pair(s)`,
  );
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
  // A key that HOLDS the English string is present, so `--missing-only`
  // walks straight past it — the advice above is the right advice for
  // the wrong failure, and following it would report "nothing to do"
  // on a locale this guard just failed (#1596).
  if (problems.some((p) => p.includes('hold the English string'))) {
    console.error(
      '\nThose keys are PRESENT — they just still read in English, so\n' +
        '`--missing-only` skips every one of them. Do NOT simply drop that\n' +
        'flag: with no locale codes the translator targets bundles that are\n' +
        'missing or `{}`, i.e. the untranslated stubs, and not the locale\n' +
        'that just failed. Either hand-author the strings and merge them\n' +
        'with `merge-patch`, or name the locale explicitly:\n' +
        '  pnpm --filter @vaipakam/i18n translate -- \\\n' +
        '    --locales-dir apps/alpha02/src/i18n/locales <code>\n' +
        'which OVERWRITES and re-translates that entire bundle — paid, and\n' +
        'it discards existing wording, so prefer merge-patch for a handful.\n' +
        'Prune the baseline as they land. If a leaf genuinely reads the\n' +
        'same in that language — or is built from the same words in a\n' +
        'different order, which is a real translation the word comparison\n' +
        'cannot tell from a rearranged English sentence — give it an\n' +
        '`acceptedAsTranslated` entry with a reason AND the English it was\n' +
        'granted against, in src/i18n/translation-policy.json. Where the\n' +
        'locale value is not the English one, record it under `values`.',
    );
  }
  process.exit(1);
}

console.log(
  `[check-locale-coverage] OK — ${translated.length} translated locale(s) cover en.json ` +
    'and keep every interpolation token.',
);
