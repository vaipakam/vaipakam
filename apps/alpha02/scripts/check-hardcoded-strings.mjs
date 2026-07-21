#!/usr/bin/env node
/**
 * Guardrail (Issue #1329, AST rewrite #1365): fail if a user-visible UI
 * string is hardcoded in a component instead of routed through the
 * `copy.*` catalog (src/content/copy.ts) — the single source every
 * locale translates from. Without this, the display-language switch
 * silently leaves patches of English behind as new components land.
 *
 * WHY AN AST (not a regex). The original line-based regex scanner
 * (retired here) was hardened five times across #1345 and still had a
 * structural blind spot: a real prose word sitting next to an
 * interpolation — `expires ${date}`, `${collateral} collateral
 * (borrower's)`, `Offer #{id} · waiting for the other side to accept`.
 * These render through JSX with values spliced mid-sentence, so there
 * is no clean `>text<` and no quoted literal; a per-line regex cannot
 * blank `${...}` boundaries precisely (`[^}]*` breaks on nested braces)
 * nor tell a rendered word from a code token (`readContract()` vs.
 * `recognised (symbol)`). #1388 shipped 12 such strings the regex
 * passed clean. The fix (#1365) is to parse the TSX and inspect the
 * EXACT rendered positions the AST exposes:
 *
 *   1. JSX text children (`<span>Some words {x}</span>`),
 *   2. literals used as JSX children (`{cond ? `… {a} …` : '…'}`),
 *   3. literals in a small set of user-visible JSX attributes
 *      (title / aria-label / placeholder / alt / …).
 *
 * Node context makes "is this rendered?" unambiguous, so the detector
 * can flag even a SINGLE prose word without the false positives that
 * blocked the regex — a template literal assigned to `className` or a
 * route is simply never in a scanned position.
 *
 * A finding is NOT a bug when the literal is deliberately English —
 * a glossary/brand token (VPFI, NFT, Vaipakam), or a string that is
 * consciously deferred. Glossary tokens live in GLOSSARY; the rest go
 * in ALLOWLIST (keyed by the exact trimmed prose), each with the reason
 * clear from its grouping. Add there rather than loosening the detector.
 *
 * Exit 1 on any un-allowlisted hit. Wired into the alpha02 typecheck
 * lane so a PR that reintroduces a bypass fails CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * JSX attributes whose value is shown to the user (tooltip, a11y label,
 * input hint, image fallback). Only these attributes are scanned for
 * hardcoded prose; everything else (className, href, id, key, to,
 * role, data-*, style, type, name, …) is code, never rendered text.
 */
const UI_ATTRS = new Set([
  'title',
  'aria-label',
  'ariaLabel',
  'aria-description',
  'aria-placeholder',
  'aria-valuetext',
  'aria-roledescription',
  'placeholder',
  'alt',
  'label',
  'caption',
]);

/**
 * Tokens that are legitimately English in every locale — protocol
 * acronyms, units, ticker/standard names, the brand. A static run made
 * up only of these (plus punctuation / numbers) is not prose. Compared
 * case-insensitively.
 */
const GLOSSARY = new Set(
  [
    'VPFI', 'HF', 'LTV', 'APR', 'APY', 'bps', 'NFT', 'NFTs', 'KYC', 'LIF',
    'AON', 'GTT', 'IOC', 'FOK', 'DEX', 'AMM', 'RPC', 'ID', 'URL', 'ERC',
    'ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'BTC', 'mUSDC', 'mWETH',
    'tLIQ', 'tILQ', 'vRENT', 'vART', 'Vaipakam', 'id',
  ].map((s) => s.toLowerCase()),
);

/**
 * BASELINE — pre-existing violations frozen at the moment this AST
 * detector landed (#1365), keyed by FILE so freezing e.g. "Close" in
 * one desk panel does NOT punch a global hole for "Close" everywhere.
 * A new file, or a new string in a listed file, is still flagged — the
 * detector ratchets: existing debt is grandfathered, new debt is
 * blocked. Burn-down (extract → catalog → translate) is tracked in
 * #1393; entries leave this map as they are extracted.
 *
 * Developer diagnostics / thrown tx-hash errors are baselined too — they
 * are not catalog copy, but they live in the same rendered positions.
 */
const BASELINE = {
  // Release-stage badge — a fixed marker, not localized.
  'src/components/AppShell.tsx': ['alpha'],
  'src/components/AssetPicker.tsx': ['contract address'],
  // --- Advanced Rate-Desk surface: its own i18n pass (status-enum
  //     vocabulary must be localized first). Grandfathered here.
  'src/components/desk/DeskHeader.tsx': ['bps · loan #'],
  'src/components/desk/HistoryPanel.tsx': ['Loan #'],
  'src/components/desk/MatchBand.tsx': ['bps · offers # × #'],
  'src/components/desk/OpenOrdersPanel.tsx': ['Reading the offer’s live values…', 'Close'],
  'src/components/desk/PositionsPanel.tsx': ['Loan #', 'd left', 'd overdue', '· partial repay OK'],
  'src/components/desk/RateLadder.tsx': ['bps quoted mid', 'mid'],
  'src/components/desk/SignedFillConfirm.tsx': ['Close'],
  'src/components/desk/TapePanel.tsx': ['bps · loan # ·', 'Loading recent fills…'],
  // --- Basic/common surfaces with pre-existing hardcoded prose.
  'src/components/OfferFlow.tsx': [
    'yearly',
    '· offer #',
    'You’re',
    'accepting lending offer',
    'funding borrow request',
  ],
  'src/components/StepNav.tsx': ['Step'],
  'src/pages/Rent.tsx': ['? Switch'],
  'src/pages/Vpfi.tsx': [
    'Your balance qualifies for',
    'off',
    'a higher tier',
    '(currently )',
    ', but discounts use your 30-day average — keep the balance and your active discount catches up.',
  ],
  // Developer diagnostics / thrown errors (never rendered as UI copy).
  'src/components/ErrorBoundary.tsx': [
    'A component threw during render',
    'React error # — see https://react.dev/errors/',
    'Component stack:',
  ],
  'src/pages/Faucet.tsx': ['Transaction reverted ()'],
};

/** Collapse interpolations + whitespace to inspect only the STATIC text
 *  a template/JSX node contributes to the DOM. */
function staticText(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Is this static run real prose (≥1 non-glossary alphabetic word)?
 *  Runs made only of glossary tokens, punctuation, separators, numbers,
 *  or short filler are not. */
function isProse(text) {
  const s = staticText(text);
  if (!s) return false;
  const words = s.match(/[A-Za-z][A-Za-z'’]*/g) || [];
  const meaningful = words.filter((w) => {
    const bare = w.replace(/['’]/g, '');
    if (bare.length < 3) return false;
    return !GLOSSARY.has(bare.toLowerCase());
  });
  return meaningful.length >= 1;
}

/** Static contribution(s) of an expression used in a rendered position,
 *  as an ARRAY of independent fragments — a string literal, a template
 *  literal (head + each span's literal, joined: one DOM run), or the
 *  branches of a conditional / `&&` / `||` / `??` / `+` / paren, each
 *  returned separately so one prose branch is enough to flag while the
 *  others stay isolated. Interpolations are dropped (replaced by a
 *  space) — the AST gives exact `${}` boundaries, no regex blanking. */
function renderedStatic(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += ' ' + span.literal.text;
    return [out];
  }
  if (ts.isParenthesizedExpression(node)) return renderedStatic(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...renderedStatic(node.whenTrue), ...renderedStatic(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const k = node.operatorToken.kind;
    if (
      k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken ||
      k === ts.SyntaxKind.PlusToken
    ) {
      return [...renderedStatic(node.left), ...renderedStatic(node.right)];
    }
  }
  return [];
}

/**
 * Analyze one source's rendered positions and return EVERY prose finding
 * (glossary-filtered, but NOT baseline-filtered). Pure and side-effect
 * free — the CLI applies the BASELINE ratchet on top; the unit test
 * calls this directly on fixtures. `rel` is only used to label findings.
 */
export function analyzeSource(rel, src) {
  const findings = [];
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const report = (node, raw) => {
    const s = staticText(raw);
    if (!s || !isProse(s)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ rel, line: line + 1, s });
  };
  const reportExpr = (node, expr) => {
    for (const part of renderedStatic(expr)) report(node, part);
  };

  const visit = (node) => {
    // 1. JSX text children.
    if (ts.isJsxText(node)) {
      if (node.text.trim()) report(node, node.text);
    }
    // 2. Literal expressions used directly as a JSX child.
    else if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent;
      if (parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) {
        reportExpr(node, node.expression);
      }
    }
    // 3. User-visible JSX attributes.
    else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (UI_ATTRS.has(name)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) report(node, init.text);
        else if (ts.isJsxExpression(init) && init.expression) {
          reportExpr(node, init.expression);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Apply the file-scoped BASELINE ratchet to a raw finding. */
function isBaselined(rel, s) {
  const key = rel.split('\\').join('/');
  return (BASELINE[key] || []).includes(s);
}

/** CLI entry — scan the whole src tree and exit non-zero on any
 *  un-baselined finding. Guarded so importing this module (the unit
 *  test) does not run the scan. */
function runCli() {
  const findings = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const f of analyzeSource(rel, readFileSync(file, 'utf8'))) {
      if (!isBaselined(f.rel, f.s)) findings.push(f);
    }
  }
  return findings;
}

// CLI entry — run the scan only when executed directly (`node
// scripts/check-hardcoded-strings.mjs`), NOT when imported by the unit
// test, which calls analyzeSource() on fixtures instead.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const findings = runCli();
  if (findings.length > 0) {
    findings.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
    console.error(
      `[check-hardcoded-strings] ${findings.length} user-visible string(s) bypass the copy catalog:\n`,
    );
    for (const { rel, line, s } of findings) {
      console.error(`  ${rel}:${line}: ${JSON.stringify(s)}`);
    }
    console.error(
      '\nRoute each through copy.* in src/content/copy.ts (then run `pnpm i18n:template`),',
    );
    console.error(
      'or if it is deliberately English (glossary token, baselined, dev diagnostic),',
    );
    console.error('add it to GLOSSARY / BASELINE in this script with the reason clear.');
    process.exit(1);
  }
  console.log('[check-hardcoded-strings] OK — no un-catalogued user-visible strings.');
}
