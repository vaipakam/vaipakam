#!/usr/bin/env node
/**
 * Every namespace the marketing site ships is one it renders (#1767).
 *
 * `src/i18n/locales/*.json` are the site's translation bundles. English is
 * imported eagerly, so every visitor downloads all of `en.json` on first
 * paint, and each translated bundle rides its own lazy chunk. They once
 * carried 54 namespaces that belonged to the connected app — about 70% of
 * the strings — because nothing checked that a namespace was used.
 *
 * The rule, checked here:
 *   1. Every top-level namespace in `en.json` is named by a string literal
 *      somewhere in the site's code: a quote or backtick immediately followed
 *      by `<namespace>.`. That covers `t('nav.x')`, keys held in tables
 *      (`labelKey: 'nav.x'`) and template keys with a literal prefix
 *      (`t(\`faq.entries.${id}.q\`)`).
 *   2. No translated bundle carries a namespace `en.json` does not. English
 *      is the source; a namespace only a translation has is never the one a
 *      reader asked for.
 *   3. The code reaches no key through an implicit prefix
 *      (`useTranslation(..., { keyPrefix })` or `getFixedT`), because rule 1
 *      cannot see a namespace named that way. If one is ever needed, this
 *      check must learn to read it first.
 *
 * Code means `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files under `src/` and
 * `scripts/`. Markdown is not code: the guides carry anchors such as
 * `dashboard.your-vault`, which name a section, not a translation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'src', 'i18n', 'locales');
const CODE = /\.(?:tsx?|jsx?|mjs)$/;
const SELF = fileURLToPath(import.meta.url);

function codeFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && p !== LOCALES) codeFiles(p, out);
    } else if (CODE.test(name) && p !== SELF) {
      out.push(p);
    }
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The namespaces of `bundle` that some code literal names, and those none
 *  does. Exported so a cleanup applies exactly this rule. */
export function namespaceLiveness(bundle, source) {
  const live = [];
  const dead = [];
  for (const ns of Object.keys(bundle)) {
    (new RegExp(`['"\`]${escape(ns)}\\.`).test(source) ? live : dead).push(ns);
  }
  return { live, dead };
}

export function readSiteSource() {
  const files = [...codeFiles(path.join(ROOT, 'src')), ...codeFiles(path.join(ROOT, 'scripts'))];
  return files.map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }));
}

export function readBundles() {
  return Object.fromEntries(
    readdirSync(LOCALES)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(LOCALES, f), 'utf8'))]),
  );
}

function main() {
  const sources = readSiteSource();
  const bundles = readBundles();
  const problems = [];

  for (const { file, text } of sources) {
    if (/\bkeyPrefix\b|\bgetFixedT\b/.test(text)) {
      problems.push(`${file}: reaches keys through keyPrefix/getFixedT, which this check cannot see (rule 3)`);
    }
  }

  const { live, dead } = namespaceLiveness(bundles.en, sources.map((s) => s.text).join('\n'));
  for (const ns of dead) {
    problems.push(`en.json: namespace "${ns}" is named by no code literal; remove it from every bundle (rule 1)`);
  }

  const english = new Set(Object.keys(bundles.en));
  for (const [locale, bundle] of Object.entries(bundles)) {
    for (const ns of Object.keys(bundle)) {
      if (!english.has(ns)) problems.push(`${locale}.json: namespace "${ns}" is not in en.json (rule 2)`);
    }
  }

  if (problems.length > 0) {
    console.error(`✗ locale namespaces (#1767):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `✓ locale namespaces: all ${live.length} namespaces in en.json are used, ` +
      `and ${Object.keys(bundles).length - 1} translated bundles carry none beyond them.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main();
