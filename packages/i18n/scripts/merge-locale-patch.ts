/**
 * Merge hand-authored translation patches into locale bundles.
 *
 *     pnpm --filter @vaipakam/i18n merge-patch -- \
 *         --locales-dir apps/app/src/i18n/locales \
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
  leafTypeDrift,
  missingSubtree,
  orderLike,
  placeholderDrift,
  unknownKeys,
  emptyTranslations,
  requiredLiteralProblems,
  type Bundle,
} from '../src/bundleOps.ts';
import { writeFileAtomic } from './writeFileAtomic.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const localesDirArg = flag('--locales-dir');
const patchesDirArg = flag('--patches');
const reorder = args.includes('--reorder');
const policyArg = flag('--policy');
if (!localesDirArg || !patchesDirArg) {
  console.error('Usage: --locales-dir <path> --patches <path> [--policy <path>] [--reorder]');
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

const policyPath = policyArg
  ? path.resolve(base, policyArg)
  : defaultPolicyPath(LOCALES_DIR);
const policy = loadPolicy(policyPath);
if (policyPath) console.log(`policy: ${policyPath}`);
const allowedOmissions = new Set([
  ...policy.omissions,
  ...collectAllowedOmissions(args),
]);
const allowedEmpty = new Set([...policy.empty, ...collectAllowedEmpty(args)]);

const enJson = JSON.parse(
  fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'),
) as Bundle;


/**
 * Interpolation problems in a candidate bundle, as human-readable
 * lines. Empty when the candidate is clean.
 *
 * The shape checks answer "is this the right key, holding the right
 * kind of value" — they say nothing about the value's CONTENT. A patch
 * that turns `"Paid {{amount}}"` into `"Pagado"` passes every one of
 * them and writes a sentence that has silently lost the number it was
 * about (Codex #1563 r3). Consumers without their own coverage command
 * — `apps/www` today — would never find out.
 *
 * `unknown` and `malformed` are ALWAYS rejected: i18next has nothing to
 * substitute for an invented token, and renders a malformed brace run
 * literally.
 *
 * `dropped` is rejected unless the EXACT `<locale>:<path>:<token>`
 * triple was allowed on the command line. A blanket "allow omissions"
 * switch was the first shape of this and it was too coarse (Codex
 * #1563 r4): one legitimate omission — a dual form that already means
 * "two days" and must not restate the count — licensed every other
 * dropped placeholder in the same delivery, so an unrelated
 * `{{amount}}` could vanish from a sentence under an exemption granted
 * for something else. Naming the triple keeps the escape hatch exactly
 * as wide as the case that needs it.
 */
function interpolationProblems(source, candidate, allowedOmissions, code) {
  const lines = [];
  for (const { path: key, unknown, dropped, malformed } of placeholderDrift(
    source,
    candidate,
  )) {
    if (unknown.length > 0) lines.push(`${key}: invents {{${unknown.join('}}, {{')}}}`);
    if (malformed.length > 0) lines.push(`${key}: malformed brace run(s) ${malformed.join(', ')}`);
    for (const token of dropped) {
      if (allowedOmissions.has(`${code}:${key}:${token}`)) continue;
      // The suggested flag is QUOTED: a formatted token carries a
      // space (`count, number`), and unquoted the shell splits it in
      // two — the operator pastes the line the tool printed and the
      // merge still fails (Codex #1563 r5).
      lines.push(
        `${key}: drops {{${token}}} (allow with --allow-omission "${code}:${key}:${token}" ` +
          'only if the grammar already carries it)',
      );
    }
  }
  return lines;
}

/** Collect repeatable `--flag <value>` args into a Set. */
function collectFlagValues(argv, flag) {
  const out = new Set();
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1]) out.add(argv[i + 1]);
  });
  return out;
}

// Function DECLARATIONS, not const arrows: both are called at module
// top level, above where they sit in the file, and a const would be in
// its temporal dead zone there (`ReferenceError: Cannot access ...
// before initialization`).
function collectAllowedOmissions(argv) {
  return collectFlagValues(argv, '--allow-omission');
}
function collectAllowedEmpty(argv) {
  return collectFlagValues(argv, '--allow-empty');
}

/**
 * Load the per-repo translation POLICY from a COMMITTED record —
 * required literals plus the narrow linguistic exemptions — merged with
 * any exemptions passed on the command line.
 *
 * The file is the primary channel and the flags are the escape hatch
 * for a one-off. Repeating an exemption on every run is how it becomes
 * a reflex, and a flag people always pass guards nothing (Codex #1563
 * r16) — so a repo whose locales carry standing linguistic exemptions
 * (Arabic's dual, Japanese's trailing verb) records them once and every
 * ingestion path reads the same answers.
 */
/**
 * Where a repo's policy file lives when `--policy` is not given:
 * `<locales-dir>/../translation-policy.json`.
 *
 * Convention rather than a required flag, because a check you have to
 * REMEMBER to switch on is not a check. Every documented command shape
 * would otherwise need the flag, and the one an operator pasted from
 * somewhere older would silently run with `requiredLiterals` empty —
 * writing a confirmation prompt that makes the gate unpassable and
 * exiting 0 (Codex #1563 r19). `--policy` still overrides, for a repo
 * that keeps it elsewhere.
 */
function defaultPolicyPath(localesDir) {
  const guess = path.resolve(localesDir, '..', 'translation-policy.json');
  return fs.existsSync(guess) ? guess : undefined;
}

function loadPolicy(file) {
  if (!file) {
    return { omissions: new Set(), empty: new Set(), requiredLiterals: {} };
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const omissions = new Set();
  for (const [pair, entry] of Object.entries(raw.omissions ?? {})) {
    for (const token of entry.tokens ?? []) omissions.add(`${pair}:${token}`);
  }
  return {
    omissions,
    empty: new Set(Object.keys(raw.empty ?? {})),
    requiredLiterals: raw.requiredLiterals ?? {},
  };
}




/** What a rejected patch root actually was, for the error line. */
function describeRoot(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Leaves the candidate leaves EMPTY where the English is not.
 *
 * No other check sees these — the key is present, the value is a valid
 * string, and there are no tokens to compare — while i18next renders an
 * empty resource as BLANK instead of falling back, so the sentence
 * silently disappears for that language (Codex #1563 r6). Legitimate
 * cases exist (Japanese puts the verb last, leaving a sentence prefix
 * empty), hence the same per-`<locale>:<path>` escape hatch shape the
 * omission exemptions use.
 */
function emptyProblems(source, candidate, allowedEmpty, code) {
  return emptyTranslations(source, candidate)
    .filter((key) => !allowedEmpty.has(`${code}:${key}`))
    .map(
      (key) =>
        `${key}: empty while the English is not (allow with --allow-empty "${code}:${key}" ` +
        'only if the grammar genuinely leaves it blank)',
    );
}

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
  // Read-and-catch rather than exists-then-read: the two-step form is a
  // TOCTOU race (the file can vanish between the check and the read) and
  // CodeQL flags it as one.
  // The DESTINATION needs the same parse + root-shape validation as the
  // patch, and for the same reason: a malformed or `null` bundle
  // already on disk otherwise threw out of here (or later out of
  // `missingSubtree`) and took the whole batch with it, leaving every
  // locale sorting after this one unwritten under a raw stack trace
  // (Codex #1563 r11). Absent is fine — that's a first translation.
  let existing: Bundle = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `✗ ${code}: existing ${code}.json root is ${describeRoot(parsed)}, ` +
          'expected an object — nothing written',
      );
      failures += 1;
      continue;
    }
    existing = parsed as Bundle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `✗ ${code}: existing ${code}.json is not valid JSON — nothing written\n    ${(err as Error).message}`,
      );
      failures += 1;
      continue;
    }
  }
  // A patch file is untrusted input — hand-authored, or whatever a
  // vendor returned. Both the parse and the ROOT SHAPE have to be
  // checked here, because every validator below assumes an object and
  // `Object.entries(null)` throws. An uncaught throw would abort the
  // whole batch mid-run: one bad file and every locale sorting after it
  // is silently left unwritten, with a raw stack trace in place of the
  // per-locale rejection this loop exists to print (Codex #1563 r10).
  let patch: Bundle;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(PATCHES_DIR, file), 'utf8'),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `✗ ${code}: patch root is ${describeRoot(parsed)}, expected an object — nothing written`,
      );
      failures += 1;
      continue;
    }
    patch = parsed as Bundle;
  } catch (err) {
    console.error(
      `✗ ${code}: patch is not valid JSON — nothing written\n    ${(err as Error).message}`,
    );
    failures += 1;
    continue;
  }

  // Validate BEFORE writing anything. A patch key the template doesn't
  // have is a typo or a stale key, and merging it is worse than
  // rejecting it: the wrong key lands, the real one stays missing, and
  // the run still prints a ✓. Same for a leaf whose shape doesn't match
  // — i18next renders nothing for a non-string and only logs.
  const strayKeys = unknownKeys(enJson, patch);
  const drifted = leafTypeDrift(enJson, patch);
  const interpolation = interpolationProblems(enJson, patch, allowedOmissions, code);
  const empties = emptyProblems(enJson, patch, allowedEmpty, code);
  // Checked on the PATCH, so a delivery that translates a typed-
  // confirmation word is rejected outright rather than written and
  // then reported: this is the one class where the written file makes
  // the gate unpassable for that language, and reverting it is manual.
  // (The merged bundle is checked too, further down, for a literal the
  // locale had already lost.)
  // `partial: true` — a patch carries only the keys being supplied, so
  // an untouched required path is not a finding here. The MERGED
  // candidate below is checked without it, which is where absence
  // genuinely means the bundle has lost the literal.
  const literals = requiredLiteralProblems(patch, policy.requiredLiterals, {
    partial: true,
  });
  if (
    strayKeys.length > 0 ||
    drifted.length > 0 ||
    interpolation.length > 0 ||
    empties.length > 0 ||
    literals.length > 0
  ) {
    console.error(`✗ ${code}: patch rejected, nothing written`);
    for (const key of strayKeys.slice(0, 10)) {
      console.error(`    not in en.json: ${key}`);
    }
    for (const { path: p, expected, actual } of drifted.slice(0, 10)) {
      console.error(`    ${p}: expected ${expected}, got ${actual}`);
    }
    for (const line of interpolation.slice(0, 10)) console.error(`    ${line}`);
    for (const line of empties.slice(0, 10)) console.error(`    ${line}`);
    for (const line of literals.slice(0, 10)) console.error(`    ${line}`);
    failures += 1;
    continue;
  }

  const before = missingSubtree(enJson, existing);
  const spliced = deepMerge(existing, patch);
  const merged = reorder ? orderLike(enJson, spliced) : spliced;
  const after = missingSubtree(enJson, merged);

  // The MERGED candidate, not just the patch. Validating only the
  // incoming patch trusted whatever nested damage the destination
  // already held: an existing leaf holding a number where English has a
  // string survived the merge untouched, and `missingSubtree` counts it
  // as PRESENT — so the run printed "0 still missing" and exited 0 over
  // a bundle that renders nothing there (Codex #1563 r15). Consumers
  // without their own coverage command, `apps/www` today, have nothing
  // downstream to catch it.
  //
  // The SAME validators the patch faces, applied to the whole merged
  // result. An earlier cut excluded dropped tokens and empty values
  // because both have real linguistic cases (Arabic's dual encodes the
  // count in the noun; Japanese puts the verb last leaving a prefix
  // empty) — but excluding the CATEGORY also hid a genuinely lost
  // `{{amount}}`, which is the bug class the placeholder check exists
  // for. The right instrument is the exemption that already exists and
  // names the exact `<locale>:<path>:<token>` triple, so a legitimate
  // omission is excused and nothing else is (Codex #1563 r16). Both
  // helpers already honour those allowlists; the failure message
  // prints the exact flag to paste.
  const carriedDamage = [
    ...unknownKeys(enJson, merged).map((k) => `not in en.json: ${k}`),
    ...leafTypeDrift(enJson, merged).map(
      ({ path: leaf, expected, actual }) => `${leaf}: expected ${expected}, got ${actual}`,
    ),
    ...interpolationProblems(enJson, merged, allowedOmissions, code),
    ...emptyProblems(enJson, merged, allowedEmpty, code),
    // A typed-confirmation word that did not survive translation. The
    // prompt glossary cannot hold this — it is advisory, and this path
    // never consulted it at all (Codex #1563 r17).
    ...requiredLiteralProblems(merged, policy.requiredLiterals),
  ];

  const filled =
    (before ? leafPaths(before).length : 0) - (after ? leafPaths(after).length : 0);
  // Isolated like every other per-locale failure — a read-only file or
  // a full disk otherwise threw out of the loop and silently skipped
  // every patch sorting after this one (Codex #1563 r20).
  //
  // And written via a temp file + rename, because catching the error is
  // not enough: `writeFileSync` TRUNCATES the destination before it
  // writes, so a disk that fills mid-write leaves the locale empty or
  // half-written and the catch reports a tidy failure over a bundle
  // that has already lost its translations (Codex #1563 r21). Same
  // directory, so the rename is a same-filesystem atomic replace rather
  // than a copy that can fail halfway.
  try {
    writeFileAtomic(targetPath, JSON.stringify(merged, null, 2) + '\n');
  } catch (err) {
    console.error(`✗ ${code}: could not write ${code}.json — ${(err as Error).message}`);
    failures += 1;
    continue;
  }

  const remaining = after ? leafPaths(after).length : 0;
  console.log(
    `✓ ${code} (${LOCALE_NAMES[code]}): filled ${filled}, ${remaining} still missing`,
  );

  // The patch itself was valid and is written — refusing it over damage
  // it did not cause would just strand a good translation. But the
  // bundle on disk is now known-broken, so the run must not report
  // success: "still missing" counts a wrong-typed leaf as present, and
  // that number is exactly what an operator reads as "done".
  if (carriedDamage.length > 0) {
    console.error(
      `  ⚠ ${code}: patch written, but ${carriedDamage.length} pre-existing problem(s) ` +
        'remain in this bundle — NOT introduced by this patch, and not counted above:',
    );
    for (const line of carriedDamage.slice(0, 10)) console.error(`      ${line}`);
    failures += 1;
  }
}

if (failures > 0) process.exitCode = 1;
