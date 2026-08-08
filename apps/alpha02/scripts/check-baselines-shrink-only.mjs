/**
 * Guardrail (#1596, Codex #1607 r18): the two i18n baselines may only
 * SHRINK. Fails if a change ADDS a `(key, locale)` pair to either.
 *
 *   node scripts/check-baselines-shrink-only.mjs --base <git-ref>
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

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
const pairsOf = (text, where) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${error.message}`);
  }
  const out = new Set();
  for (const [key, entry] of Object.entries(parsed)) {
    const locales = Array.isArray(entry) ? entry : entry?.locales;
    if (!Array.isArray(locales)) {
      throw new Error(`${where} entry "${key}" has no locales array`);
    }
    for (const code of locales) out.add(`${code}:${key}`);
  }
  return out;
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
const atBase = (repoPath) => {
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

const problems = [];

for (const repoPath of BASELINES) {
  const beforeText = atBase(repoPath);
  if (beforeText === null) {
    // The file is new in this change, so there is no prior size and
    // nothing can have grown. Reported rather than silent: a new
    // baseline is a claim about debt that already existed, and its
    // contents are what the reviewing of THAT change is for.
    const initial = pairsOf(
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
  const before = pairsOf(beforeText, `${repoPath}@${baseRef}`);
  const after = pairsOf(fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8'), repoPath);
  const added = [...after].filter((pair) => !before.has(pair)).sort();
  if (added.length > 0) {
    problems.push(
      `${repoPath} GREW by ${added.length} pair(s): ${added.slice(0, 8).join(', ')}` +
        (added.length > 8 ? ', …' : '') +
        '\n    This record may only shrink. A newly untranslated string is ' +
        'not something to record — it is something to translate before the ' +
        'change ships, in the same pass that ships the surface.',
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
