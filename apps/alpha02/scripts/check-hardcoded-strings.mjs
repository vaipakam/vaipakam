#!/usr/bin/env node
/**
 * Guardrail (Issue #1329): fail if a user-visible UI string is
 * hardcoded in a component instead of routed through the `copy.*`
 * catalog (src/content/copy.ts) — the single source every locale
 * translates from. Without this, the display-language switch silently
 * leaves patches of English behind as new components land: the exact
 * regression that put 313 strings outside the catalog before the
 * big extraction.
 *
 * What it flags in `src/**.tsx`:
 *   - JSX text nodes with real words (`>Some sentence<`)
 *   - UI string props (title/label/placeholder/aria-label/alt/…="…")
 *   - capitalised sentence string literals inside expressions
 *     (`{cond ? 'Loading…' : 'Failed'}`)
 *
 * A finding is NOT a bug when the literal is deliberately English —
 * event names compared in logic, key codes, the brand name, console
 * text, TS type strings. Those live in ALLOWLIST below, each keyed by
 * the exact literal; add to it (with the reason implicit in the
 * grouping) when a new deliberate literal appears, rather than
 * loosening the detector.
 *
 * Exit 1 on any un-allowlisted hit. Wired into the alpha02 typecheck
 * lane so a PR that reintroduces a bypass fails CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * Literals that are intentionally NOT catalog copy. Keyed by the exact
 * string; a hit matching one of these is skipped. Keep tight — a wrong
 * entry here hides a real untranslated string.
 */
const ALLOWLIST = new Set([
  // On-chain / internal event names matched in logic, never rendered.
  'LoanSaleOfferLinked',
  'OfferCreated',
  // Keyboard event codes.
  'ArrowUp',
  'ArrowDown',
  // Brand name — a proper noun, identical in every locale.
  'Vaipakam',
  // TS type-name string / Promise label, not UI.
  'Promise',
  // Console diagnostics (developer-facing, never shown to users).
  'LiveChainSync: block watch error',
]);

const UI_PROP =
  /(?:title|label|placeholder|aria-label|alt|caption|heading|text|tooltip)\s*=\s*"([^"]{4,})"/g;
const JSX_TEXT = /(?:>)\s*([A-Z][A-Za-z0-9,'’.\-–—%$ ()?!&:/]{5,}?)\s*(?:<)/g;
const EXPR_STR = /[{(,?:]\s*'([A-Z][^']{6,})'/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const findings = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const add = (t) => {
    const s = t.trim();
    if (!ALLOWLIST.has(s)) findings.push({ rel, s });
  };
  let m;
  while ((m = JSX_TEXT.exec(src))) {
    const t = m[1].trim();
    if (/\b(className|import|return)\b/.test(t)) continue;
    if (!/[a-z] [a-z]|[a-z]{3}/.test(t)) continue;
    add(t);
  }
  while ((m = UI_PROP.exec(src))) {
    if (/^[\d\W]+$/.test(m[1])) continue;
    add(m[1]);
  }
  while ((m = EXPR_STR.exec(src))) {
    const t = m[1];
    if (t.includes('/') && !t.includes(' ')) continue;
    add(t);
  }
}

if (findings.length > 0) {
  console.error(
    `[check-hardcoded-strings] ${findings.length} user-visible string(s) bypass the copy catalog:\n`,
  );
  for (const { rel, s } of findings) console.error(`  ${rel}: ${JSON.stringify(s)}`);
  console.error(
    '\nRoute each through copy.* in src/content/copy.ts (then run `pnpm i18n:template`),',
  );
  console.error(
    'or if it is deliberately English (event name, brand, console text), add it to ALLOWLIST',
  );
  console.error('in this script with the reason clear from its grouping.');
  process.exit(1);
}

console.log('[check-hardcoded-strings] OK — no un-catalogued user-visible strings.');
