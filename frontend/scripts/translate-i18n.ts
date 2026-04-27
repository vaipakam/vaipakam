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

  // Skip 'en' (we are translating FROM it). Translate every other
  // supported locale.
  const targets: LocaleCode[] = SUPPORTED_LOCALES.filter((c) => c !== 'en');

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
