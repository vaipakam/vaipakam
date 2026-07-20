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

// Interpolation blind spot (#1345): a backtick template literal whose
// literal (non-`${}`) text is a real prose fragment — the inline-notice
// class that bypassed the quote-based checks above (it renders through
// JSX with values interpolated mid-sentence, so no clean `>text<` and no
// quoted literal). Route these through a `tmpl(...)` catalog entry.
const BACKTICK = /`([^`]*)`/g;
// Interpolation-interspersed JSX children: `<span>You have {n} active
// positions. View them.</span>` — real prose with `{expr}` mid-sentence,
// so it yields no clean `>text<` (JSX_TEXT), no quoted literal, and no
// backtick. This is the ORIGINAL blind spot (the ActivePositionsBanner
// class), so scan the `>…{expr}…<` children too (Codex #1345 r1).
// Tightly bounded to real JSX text — starts with a word, and the run
// carries NO code tokens (`; = < > backtick [ ]`) outside its `{expr}`s
// — so TypeScript generics / comparisons don't false-positive.
// Includes whitespace/newlines so the common MULTILINE JSX text style
// (`<span>\n  You have {n} …\n</span>`) is caught too (Codex #1345 r2).
// The `…` (Unicode ellipsis) is common in loading/pending notices
// (`Checking … on {chain}…`); without it the run can't reach the
// closing tag and the node slips the scan (Codex #1345 r4).
const JSX_TEXT_CHARS = "[A-Za-z0-9 \\t\\r\\n,.'’\"%$#·—–…:&!?()\\-]";
// The run may carry MORE THAN ONE `{expr}` — e.g. the pre-migration
// `You have {n} active {n === 1 ? 'position' : 'positions'}.` shape.
// A single fixed `{expr}` slot can't reach the second one (text chars
// exclude `{`), so model the body as "one-or-more `text…{expr}` groups
// then trailing text" — requiring at least one interpolation, matching
// any count (Codex #1345 r3). Each group must consume a `{…}`, so the
// `+` can't run away on failing input.
const JSX_INTERP = new RegExp(
  `>((?:${JSX_TEXT_CHARS}*\\{[^{}]*\\})+${JSX_TEXT_CHARS}*)<`,
  'g',
);
// Two real (3+ letter) words in a row = prose, not a css class / path.
// NOTE (Codex #1345 r5): a SINGLE prose word adjacent to an interpolation
// (`expires ${d}`, `${x} recognised (...)`, ` · filled ${a} … ${b} left`)
// is real untranslated copy this line-based scan can't catch precisely —
// a ≥6-letter-lowercase-word rule flags ~13 false positives on the tree
// (TS fragments leaking through nested `${...}` blanking, and separator
// soup left by catalog-ref compositions). All CURRENT-tree instances are
// extracted into the catalog; the general single-word detector needs an
// AST/ESLint-rule or i18next `saveMissing` runtime pass — tracked in #1365.
const PROSE_PAIR = /[A-Za-z]{3,} [A-Za-z]{3,}/;
// Attribute/identifier contexts that legitimately hold backtick values
// (class names, routes, keys, styles) — blanked before the prose scan.
const NON_UI_BACKTICK =
  /\b(?:className|class|to|href|key|id|htmlFor|style|role|data-[\w-]+)\s*=\s*\{?\s*`[^`]*`/g;

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
  // Backtick prose scan — strip comments (which describe HTML/JSX and
  // would false-positive) and blank the non-UI attribute backticks
  // (`className={`badge ${x}`}`, route templates) first.
  const scrubbed = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(NON_UI_BACKTICK, (mm) => mm.replace(/`[^`]*`/, '``'));
  // Shared prose filter for the interpolation scans below.
  const flagIfProse = (raw) => {
    const lit = raw.replace(/\s+/g, ' ').trim();
    if (!PROSE_PAIR.test(lit)) return;
    // Developer diagnostics / thrown tx-hash errors — not catalog copy.
    if (/react\.dev|Component stack|component threw|Transaction reverted/.test(lit)) {
      return;
    }
    // A path/selector fragment (has `/` but no sentence spacing).
    if (lit.includes('/') && !/[a-z] [a-z]/.test(lit)) return;
    // An all-lowercase-hyphen token run (css classes that slipped the
    // attribute scrub, e.g. a `cn(`...`)` helper) — not prose.
    if (/^[a-z][a-z-]*( [a-z][a-z-]*)*$/.test(lit)) return;
    add(lit);
  };
  BACKTICK.lastIndex = 0;
  while ((m = BACKTICK.exec(scrubbed))) {
    flagIfProse(m[1].replace(/\$\{[^}]*\}/g, ' '));
  }
  JSX_INTERP.lastIndex = 0;
  while ((m = JSX_INTERP.exec(scrubbed))) {
    flagIfProse(m[1].replace(/\{[^{}]*\}/g, ' '));
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
