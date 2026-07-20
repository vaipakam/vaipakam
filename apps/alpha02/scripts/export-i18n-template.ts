/**
 * Regenerate `src/i18n/locales/en.json` — the translators' template —
 * from the English catalog in `src/content/copy.ts`.
 *
 *     pnpm --filter @vaipakam/alpha02 i18n:template
 *
 * en.json is NOT loaded at runtime (copy.ts itself is the English
 * source of truth, reaching i18next as per-key `defaultValue`s). It
 * exists so translators — human or the @vaipakam/i18n translate
 * script — have the exact key structure to mirror in
 * `locales/<code>.json`. A vitest drift check
 * (`src/i18n/enTemplate.test.ts`) fails when copy.ts strings change
 * without re-running this, so the template can't go stale.
 *
 * Function-valued entries (parametrized strings) are skipped — they
 * are not yet translatable; see the note in src/i18n/reactiveCopy.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractErrorCatalog } from '@vaipakam/lib';
import { copySource } from '../src/content/copy.ts';
import { buildTemplate } from '../src/i18n/template.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'i18n',
  'locales',
  'en.json',
);

// `copy.*` comes from copy.ts; `contractError.*` is the shared revert-copy
// catalog owned by @vaipakam/lib (English source), seeded here so translators
// localize it per key — the app's decode path resolves `contractError.<key>`
// at runtime with the lib English as the defaultValue.
const template = {
  copy: buildTemplate(copySource),
  contractError: contractErrorCatalog(),
};
fs.writeFileSync(OUT_PATH, JSON.stringify(template, null, 2) + '\n');
console.log(`[i18n:template] wrote ${OUT_PATH}`);
