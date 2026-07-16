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
const LOCALES_DIR = path.resolve(process.cwd(), localesDirArg);
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

async function main() {
  const enPath = path.join(LOCALES_DIR, 'en.json');
  const enRaw = fs.readFileSync(enPath, 'utf8');
  const enJson = JSON.parse(enRaw) as object;

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
  } else {
    // Default: only locales whose bundle is missing or a `{}` stub —
    // idempotent after a partial failure, and exactly what you want
    // right after seeding placeholder files.
    targets = SUPPORTED_LOCALES.filter(
      (c) => c !== 'en' && isPlaceholderBundle(path.join(LOCALES_DIR, `${c}.json`)),
    );
  }

  if (targets.length === 0) {
    console.log('No locales to translate. Pass `--all` to retranslate everything,');
    console.log('or list explicit codes (e.g. `-- es zh hi ja`).');
    return;
  }

  console.log(`Translating ${targets.length} locale(s) into ${LOCALES_DIR}:`);
  console.log(`  ${targets.join(', ')}`);
  console.log();

  for (const code of targets) {
    process.stdout.write(`→ ${code} (${LOCALE_NAMES[code]})… `);
    try {
      const prompt = buildPrompt(enJson, code);
      const responseText = await callClaude(prompt);
      const translated = extractJson(responseText);
      const warnings = verifyGlossaryPreserved(translated, enRaw);
      const outPath = path.join(LOCALES_DIR, `${code}.json`);
      fs.writeFileSync(outPath, JSON.stringify(translated, null, 2) + '\n');
      console.log('done.');
      for (const w of warnings) console.log(`    warn: ${w}`);
    } catch (err) {
      console.log('FAILED.');
      console.error(`    ${(err as Error).message}`);
    }
  }
}

void main();
