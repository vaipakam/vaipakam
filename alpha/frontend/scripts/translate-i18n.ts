/**
 * Translate the canonical English locale bundle into every other
 * supported locale via the Claude API. Run from the `frontend/`
 * directory:
 *
 *     ANTHROPIC_API_KEY=... npm run translate
 *
 * What it does
 * ------------
 * 1. Reads `src/i18n/locales/en.json` (the source of truth).
 * 2. For each locale in `SUPPORTED_LOCALES` and `PENDING_LOCALES`
 *    (excluding `en`), calls the Claude API with:
 *      - The full glossary (`GLOSSARY_KEEP_VERBATIM`) as a do-not-
 *        translate constraint.
 *      - The style notes (`GLOSSARY_STYLE_NOTES`) as register /
 *        tone guidance.
 *      - The source JSON.
 * 3. Parses the model response as JSON and writes it to
 *    `src/i18n/locales/<code>.json`.
 *
 * What it does NOT do
 * -------------------
 * - It doesn't auto-commit. Always review the diff before pushing —
 *   machine translation, even with a glossary, occasionally produces
 *   an awkward register or mistranslates a homonym in context.
 * - It doesn't translate the UserGuide-Basic.md / UserGuide-Advanced.md
 *   long-form docs. Those are Phase 3 — separate `.md` per locale,
 *   handled by a sister script (TBD) that translates Markdown while
 *   preserving headings, anchors, and code blocks.
 * - It doesn't translate the cardHelp.ts summaries. Those are Phase 2.
 *
 * Why fetch and not the Anthropic SDK
 * -----------------------------------
 * This is a build-time script that runs maybe once a week when
 * source strings change. Pulling in `@anthropic-ai/sdk` for that
 * cadence isn't worth the dependency weight. The Messages API is
 * stable enough that a thin fetch wrapper is fine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLOSSARY_KEEP_VERBATIM,
  GLOSSARY_STYLE_NOTES,
  SUPPORTED_LOCALES,
  type LocaleCode,
} from '../src/i18n/glossary.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, '..', 'src', 'i18n', 'locales');

const LOCALE_NAMES: Record<LocaleCode, string> = {
  // Already translated
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  ja: 'Japanese (日本語)',
  zh: 'Simplified Chinese (中文)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
  ta: 'Tamil (தமிழ்)',
  ko: 'Korean (한국어)',
  // South Asia placeholders
  te: 'Telugu (తెలుగు)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ml: 'Malayalam (മലയാളം)',
  bn: 'Bengali (বাংলা)',
  mr: 'Marathi (मराठी)',
  pa: 'Punjabi (ਪੰਜਾਬੀ)',
  gu: 'Gujarati (ગુજરાતી)',
  ur: 'Urdu (اردو) — RTL',
  // SE Asia placeholders
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ไทย)',
  tl: 'Filipino / Tagalog (use natural Tagalog with English code-switching where standard in Philippine fintech UI; "wallet" stays as "wallet"; translate "lend"/"borrow" to "magpautang"/"humiram")',
  id: 'Bahasa Indonesia — formal-but-modern fintech register, "Anda" for second person, accept English fintech loanwords (wallet, token, blockchain) where standard',
  // European placeholders
  pt: 'Portuguese (Brazilian — "Português (Brasil)") — use "você" not "tu", "registrar" not "registar", "tela" not "ecrã", "aplicativo" or "app" not "aplicação", "celular" not "telemóvel"',
  ru: 'Russian (Русский) — second-person formal "вы"',
  uk: 'Ukrainian (Українська) — second-person "ви"',
  tr: 'Turkish (Türkçe) — second-person informal "sen" (Turkish crypto apps overwhelmingly use sen, not formal siz)',
  it: 'Italian (Italiano) — second-person informal "tu" (fintech apps in Italian use tu by convention, not Lei)',
  nl: 'Dutch (Nederlands) — second-person informal "je/jij" (not "u"); accept English loanwords where standard in fintech',
  pl: 'Polish (Polski) — second-person informal forms typical of fintech apps',
  el: 'Greek (Ελληνικά)',
  cs: 'Czech (Čeština)',
  // Middle East RTL placeholders
  fa: 'Persian / Farsi (فارسی) — RTL',
  he: 'Hebrew (עברית) — RTL',
  // Africa
  sw: 'Swahili / Kiswahili sanifu (East African register, second-person familiar wewe/-ko-, accept English loanwords like wallet/blockchain where standard; pochi is fine for wallet)',
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY env var.');
  process.exit(1);
}

// claude-opus-4-7 is the latest Opus available at writing. Bump when
// a stronger Opus / Sonnet shows up in the Anthropic model list and
// the locale outputs improve under blind review.
const MODEL = 'claude-opus-4-7';

function buildPrompt(sourceJson: object, targetCode: LocaleCode): string {
  const glossaryList = GLOSSARY_KEEP_VERBATIM.join(', ');
  return `You are translating the UI string bundle for Vaipakam, a non-custodial DeFi peer-to-peer lending protocol. Your output will be committed verbatim into the application's locale file for ${LOCALE_NAMES[targetCode]}.

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
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
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

async function main() {
  const enPath = path.join(LOCALES_DIR, 'en.json');
  const enRaw = fs.readFileSync(enPath, 'utf8');
  const enJson = JSON.parse(enRaw) as object;

  // CLI filtering. Examples:
  //   npm run translate                    -> all locales without an existing JSON
  //   npm run translate -- pt it nl        -> just those three (overwrites existing)
  //   npm run translate -- --all           -> all non-English locales (overwrites)
  //   npm run translate -- --missing       -> same as no-args (only missing ones)
  // The default (no args) is **idempotent** — only translates locales whose
  // `<code>.json` file is absent, so re-running after a partial failure picks up
  // where it left off without re-billing locales that already have output.
  const args = process.argv.slice(2);
  const allFlag = args.includes('--all');
  const missingFlag = args.includes('--missing');
  const explicitCodes = args.filter((a) => !a.startsWith('--')) as LocaleCode[];

  let targets: LocaleCode[];
  if (explicitCodes.length > 0) {
    // User-supplied codes — validate against SUPPORTED_LOCALES.
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
    // Default + --missing: only locales without an existing JSON. This is what
    // you want after adding new placeholder codes to SUPPORTED_LOCALES — it
    // fills in the gaps without retranslating the 10 you already have.
    targets = SUPPORTED_LOCALES.filter((c) => {
      if (c === 'en') return false;
      const p = path.join(LOCALES_DIR, `${c}.json`);
      return !fs.existsSync(p);
    });
    if (missingFlag && targets.length === 0) {
      console.log('No missing locale bundles — every supported code already has a JSON.');
      return;
    }
  }

  if (targets.length === 0) {
    console.log('No locales to translate. Pass `--all` to retranslate everything,');
    console.log('or list explicit codes (e.g. `npm run translate -- pt it nl`).');
    return;
  }

  console.log(`Translating ${targets.length} locale(s): ${targets.join(', ')}`);
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
