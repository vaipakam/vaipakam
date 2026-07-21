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
 *      including words inside the interpolation branches themselves
 *      (`{`${n === 1 ? 'day' : 'days'}`}`) and through TS-only wrappers
 *      (`{'Loading' as const}`, `{('x')!}`, `satisfies`),
 *   3. literals in a small set of user-visible JSX attributes
 *      (title / aria-label / placeholder / alt / heading / text / …),
 *      including attributes supplied via a spread of an object literal,
 *   4. literals on user-visible OBJECT-LITERAL keys (`label` / `text` /
 *      `tooltip` / …) — the shape components consume as row/option copy
 *      (`options={[{ label: 'Newest first' }]}`).
 *
 * Node context makes "is this rendered?" unambiguous, so the detector
 * can flag even a SINGLE prose word without the false positives that
 * blocked the regex — a template literal assigned to `className` or a
 * route is simply never in a scanned position.
 *
 * A finding is NOT a bug when the literal is deliberately English —
 * a glossary/brand token (VPFI, NFT, Vaipakam), or a string that is
 * consciously deferred. Glossary tokens live in GLOSSARY; the rest go
 * in BASELINE (below). Add there rather than loosening the detector.
 *
 * Exit 1 on any un-baselined hit. Wired into the alpha02 typecheck
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
 * input hint, image fallback, custom-component copy props). Only these
 * are scanned; everything else (className, href, id, key, to, role,
 * data-*, style, type, name, …) is code, never rendered text.
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
  'heading',
  'text',
  'tooltip',
  // Custom copy-bearing component props in this app's design system:
  // EmptyState/UnavailableState `body`, AssetPicker `hint`,
  // ConfirmReceipt `confirmLabel`, SelectMenu option `sub`/`controlLabel`.
  'body',
  'hint',
  'confirmLabel',
  'sub',
  'controlLabel',
  'subtitle',
  // React's `children` passed as an explicit prop is the same rendered
  // text as `<Tag>…</Tag>` — `<Button children="Click me" />`.
  'children',
  // FaucetRow row body + button copy props.
  'blurb',
  'actionLabel',
  // StepNav renders each element of `steps={[...]}` as a visible label.
  'steps',
]);

/**
 * Object-literal property keys that carry user-visible copy when the
 * object is consumed by a component (`options={[{ label, text }]}`,
 * `{ badge: { text } }`, a spread attribute `{...{ placeholder }}`).
 * Same intent as UI_ATTRS but for the object-shape path.
 */
const UI_KEYS = new Set([
  'label',
  'title',
  'text',
  'tooltip',
  'heading',
  'placeholder',
  'caption',
  'alt',
  'subtitle',
  'message',
  'ariaLabel',
  'aria-label',
  // Custom option/config copy fields (SelectMenu options, receipt props).
  'sub',
  'controlLabel',
  'body',
  'hint',
  'confirmLabel',
  // Typed copy-container fields rendered from objects: Home job `blurb`,
  // OfferFlow `SideCopy` amountLabel/doneBody, FaucetRow actionLabel,
  // desk OrderTicket securityLegs `leg` (interpolated into the security
  // banner via text.securityBlocked/Unknown(l.leg)).
  'blurb',
  'amountLabel',
  'doneBody',
  'actionLabel',
  'leg',
  // OfferFlow SideCopy fields with no camelCase copy-suffix, listed
  // explicitly (the rest of the family — rateLabel, submitLabel, doneTitle,
  // amountHint, acceptDoneBody, … — is covered by the suffix rule below):
  // the empty-state line, the page/match ledes, and the "or post" divider,
  // all rendered directly as text.lede / text.matchLede / text.orPost.
  'matchEmpty',
  'lede',
  'matchLede',
  'orPost',
  // ReviewReceipt `data` fields — rendered into <dd> rows on the
  // pre-sign trust surface (ReviewReceipt.tsx).
  'youReceive',
  'youLock',
  'youMayOwe',
  'youCanLose',
  'fees',
  'whenThisEnds',
]);

/**
 * CamelCase suffixes that mark a prop / object key as user-visible copy
 * regardless of its prefix — `rateLabel`, `submitLabel`, `takeLabel`,
 * `doneTitle`, `amountHint`, `acceptDoneBody`, `helpText`, … This
 * generalizes the app's typed copy-container fields (OfferFlow SideCopy,
 * etc.) so the guardrail doesn't need every field enumerated. Matched
 * capitalized so lowercase words like `context` (ends in `text`, not
 * `Text`) are NOT swept in.
 */
const UI_NAME_SUFFIXES = [
  'Label',
  'Title',
  'Body',
  'Hint',
  'Text',
  'Blurb',
  'Message',
  'Caption',
  'Tooltip',
  'Heading',
  'Subtitle',
  'Placeholder',
];

/** Is this prop / object-key name a user-visible copy field — either an
 *  exact member of `set` or ending in a camelCase copy suffix? */
function isUiName(name, set) {
  if (set.has(name)) return true;
  return UI_NAME_SUFFIXES.some((suf) => name.length > suf.length && name.endsWith(suf));
}

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
 * detector landed (#1365), keyed by FILE and then by the exact string,
 * with an OCCURRENCE COUNT. Freezing e.g. one `Close` in a desk panel
 * grandfathers exactly that one occurrence: a SECOND rendered `Close`
 * in the same file exceeds the count and is flagged, so the ratchet
 * blocks new violations (new files, new strings, AND new duplicates),
 * not merely new string values. Burn-down (extract → catalog →
 * translate) is tracked in #1393; entries leave this map as they are
 * extracted. Developer diagnostics / thrown tx-hash errors are baselined
 * too — not catalog copy, but they sit in the same rendered positions.
 */
const BASELINE = {
  // --- Basic / common surfaces (extract first — see #1393).
  'src/components/AppShell.tsx': { alpha: 1 }, // release-stage badge, not localized
  'src/components/AssetPicker.tsx': { 'contract address': 1 },
  'src/components/OfferFlow.tsx': {
    at: 1, // connective in the composed offer-row "{amount} at {rate} yearly" (#1360)
    yearly: 1,
    '· offer #': 1,
    'network #': 1,
    // securityLegs leg labels interpolated into the token-security banner (#1360).
    'loan asset': 1,
    collateral: 1,
    'You’re': 1,
    'accepting lending offer': 1,
    'funding borrow request': 1,
  },
  'src/components/StepNav.tsx': { Step: 1, of: 1 }, // "Step {n} of {m}" (#1360)
  'src/pages/Vault.tsx': { on: 1 }, // "on {chain}" composed label (#1360)
  // Hardcoded string args passed INTO a copy.* template (the {{leg}} /
  // fallback-label class, #1360): 'prepayment token' filled into the
  // tokenSecurity gate messages, a 'network #<id>' fallback label, a
  // 'locked' symbol fallback, and an 'unknown' chain-id fallback. These
  // render but bypass the catalog — extract with the #1360 work.
  'src/pages/Rent.tsx': { '? Switch': 1, 'prepayment token': 7, 'network #': 1 },
  'src/pages/PositionDetails.tsx': { locked: 1 },
  'src/components/DiagnosticsDrawer.tsx': { unknown: 1 },
  'src/pages/Vpfi.tsx': {
    'Your balance qualifies for': 1,
    off: 1,
    'a higher tier': 1,
    '(currently )': 1,
    ', but discounts use your 30-day average — keep the balance and your active discount catches up.': 1,
  },
  // --- Advanced Rate-Desk surface: its own i18n pass (status-enum
  //     vocabulary must be localized first). Grandfathered here.
  'src/components/desk/DeskHeader.tsx': { 'bps · loan #': 1 },
  'src/components/desk/HistoryPanel.tsx': { 'Loan #': 1 },
  'src/components/desk/MatchBand.tsx': { 'bps · offers # × #': 1 },
  'src/components/desk/OpenOrdersPanel.tsx': { 'Reading the offer’s live values…': 1, Close: 1 },
  // securityLegs leg labels interpolated into the security banner (#1360).
  'src/components/desk/OrderTicket.tsx': { 'loan asset': 1, collateral: 1 },
  'src/components/desk/PositionsPanel.tsx': {
    'Loan #': 1,
    'd left': 1,
    'd overdue': 1,
    '· partial repay OK': 1,
  },
  'src/components/desk/RateLadder.tsx': { 'bps quoted mid': 1, mid: 1, '· spread': 1 },
  'src/components/desk/SignedFillConfirm.tsx': { Close: 1 },
  'src/components/desk/TapePanel.tsx': { 'Loading recent fills…': 1, 'bps · loan # ·': 1 },
  // --- Developer diagnostic rendered inside the crash UI (not copy).
  'src/components/ErrorBoundary.tsx': { 'Component stack:': 1 },
};

/** Collapse interpolations + whitespace to inspect only the STATIC text
 *  a template/JSX node contributes to the DOM. */
function staticText(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Is this static run real prose (≥1 non-glossary alphabetic word)?
 *  Runs made only of glossary tokens, punctuation, separators, numbers,
 *  or single-letter filler are not. A ≥2-letter non-glossary word counts
 *  as prose so short translatable labels (`No`, `On`, `Go`, `OK`) are
 *  caught; single letters are dropped (they are units / separators /
 *  articles — `d`, `×`, `a` — never standalone copy). */
function isProse(text) {
  const s = staticText(text);
  if (!s) return false;
  const words = s.match(/[A-Za-z][A-Za-z'’]*/g) || [];
  const meaningful = words.filter((w) => {
    const bare = w.replace(/['’]/g, '');
    if (bare.length < 2) return false;
    return !GLOSSARY.has(bare.toLowerCase());
  });
  return meaningful.length >= 1;
}

/** Static contribution(s) of an expression used in a rendered position,
 *  as an ARRAY of independent DOM fragments:
 *   - a string / no-substitution template literal → its text,
 *   - a template literal → its literal spans joined as one run PLUS each
 *     interpolation expression recursed (branch words like
 *     `${n === 1 ? 'day' : 'days'}` render too),
 *   - conditional / `&&` / `||` / `??` / `+` → each side, isolated so one
 *     prose branch is enough to flag,
 *   - paren / `as` / `!` / `satisfies` / `<T>` wrappers → unwrapped.
 *  Anything else (a call, an identifier) contributes no static text. */
/** Leftmost identifier of a (possibly nested) property/element access —
 *  `copy.foo.bar` → 'copy', `x[0].y` → 'x' — or null. */
function accessRoot(expr) {
  let e = expr;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    e = e.expression;
  }
  return ts.isIdentifier(e) ? e.text : null;
}

function renderedStatic(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    const literalRun = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
    const interp = node.templateSpans.flatMap((s) => renderedStatic(s.expression));
    return [literalRun, ...interp];
  }
  // A tagged template in a rendered position (`{String.raw`Switch network`}`,
  // `{dedent`…`}`) renders the tag's string result — recurse into the
  // template portion so its literal/interpolation text is scanned.
  if (ts.isTaggedTemplateExpression(node)) {
    return renderedStatic(node.template);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    (typeof ts.isTypeAssertionExpression === 'function' && ts.isTypeAssertionExpression(node)) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
  ) {
    return renderedStatic(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [...renderedStatic(node.whenTrue), ...renderedStatic(node.whenFalse)];
  }
  // An array literal rendered as a JSX child — React renders each string
  // element (`<>{['Loading offers']}</>`), so recurse into elements.
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((el) => renderedStatic(el));
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

/** Property-name text for an object-literal `PropertyAssignment`
 *  (identifier or string key), or null for computed/other keys. */
function propKey(name, sf) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return null;
  return null;
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

  // SCOPE-AWARE aliasing of a `copy.*` branch — the established desk
  // pattern `const text = copy.desk.ticket` (and `const seo = copy.seo`).
  // A hardcoded arg passed through such an alias (`text.gateUnknown('x')`)
  // is the same user-facing interpolation value as `copy.…('x')`, so the
  // call-arg scan treats these alias roots like `copy` itself. This is a
  // bounded, single-file SYNTACTIC alias map (initializer rooted at
  // `copy`), NOT general data-flow — no symbol table.
  //
  // Resolution is LEXICALLY SCOPED so a shadowing binding wins: a callback
  // param `rows.map(text => text.format('x'))` re-binds `text` to a
  // non-copy value and must NOT be scanned even when a module-level
  // `const text = copy.…` exists. `scopes` is a stack of Map<name,isAlias>;
  // a function-like node pushes a frame carrying its params (isAlias=false,
  // params are never copy), and `const x = copy.…` declarations set
  // isAlias=true in the current frame. `resolveCopyRoot` walks innermost-out
  // and falls back to the literal `copy` identifier.
  const scopes = [new Map()];
  const declareInScope = (name, isAlias) => scopes[scopes.length - 1].set(name, isAlias);
  const resolveCopyRoot = (name) => {
    if (name == null) return false;
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return scopes[i].get(name);
    }
    return name === 'copy';
  };
  const isFnLike = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n);
  // Identifier names bound by a (possibly destructuring) parameter/binding.
  const collectBindingNames = (name, out = []) => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
      }
    }
    return out;
  };

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
    // Declare `const x = …` bindings in the current scope as they are
    // encountered (const is declare-before-use), tagging whether the value
    // is a `copy.*` branch. A later `x.method('…')` then resolves correctly.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declareInScope(node.name.text, !!node.initializer && accessRoot(node.initializer) === 'copy');
    }
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
      if (isUiName(name, UI_ATTRS)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) report(node, init.text);
        else if (ts.isJsxExpression(init) && init.expression) {
          reportExpr(node, init.expression);
        }
      }
    }
    // 4. User-visible object-literal properties (row/option copy, and
    //    spread attributes `{...{ placeholder: '…' }}`, whose object
    //    property is reached here too).
    else if (ts.isPropertyAssignment(node)) {
      const key = propKey(node.name, sf);
      // Check BOTH copy-key sets: an object property carries visible copy
      // whether the object is a data/option record (UI_KEYS) or a spread
      // prop bag `{...{ children: '…', steps: […] }}` (UI_ATTRS names —
      // children / steps / aria-* — reach this node too).
      if (key && (isUiName(key, UI_KEYS) || isUiName(key, UI_ATTRS))) {
        reportExpr(node, node.initializer);
      }
    }
    // 5. ANY `copy.*` call, wherever it sits — a hardcoded string arg
    //    (`copy.tokenSecurity.gateUnknown('prepayment token')`) is a
    //    user-facing interpolation value even when the call is built
    //    before render (thrown then shown in an error banner, assigned
    //    to a variable, etc.). Visiting every node means this catches
    //    the call in or out of a rendered position; only `copy.*`
    //    callees are scanned, so ordinary calls stay untouched.
    else if (ts.isCallExpression(node) && resolveCopyRoot(accessRoot(node.expression))) {
      for (const arg of node.arguments) {
        for (const part of renderedStatic(arg)) report(node, part);
      }
    }
    // A function-like node opens a new lexical scope: its parameters shadow
    // any outer alias of the same name (isAlias=false), so descend with a
    // fresh frame pushed, then pop it.
    if (isFnLike(node)) {
      scopes.push(new Map());
      for (const p of node.parameters) {
        for (const nm of collectBindingNames(p.name)) declareInScope(nm, false);
      }
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
    }
    // A block (`{ … }`, `switch` case block) is its own lexical scope for
    // `const`/`let`, so a block-local `const text = helper` must NOT leak
    // into the enclosing function frame — otherwise a later real
    // `text.gateUnknown('…')` after the block would resolve as non-copy and
    // slip its arg. Push/pop a frame so the shadow is restored at the brace.
    if (ts.isBlock(node) || ts.isCaseBlock(node)) {
      scopes.push(new Map());
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
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

/** Scan the whole src tree. Returns:
 *   - `violations`: findings that EXCEED the baselined occurrence count
 *     for their (file, string) — new files, new strings, extra dupes;
 *   - `stale`: baselined (file, string) entries that now appear FEWER
 *     times than their count (a burn-down extracted an occurrence but
 *     did not lower the count). Failing on stale keeps the ratchet
 *     honest: a leftover allowance would silently permit reintroducing
 *     an already-extracted string. */
function runCli() {
  const violations = [];
  const perFile = new Map();
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const found = analyzeSource(rel, readFileSync(file, 'utf8'));
    const byString = new Map();
    for (const f of found) {
      const arr = byString.get(f.s) || [];
      arr.push(f);
      byString.set(f.s, arr);
    }
    perFile.set(rel, byString);
    const base = BASELINE[rel] || {};
    for (const [s, occs] of byString) {
      const allowed = base[s] || 0;
      if (occs.length > allowed) {
        occs.sort((a, b) => a.line - b.line);
        for (const f of occs.slice(allowed)) violations.push(f);
      }
    }
  }
  const stale = [];
  for (const [rel, entries] of Object.entries(BASELINE)) {
    const byString = perFile.get(rel) || new Map();
    for (const [s, count] of Object.entries(entries)) {
      const actual = (byString.get(s) || []).length;
      if (actual < count) stale.push({ rel, s, count, actual });
    }
  }
  return { violations, stale };
}

// CLI entry — run the scan only when executed directly (`node
// scripts/check-hardcoded-strings.mjs`), NOT when imported by the unit
// test, which calls analyzeSource() on fixtures instead.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { violations, stale } = runCli();
  if (violations.length > 0) {
    violations.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
    console.error(
      `[check-hardcoded-strings] ${violations.length} user-visible string(s) bypass the copy catalog:\n`,
    );
    for (const { rel, line, s } of violations) {
      console.error(`  ${rel}:${line}: ${JSON.stringify(s)}`);
    }
    console.error(
      '\nRoute each through copy.* in src/content/copy.ts (then run `pnpm i18n:template`),',
    );
    console.error(
      'or if it is deliberately English (glossary token, baselined, dev diagnostic),',
    );
    console.error('add it to GLOSSARY / BASELINE in this script with the reason clear.');
  }
  if (stale.length > 0) {
    console.error(
      `\n[check-hardcoded-strings] ${stale.length} stale BASELINE entr(y/ies) — the string now appears fewer times than allowed. Lower the count (or drop the entry) so the ratchet keeps the burn-down locked in:\n`,
    );
    for (const { rel, s, count, actual } of stale) {
      console.error(`  ${rel}: ${JSON.stringify(s)} — baseline ${count}, found ${actual}`);
    }
  }
  if (violations.length > 0 || stale.length > 0) process.exit(1);
  console.log('[check-hardcoded-strings] OK — no un-catalogued user-visible strings.');
}
