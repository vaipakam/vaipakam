/**
 * Translate an app's canonical English locale bundle into other
 * supported locales via the Claude API. Generalised from the connected
 * app's own copy of this script — `apps/defi/scripts/translate-i18n.ts`,
 * retired with that app in #1854 — so every surface shares one script
 * (and one glossary + prompt).
 *
 * Usage (from the repo root or the package dir):
 *
 *     ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
 *         --locales-dir apps/app/src/i18n/locales [codes...]
 *
 *   - No codes            → translate every locale whose JSON is
 *                           missing OR is an empty placeholder `{}`.
 *   - Explicit codes      → just those (overwrites existing).
 *   - `--all`             → every non-English locale (overwrites).
 *   - `--missing-only`    → translate ONLY the keys each locale lacks
 *                           and merge them in, leaving every existing
 *                           translation untouched. Combine with codes
 *                           to narrow, or run bare to sweep every
 *                           already-translated locale.
 *   - `--reorder`         → with `--missing-only`, also normalise each
 *                           bundle to en.json's key order. Off by
 *                           default: on a drifted bundle it rewrites
 *                           most of the file and buries the new
 *                           translations in the diff.
 *
 * `--missing-only` is the mode to reach for after adding a new section
 * to `copy.ts`. Without it there was no way to top a locale up: the
 * default mode skips any bundle that isn't an empty placeholder, and
 * `--all` re-translates the entire file to add a handful of keys —
 * churning hundreds of reviewed strings and burying the new ones in an
 * unreviewable diff. The gap that created (#1560: 291 keys missing
 * across nine the connected app's locales, including a whole page) stayed invisible
 * precisely because every bundle looked complete.
 *
 * What it does NOT do: auto-commit. Always review the diff before
 * pushing — machine translation, even with a glossary, occasionally
 * produces an awkward register or mistranslates a homonym in context.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  GLOSSARY_KEEP_VERBATIM,
  GLOSSARY_STYLE_NOTES,
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  type LocaleCode,
} from '../src/glossary.ts';
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

function readFlagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

const localesDirArg = readFlagValue('--locales-dir');
if (!localesDirArg) {
  console.error(
    'Missing --locales-dir <path> (e.g. apps/app/src/i18n/locales).',
  );
  process.exit(1);
}
// pnpm --filter runs scripts with cwd = the package dir; INIT_CWD is
// where the user actually invoked pnpm (repo root in the documented
// command), so relative --locales-dir paths resolve as typed
// (Codex #1309 r7).
const LOCALES_DIR = path.resolve(
  process.env.INIT_CWD ?? process.cwd(),
  localesDirArg,
);
if (!fs.existsSync(LOCALES_DIR)) {
  console.error(`Locales dir not found: ${LOCALES_DIR}`);
  process.exit(1);
}

/**
 * Demanded at the point of the first actual request, not at startup.
 *
 * `--missing-only --reorder` over already-complete bundles does all of
 * its work locally — sort keys, validate values — and makes no request
 * at all, but an unconditional startup check exited before `main()`
 * could get there, so the advertised no-API path was unusable without a
 * credential it never spends (Codex #1563 r24).
 */
function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error(
      'Missing ANTHROPIC_API_KEY env var — needed to translate. ' +
        '(A --reorder-only run over complete bundles does not need it.)',
    );
    process.exit(1);
  }
  return key;
}

// Bump when a stronger model shows up in the Anthropic model list and
// the locale outputs improve under blind review.
const MODEL = 'claude-opus-4-8';

function buildPrompt(sourceJson: object, targetCode: LocaleCode): string {
  const glossaryList = GLOSSARY_KEEP_VERBATIM.join(', ');
  return `You are translating the UI string bundle for Vaipakam, a non-custodial DeFi vault-to-vault lending protocol. Your output will be committed verbatim into the application's locale file for ${LOCALE_NAMES[targetCode]}.

GLOSSARY — keep these terms VERBATIM (do not translate, do not transliterate, do not localise):
${glossaryList}

STYLE NOTES:
${GLOSSARY_STYLE_NOTES}

INPUT (English source JSON):
${JSON.stringify(sourceJson, null, 2)}

OUTPUT REQUIREMENTS:
- Translate every string VALUE to ${LOCALE_NAMES[targetCode]}.
- Preserve every JSON KEY exactly as in the source.
- Preserve nested object structure exactly.
- Return ONLY the translated JSON object. No prose, no markdown code fences, no commentary before or after.`;
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
}

async function callClaude(prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireApiKey(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = (await res.json()) as AnthropicMessageResponse;
  const text = data.content.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('No text content in Anthropic response');
  return text.trim();
}

function extractJson(raw: string): object {
  // Strip a possible ```json fence the model occasionally emits
  // despite the prompt asking for raw JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : raw;
  return JSON.parse(body) as object;
}

function verifyGlossaryPreserved(translated: object, sourceText: string): string[] {
  // Quick sanity check — every glossary term that appears in the
  // English source should also appear (verbatim) in the translated
  // bundle. Flag any missing as warnings (not failures) so the
  // operator can spot a mistranslation before commit.
  const translatedText = JSON.stringify(translated);
  const warnings: string[] = [];
  for (const term of GLOSSARY_KEEP_VERBATIM) {
    if (sourceText.includes(term) && !translatedText.includes(term)) {
      warnings.push(`Glossary term "${term}" missing from output`);
    }
  }
  return warnings;
}


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

/**
 * A bundle counts as a placeholder (→ eligible for the default
 * "fill in the gaps" run) when the file is absent, or parses to an
 * OBJECT with no keys.
 *
 * The root-shape test is load-bearing, not defensive typing.
 * `Object.keys` returns `[]` for `[]`, `0`, `false` and `""` just as it
 * does for `{}`, so a key-count alone called every one of those an
 * empty stub — and a stub is EXCLUDED from the `--missing-only` sweep
 * before the damage check ever sees it. A locale set to `[]` therefore
 * reported "Every translated locale already covers en.json" and exited
 * 0 (Codex #1563 r13). Only `{}` is a stub; every other non-object root
 * is damage, and returning false here routes it to
 * `readBundleOrDamaged`, which reports it and fails the run.
 */
function isPlaceholderBundle(p: string): boolean {
  if (!fs.existsSync(p)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return false; // malformed — damage, not a stub
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  return Object.keys(parsed).length === 0;
}

/** Parse a locale bundle from disk, or `{}` when it is absent. */
function readBundle(p: string): Bundle {
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Bundle;
}

/**
 * `readBundle`, but reporting damage instead of throwing it.
 *
 * A bundle whose JSON is malformed, or whose root is a valid-JSON
 * non-object such as `null`, is not something this script can top up —
 * and it must not be allowed to abort the run either. Discovery reads
 * every locale before any translating happens, so one damaged file
 * threw before the first healthy locale was ever attempted (Codex
 * #1563 r11). `isPlaceholderBundle` cannot stand in for this check: it
 * answers "is this an empty stub", and its own catch reports a
 * malformed file as NON-placeholder, which is what routed the damage
 * here in the first place.
 */
function readBundleOrDamaged(p: string): Bundle | null {
  if (!fs.existsSync(p)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Bundle;
}

async function main() {
  const enPath = path.join(LOCALES_DIR, 'en.json');
  const enRaw = fs.readFileSync(enPath, 'utf8');
  const enJson = JSON.parse(enRaw) as Bundle;

  const missingOnly = args.includes('--missing-only');
  const reorder = args.includes('--reorder');
  const policyArg = readFlagValue('--policy');
  const policyPath = policyArg
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), policyArg)
    : defaultPolicyPath(LOCALES_DIR);
  const policy = loadPolicy(policyPath);
  if (policyPath) console.log(`policy: ${policyPath}`);
  const allowedOmissions = new Set([
    ...policy.omissions,
    ...collectAllowedOmissions(args),
  ]);
  const allowedEmpty = new Set([...policy.empty, ...collectAllowedEmpty(args)]);
  const allFlag = args.includes('--all');
  // Positional args are locale codes — but only the ones that aren't
  // the VALUE of a flag. Skipping just `--locales-dir` meant
  // `--allow-omission "ar:copy…:count, number"` was read as a locale
  // and the run died with `Unknown locale codes:`, making the
  // exemption unusable on the API path it was added for (Codex #1563
  // r5). Listed centrally so a future value-taking flag can't
  // reintroduce it silently.
  const VALUE_FLAGS = new Set([
    '--locales-dir',
    '--allow-omission',
    '--allow-empty',
    '--policy',
  ]);
  const BOOLEAN_FLAGS = new Set(['--missing-only', '--reorder', '--all']);

  // An unknown `--…` token USED to be ignored silently, and the default
  // it fell back to is the expensive one: mistype `--missing-only` as
  // `--missing-onyl` and the run quietly becomes a full-catalog
  // translation of every placeholder bundle — 24 of them in the connected app's
  // locales dir — instead of a gap top-up (Codex #1563 r15). Paid API
  // calls and overwritten files are not a recoverable default, so
  // anything unrecognised aborts before a single target is chosen.
  const unknownFlags = args.filter(
    // A bare `--` is pnpm's own argument separator and reaches us
    // verbatim in the documented invocation — it is not an option.
    (a) => a !== '--' && a.startsWith('--') && !VALUE_FLAGS.has(a) && !BOOLEAN_FLAGS.has(a),
  );
  if (unknownFlags.length > 0) {
    console.error(`Unknown option(s): ${unknownFlags.join(', ')}`);
    console.error(
      `Recognised: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].sort().join(', ')}`,
    );
    process.exit(1);
  }

  const explicitCodes = args.filter(
    (a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''),
  ) as LocaleCode[];

  /**
   * Locales a `--missing-only` sweep could not read at all.
   *
   * Skipped so one damaged file cannot abort the whole batch, and
   * counted as FAILURES so a partial sweep cannot exit 0 (Codex #1563
   * r12). Those are different questions and the first answer does not
   * imply the second: a caller that sees exit 0 is entitled to conclude
   * every translated locale now covers the template, which is exactly
   * what is not true when a bundle was unreadable.
   */
  const unreadable: LocaleCode[] = [];
  /** Readable bundles already holding invalid values, found at discovery. */
  const preExisting = new Map<LocaleCode, string[]>();
  const carriedProblems = (code: LocaleCode, bundle: Bundle): string[] => [
    ...unknownKeys(enJson, bundle).map((k) => `not in en.json: ${k}`),
    ...leafTypeDrift(enJson, bundle).map(
      ({ path: leaf, expected, actual }) => `${leaf}: expected ${expected}, got ${actual}`,
    ),
    ...interpolationProblems(enJson, bundle, allowedOmissions, code),
    ...emptyProblems(enJson, bundle, allowedEmpty, code),
    ...requiredLiteralProblems(bundle, policy.requiredLiterals),
  ];

  let targets: LocaleCode[];
  if (explicitCodes.length > 0) {
    const known = new Set<string>(SUPPORTED_LOCALES);
    const unknown = explicitCodes.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      console.error(`Unknown locale codes: ${unknown.join(', ')}`);
      console.error(`Recognised codes: ${SUPPORTED_LOCALES.join(', ')}`);
      process.exit(1);
    }
    targets = explicitCodes;
  } else if (allFlag) {
    targets = SUPPORTED_LOCALES.filter((c) => c !== 'en');
  } else if (missingOnly) {
    // Sweep the locales that HAVE a bundle and are behind the template.
    // Placeholders are excluded on purpose: an empty `{}` needs the
    // full-bundle path (default mode), not a gap top-up.
    targets = SUPPORTED_LOCALES.filter((c) => {
      if (c === 'en') return false;
      const p = path.join(LOCALES_DIR, `${c}.json`);
      if (isPlaceholderBundle(p)) return false;
      const bundle = readBundleOrDamaged(p);
      if (bundle === null) {
        // Isolated from the SWEEP, but not from the VERDICT — see
        // `unreadable`'s declaration.
        unreadable.push(c);
        return false;
      }
      // Scan EVERY readable bundle, not only the ones with gaps. A
      // locale holding all of en.json's keys but an invalid VALUE — a
      // dropped placeholder, an empty string, a wrong-typed leaf — has
      // nothing to fill, so it never became a target and the
      // post-merge check never ran: the sweep printed "Every
      // translated locale already covers en.json" and exited 0 over a
      // broken bundle (Codex #1563 r17). Coverage is about keys;
      // this is about whether the values are usable, and a sweep that
      // reports the first cannot imply the second.
      const carried = carriedProblems(c, bundle);
      if (carried.length > 0) preExisting.set(c, carried);
      // With --reorder, a bundle that is COMPLETE but merely out of
      // order is still work: the flag normalises the FILE, and skipping
      // it here left a bare `--missing-only --reorder` reporting "Every
      // translated locale already covers en.json" while changing
      // nothing (Codex #1563 r23). The no-API branch below does the
      // reordering, so targeting it costs no API call.
      if (reorder) return true;
      return missingSubtree(enJson, bundle) !== null;
    });
  } else {
    // Default: only locales whose bundle is missing or a `{}` stub —
    // idempotent after a partial failure, and exactly what you want
    // right after seeding placeholder files.
    targets = SUPPORTED_LOCALES.filter((c) => {
      if (c === 'en') return false;
      const p = path.join(LOCALES_DIR, `${c}.json`);
      if (isPlaceholderBundle(p)) return true;
      // Not a stub — so either a real bundle (nothing to do in this
      // mode) or damage. Damage is neither "missing" nor "a stub", so
      // this mode would otherwise pass over it in silence.
      if (readBundleOrDamaged(p) === null) unreadable.push(c);
      return false;
    });
  }

  if (unreadable.length > 0) {
    console.error(
      `⚠ skipped ${unreadable.length} unreadable bundle(s): ${unreadable.join(', ')} — ` +
        'malformed JSON or a non-object root. Fix them by hand; this script ' +
        'cannot classify, diff or merge into a bundle it cannot parse.',
    );
  }

  if (targets.length === 0) {
    // Nothing to do AND something unreadable is not "nothing to do".
    // Either mode's no-op message is a claim about every locale, and a
    // bundle that could not be parsed was never examined — borrowing
    // that line for it is the most misleading outcome the script has.
    if (preExisting.size > 0) {
      console.error(
        `Nothing to fill, but ${preExisting.size} readable bundle(s) hold invalid ` +
          `values: ${[...preExisting.keys()].join(', ')}. Coverage is not the same as health.`,
      );
      process.exitCode = 1;
      return;
    }
    if (unreadable.length > 0) {
      console.error(
        `Nothing to translate among the readable locales, but ${unreadable.length} ` +
          `bundle(s) could not be read: ${unreadable.join(', ')}. ` +
          'Coverage is UNKNOWN for those.',
      );
      process.exitCode = 1;
      return;
    }
    if (missingOnly) {
      console.log('Every translated locale already covers en.json. Nothing to fill.');
      return;
    }
    console.log('No locales to translate. Pass `--all` to retranslate everything,');
    console.log('`--missing-only` to fill gaps in already-translated locales,');
    console.log('or list explicit codes (e.g. `-- es zh hi ja`).');
    return;
  }

  console.log(`Translating ${targets.length} locale(s) into ${LOCALES_DIR}:`);
  console.log(`  ${targets.join(', ')}`);
  console.log();

  const failed: LocaleCode[] = [];
  for (const code of targets) {
    process.stdout.write(`→ ${code} (${LOCALE_NAMES[code]})… `);
    try {
      const outPath = path.join(LOCALES_DIR, `${code}.json`);
      const existing = missingOnly ? readBundle(outPath) : {};
      // In gap-fill mode the model only ever sees the keys this locale
      // lacks, so it cannot restate — let alone silently reword — a
      // string a human already reviewed.
      const source = missingOnly
        ? (missingSubtree(enJson, existing) ?? {})
        : enJson;
      if (missingOnly && Object.keys(source).length === 0) {
        // Nothing to translate — but `--reorder` was asked for, and it
        // is a normalisation of the FILE, not of the fill. Skipping it
        // here meant `--missing-only --reorder es` on a complete but
        // drifted bundle reported "already complete, skipped" and left
        // the file byte-identical, silently doing nothing the operator
        // asked for (Codex #1563 r22). No API call is needed to sort
        // keys.
        let finalBundle = existing;
        if (reorder) {
          const ordered = orderLike(enJson, existing);
          const before = JSON.stringify(existing, null, 2);
          const after = JSON.stringify(ordered, null, 2);
          if (before !== after) {
            writeFileAtomic(outPath, after + '\n');
            finalBundle = ordered;
            console.log('already complete, reordered.');
          } else {
            console.log('already complete, skipped.');
          }
        } else {
          console.log('already complete, skipped.');
        }
        // "Complete" is a statement about KEYS. An EXPLICITLY selected
        // locale never goes through discovery, so this was the one path
        // where a bundle holding every key but an invalid VALUE — a
        // dropped {{amount}}, an empty string, a lost confirmation word
        // — was reported complete and exited 0 (Codex #1563 r23). Same
        // scan the sweep runs, so selecting a locale by name is not a
        // way to be checked less.
        const carried = carriedProblems(code, finalBundle);
        if (carried.length > 0) preExisting.set(code, carried);
        else preExisting.delete(code);
        continue;
      }
      const sourceText = JSON.stringify(source);
      if (missingOnly) {
        process.stdout.write(`(${leafPaths(source).length} missing) `);
      }
      const prompt = buildPrompt(source, code);
      const responseText = await callClaude(prompt);
      const translated = extractJson(responseText) as Bundle;
      // The model's reply is untrusted input that is about to be
      // committed into the app's locale bundle, so validate its SHAPE
      // against what was asked for before it can reach disk. A
      // hallucinated key would land beside the real one (which stays
      // missing), and a non-string leaf renders as nothing in i18next
      // while only logging (Codex #1563 r1).
      const strayKeys = unknownKeys(source, translated);
      const drifted = leafTypeDrift(source, translated);
      // COMPLETENESS matters as much as shape, and only on this side:
      // in the overwrite modes the reply REPLACES the whole locale
      // file, so a truncated or `{}` answer silently deletes every
      // existing translation. `unknownKeys` only inspects keys the
      // reply has and `leafTypeDrift` skips absent ones, so neither
      // notices (Codex #1563 r2). Apps without a locale-coverage
      // command would never find out.
      const short = missingSubtree(source, translated);
      const interpolation = interpolationProblems(source, translated, allowedOmissions, code);
      const empties = emptyProblems(source, translated, allowedEmpty, code);
      // Checked BEFORE the write, in every mode. The carried-damage
      // scan further down only runs for --missing-only and only AFTER
      // the file lands, so full/default modes persisted a translated
      // confirmation word and exited 0, and --missing-only wrote it
      // and then complained (Codex #1563 r18). A prompt that lost the
      // literal makes the gate unpassable for that locale and undoing
      // it is manual, so it must never reach disk.
      // In gap-fill mode the response covers only the missing subtree,
      // so an untouched required path is expected; the merged bundle is
      // checked below. A FULL response is the whole bundle, where an
      // absent literal really is missing.
      const literals = requiredLiteralProblems(
        translated as Bundle,
        policy.requiredLiterals,
        { partial: missingOnly },
      );
      if (
        strayKeys.length > 0 ||
        drifted.length > 0 ||
        short !== null ||
        interpolation.length > 0 ||
        empties.length > 0 ||
        literals.length > 0
      ) {
        const detail = [
          ...strayKeys.slice(0, 5).map((k) => `not requested: ${k}`),
          ...drifted.slice(0, 5).map((d) => `${d.path}: expected ${d.expected}, got ${d.actual}`),
          ...(short ? [`incomplete: ${leafPaths(short).length} key(s) missing, e.g. ${leafPaths(short).slice(0, 3).join(', ')}`] : []),
          ...interpolation.slice(0, 5),
          ...empties.slice(0, 5),
          ...literals.slice(0, 5),
        ].join('; ');
        throw new Error(`response shape rejected — ${detail}`);
      }
      const warnings = verifyGlossaryPreserved(translated, sourceText);
      // Merge in place. Re-ordering against the template is opt-in
      // (`--reorder`): on a bundle whose order has already drifted it
      // rewrites most of the file and buries the new translations.
      const merged = missingOnly
        ? reorder
          ? orderLike(enJson, deepMerge(existing, translated))
          : deepMerge(existing, translated)
        : translated;
      // Atomic: writeFileSync truncates before writing, so a disk
      // filling mid-write would leave a REVIEWED bundle empty or
      // half-written while the catch below reported a tidy per-locale
      // failure (Codex #1563 r22 — the merge path got this in r21 and
      // this one was missed).
      writeFileAtomic(outPath, JSON.stringify(merged, null, 2) + '\n');
      console.log('done.');
      // A gap-fill that comes back short leaves the locale still behind
      // the template — say so rather than reporting a clean "done".
      if (missingOnly) {
        const stillMissing = missingSubtree(enJson, merged as Bundle);
        if (stillMissing) {
          console.log(
            `    warn: ${leafPaths(stillMissing).length} key(s) still missing — re-run to finish`,
          );
        }
        // The checks above validate the API RESPONSE against the subtree
        // that was requested — they say nothing about what the locale
        // already held. A pre-existing invalid leaf, lost token or empty
        // value therefore survived a gap-fill untouched and the run
        // exited 0 (Codex #1563 r16). Same scan the merge-patch path
        // does, honouring the same exact-triple exemptions, so a
        // legitimate omission is excused and nothing else is.
        const carried = [
          ...unknownKeys(enJson, merged as Bundle).map((k) => `not in en.json: ${k}`),
          ...leafTypeDrift(enJson, merged as Bundle).map(
            ({ path: leaf, expected, actual }) =>
              `${leaf}: expected ${expected}, got ${actual}`,
          ),
          ...interpolationProblems(enJson, merged, allowedOmissions, code),
          ...emptyProblems(enJson, merged, allowedEmpty, code),
          ...requiredLiteralProblems(merged as Bundle, policy.requiredLiterals),
        ];
        // `--reorder` drops obsolete keys and the fill closes gaps, so a
        // locale flagged at discovery can be CLEAN by the time it is
        // written. Re-deriving from the final bundle rather than keeping
        // the discovery verdict means a run that repaired everything it
        // found does not still fail (Codex #1563 r19).
        if (carried.length === 0) preExisting.delete(code);
        if (carried.length > 0) {
          preExisting.set(code, carried);
          // The translation IS written — it is valid, and discarding it
          // over damage it did not cause would just lose the work. But
          // the bundle on disk is known-broken, so the run must not
          // report success.
        }
      }
      for (const w of warnings) console.log(`    warn: ${w}`);
    } catch (err) {
      console.log('FAILED.');
      console.error(`    ${(err as Error).message}`);
      failed.push(code);
    }
  }

  // Partial failure must not exit 0 — automation (and a human
  // skimming a long batch) would ship missing/stale bundles. The
  // successful locales' files are already written; re-running with
  // no args picks up exactly the failed ones (they're still
  // missing / placeholder).
  if (failed.length > 0) {
    console.error(
      `\n${failed.length}/${targets.length} locale(s) failed: ${failed.join(', ')}`,
    );
  }
  if (unreadable.length > 0) {
    console.error(
      `${unreadable.length} locale(s) skipped as unreadable: ${unreadable.join(', ')}`,
    );
  }
  // Reported at the END, from the final state, so a problem the run
  // repaired is not announced as if it survived.
  for (const [code, lines] of preExisting) {
    console.error(
      `⚠ ${code}: ${lines.length} problem(s) remain in this bundle — ` +
        'NOT introduced by this run:',
    );
    for (const line of lines.slice(0, 10)) console.error(`      ${line}`);
  }
  if (failed.length > 0 || unreadable.length > 0 || preExisting.size > 0) {
    process.exitCode = 1;
  }
}

void main();
