/**
 * Guardrail (#1596, Codex #1607 r18): the two i18n baselines may only
 * SHRINK. Fails if a change ADDS a `(key, locale)` pair to either.
 *
 *   tsx scripts/check-baselines-shrink-only.ts --base <git-ref>
 *
 * WHY THIS EXISTS SEPARATELY FROM `check-locale-coverage.ts`.
 * That guard detects a locale value that still reads in English and
 * fails unless the pair is recorded in `english-valued-baseline.json`.
 * The record is a file in the same repository, so the same change that
 * introduces a regression can record it and go green — which makes the
 * "the record can only shrink" rule, stated in the release note, the
 * functional spec and the code-vs-docs audit, prose rather than a
 * guarantee. Reproduced exactly that way: set `de:copy.chrome.nav
 * .settings` to `Settings`, add the pair, and the build passes.
 *
 * A guard cannot check this against itself — nothing in the working
 * tree is immutable. It needs a reference point outside the change,
 * which is what the merge base is.
 *
 * Both baselines are covered. `untranslated-baseline.json` carries the
 * identical rule ("Shrink it — never grow it") and had the identical
 * gap.
 *
 * NOT a substitute for review. Someone with commit rights can always
 * change the rule itself. What this stops is the quiet case: a pair
 * added in a large diff, under a heading that says the file only ever
 * loses entries, where nobody would think to check.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stillEnglish } from '../src/i18n/stillEnglish.ts';
import {
  isAcceptedAsTranslated,
  type AcceptedAsTranslatedEntry,
} from '../src/i18n/translationPolicy.ts';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * The committed policy, as it stands AFTER the change.
 *
 * Deliberately the new one, not the base's: recognising a backlog entry
 * as a legitimate identical translation is a change that adds the
 * policy entry and removes the baseline pair together, and it is the
 * new entry that authorizes the removal.
 */
const POLICY: Readonly<Record<string, AcceptedAsTranslatedEntry>> = (() => {
  const file = path.join(
    REPO_ROOT,
    'apps/alpha02/src/i18n/translation-policy.json',
  );
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    acceptedAsTranslated?: Record<string, AcceptedAsTranslatedEntry>;
  };
  return parsed.acceptedAsTranslated ?? {};
})();

/** Repo-relative, because that is how `git show <ref>:<path>` addresses. */
const BASELINES = [
  'apps/alpha02/src/i18n/untranslated-baseline.json',
  'apps/alpha02/src/i18n/english-valued-baseline.json',
];

const baseIndex = process.argv.indexOf('--base');
const baseRef = baseIndex === -1 ? undefined : process.argv[baseIndex + 1];

if (!baseRef) {
  // Local runs have no meaningful "before". Silent rather than noisy:
  // the developer's own edit IS the change under review, and there is
  // nothing to compare it against until it reaches CI.
  console.log(
    '[check-baselines-shrink-only] no --base ref given — skipped (CI passes one)',
  );
  process.exit(0);
}

/**
 * Both baselines are `{ "<key>": { … , "locales": [...] } }` OR the
 * older `{ "<key>": [...] }`. Flattened to `<locale>:<key>` either way,
 * so the check does not depend on which shape a file currently uses.
 */
const entriesOf = (text: string, where: string): Map<string, string | undefined> => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${(error as Error).message}`);
  }
  // `<locale>:<key>` -> the English text the entry was recorded against
  // (undefined for the missing-key baseline, which records no source).
  const out = new Map<string, string | undefined>();
  for (const [key, entry] of Object.entries(parsed)) {
    const locales = Array.isArray(entry) ? entry : entry?.locales;
    if (!Array.isArray(locales)) {
      throw new Error(`${where} entry "${key}" has no locales array`);
    }
    for (const code of locales) out.set(`${code}:${key}`, entry?.source);
  }
  return out;
};

/** `<locale>:<key>` -> what that locale actually holds right now. */
const currentValue = (pair: string): string | undefined => {
  const [code, key] = [pair.slice(0, pair.indexOf(':')), pair.slice(pair.indexOf(':') + 1)];
  const file = path.join(REPO_ROOT, 'apps/alpha02/src/i18n/locales', `${code}.json`);
  if (!fs.existsSync(file)) return undefined;
  let node: unknown;
  try {
    node = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  // Segments, with `a.b[2]` addressing an array element.
  for (const segment of key.split('.')) {
    const m = /^(.*)\[(\d+)\]$/.exec(segment);
    const name = m ? m[1] : segment;
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[name];
    if (m) node = Array.isArray(node) ? node[Number(m[2])] : undefined;
  }
  return typeof node === 'string' ? node : undefined;
};

/**
 * Resolve the base ref UP FRONT, before reading any file.
 *
 * A shallow clone that never fetched the base makes every `git show`
 * fail, which is indistinguishable from "the file is new" if you only
 * inspect per-file errors — so the check would pass everything and
 * report nothing. Matching git's wording in stderr was the first
 * attempt and it silently did not fire: git says "invalid object name",
 * not "not a valid object name". Ask the question directly instead.
 */
try {
  execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
} catch {
  console.error(
    `[check-baselines-shrink-only] cannot resolve --base ${baseRef}. ` +
      'Fetch it before running this check — a missing base must fail ' +
      'rather than pass everything.',
  );
  process.exit(1);
}

/** The file's content at `baseRef`, or null if it did not exist there. */
const atBase = (repoPath: string): string | null => {
  try {
    return execFileSync('git', ['show', `${baseRef}:${repoPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // The ref itself is known good, so the only remaining cause is that
    // the path did not exist there.
    return null;
  }
};

const problems: string[] = [];

for (const repoPath of BASELINES) {
  const beforeText = atBase(repoPath);
  if (beforeText === null) {
    // The file is new in this change, so there is no prior size and
    // nothing can have grown. Reported rather than silent: a new
    // baseline is a claim about debt that already existed, and its
    // contents are what the reviewing of THAT change is for.
    const initial = entriesOf(
      fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8'),
      repoPath,
    );
    console.log(
      `[check-baselines-shrink-only] ${repoPath} is new at ${baseRef} — ` +
        `${initial.size} pair(s) recorded, nothing to compare. Enforcement ` +
        'starts from the next change.',
    );
    continue;
  }
  const before = entriesOf(beforeText, `${repoPath}@${baseRef}`);
  const after = entriesOf(fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8'), repoPath);
  const added = [...after.keys()].filter((pair) => !before.has(pair)).sort();
  if (added.length > 0) {
    problems.push(
      `${repoPath} GREW by ${added.length} pair(s): ${added.slice(0, 8).join(', ')}` +
        (added.length > 8 ? ', …' : '') +
        '\n    This record may only shrink. A newly untranslated string is ' +
        'not something to record — it is something to translate before the ' +
        'change ships, in the same pass that ships the surface.',
    );
  }

  // REMOVALS need checking too, and that is not obvious. Shrinking is
  // the point of the record, so an additions-only check reads as
  // sufficient — but a pair may only leave because the locale was
  // TRANSLATED, and nothing was verifying that.
  //
  // The gap is not hypothetical: reword the English, leave the locale
  // showing the old text, and delete its baseline entry, all in one
  // change. `reauditNeeded` in the coverage guard can only inspect
  // entries that still EXIST, so deleting the entry deletes the
  // evidence — the locale no longer matches the new English, is no
  // longer recorded, and both guards go green while a reader still
  // meets the old English (Codex #1607 r22). Round 1 established that
  // inequality is not proof of translation; this is the same defect one
  // level up, where the record that proves it can be dropped.
  //
  // So: a removed pair whose locale STILL HOLDS the exact English the
  // entry was recorded against has not been translated, whatever the
  // English says now.
  const removed = [...before.keys()].filter((pair) => !after.has(pair)).sort();
  //
  // Compared with the coverage guard's OWN still-English rule, imported
  // rather than restated. An exact comparison was the first attempt and
  // it let the evidence go: the committed baseline already holds values
  // those rules deliberately normalize away — `ko:contractError
  // .SaleListingActive` differs from the English only in case — so
  // lowercasing a value was enough to make its record deletable (Codex
  // #1607 r23). Two guards asking the same question had to agree, and
  // the only way to guarantee that is one definition.
  const wrongful = removed.filter((pair) => {
    const recordedSource = before.get(pair);
    if (typeof recordedSource !== 'string') return false; // no source recorded
    const value = currentValue(pair);
    if (typeof value !== 'string' || !stillEnglish(recordedSource, value)) {
      return false;
    }
    // UNLESS the committed policy now authorizes this exact value.
    //
    // The two guards deadlocked without this. Recognising a backlog
    // entry as a legitimate identical translation — German `Support`,
    // whose translated sibling reads `Support und Verbindungsprüfung` —
    // means adding a policy entry AND removing the baseline pair. The
    // removal check would reject it precisely BECAUSE the value still
    // reads as English, which is the whole reason it needed an entry:
    // coverage would pass, this required check would fail, and there
    // would be no supported way to correct a false-positive backlog
    // entry (Codex #1607 r25).
    //
    // Exact match through the shared policy rule, so this authorizes
    // the reviewed value and nothing near it. An unapproved removal is
    // still refused.
    const [code, key] = [
      pair.slice(0, pair.indexOf(':')),
      pair.slice(pair.indexOf(':') + 1),
    ];
    return !isAcceptedAsTranslated(POLICY, key, code, value);
  });
  if (wrongful.length > 0) {
    problems.push(
      `${repoPath} REMOVED ${wrongful.length} pair(s) that are not translated: ` +
        `${wrongful.slice(0, 8).join(', ')}` +
        (wrongful.length > 8 ? ', …' : '') +
        '\n    Each still reads as the English it was recorded against — by ' +
        'the same rule the coverage guard uses, so a difference of case, ' +
        'spacing, punctuation or repetition does not count as translated ' +
        'here either. Removing one deletes the record of debt that is still ' +
        'owed rather than marking it paid. If the English was reworded, ' +
        're-audit the entry and update its source; do not drop it.',
    );
  }
}

if (problems.length > 0) {
  console.error('[check-baselines-shrink-only] FAILED\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(
    'If a pair genuinely belongs in the record — an existing gap being ' +
      'documented rather than a new one being created — say so in the PR ' +
      'and have a reviewer agree before overriding.',
  );
  process.exit(1);
}

console.log(
  `[check-baselines-shrink-only] OK — neither baseline grew against ${baseRef}.`,
);
