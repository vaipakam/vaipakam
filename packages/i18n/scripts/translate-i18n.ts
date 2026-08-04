/**
 * Translate an app's canonical English locale bundle into other
 * supported locales via the Claude API. Generalised from
 * apps/defi/scripts/translate-i18n.ts so every surface shares one
 * script (and one glossary + prompt).
 *
 * Usage (from the repo root or the package dir):
 *
 *     ANTHROPIC_API_KEY=... pnpm --filter @vaipakam/i18n translate -- \
 *         --locales-dir apps/alpha02/src/i18n/locales [codes...]
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
 * across nine alpha02 locales, including a whole page) stayed invisible
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
  missingSubtree,
  orderLike,
  type Bundle,
} from '../src/bundleOps.ts';

const args = process.argv.slice(2);

function readFlagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

const localesDirArg = readFlagValue('--locales-dir');
if (!localesDirArg) {
  console.error(
    'Missing --locales-dir <path> (e.g. apps/alpha02/src/i18n/locales).',
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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY env var.');
  process.exit(1);
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
      'x-api-key': ANTHROPIC_API_KEY as string,
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

/** A bundle counts as a placeholder (→ eligible for the default
 *  "fill in the gaps" run) when the file is absent or parses to an
 *  object with no keys. */
function isPlaceholderBundle(p: string): boolean {
  if (!fs.existsSync(p)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as object;
    return Object.keys(parsed).length === 0;
  } catch {
    return false; // malformed — leave alone, surface in review
  }
}

/** Parse a locale bundle from disk, or `{}` when it is absent. */
function readBundle(p: string): Bundle {
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Bundle;
}

async function main() {
  const enPath = path.join(LOCALES_DIR, 'en.json');
  const enRaw = fs.readFileSync(enPath, 'utf8');
  const enJson = JSON.parse(enRaw) as Bundle;

  const missingOnly = args.includes('--missing-only');
  const reorder = args.includes('--reorder');
  const allFlag = args.includes('--all');
  const explicitCodes = args.filter(
    (a, i) => !a.startsWith('--') && args[i - 1] !== '--locales-dir',
  ) as LocaleCode[];

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
      return missingSubtree(enJson, readBundle(p)) !== null;
    });
  } else {
    // Default: only locales whose bundle is missing or a `{}` stub —
    // idempotent after a partial failure, and exactly what you want
    // right after seeding placeholder files.
    targets = SUPPORTED_LOCALES.filter(
      (c) => c !== 'en' && isPlaceholderBundle(path.join(LOCALES_DIR, `${c}.json`)),
    );
  }

  if (targets.length === 0) {
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
        console.log('already complete, skipped.');
        continue;
      }
      const sourceText = JSON.stringify(source);
      if (missingOnly) {
        process.stdout.write(`(${leafPaths(source).length} missing) `);
      }
      const prompt = buildPrompt(source, code);
      const responseText = await callClaude(prompt);
      const translated = extractJson(responseText) as Bundle;
      const warnings = verifyGlossaryPreserved(translated, sourceText);
      // Merge in place. Re-ordering against the template is opt-in
      // (`--reorder`): on a bundle whose order has already drifted it
      // rewrites most of the file and buries the new translations.
      const merged = missingOnly
        ? reorder
          ? orderLike(enJson, deepMerge(existing, translated))
          : deepMerge(existing, translated)
        : translated;
      fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
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
    process.exitCode = 1;
  }
}

void main();
