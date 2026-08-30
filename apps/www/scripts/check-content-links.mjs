#!/usr/bin/env node
/**
 * check-content-links.mjs — no relative links in published markdown.
 *
 * Everything under `apps/www/src/content/` is rendered by the SPA at a
 * route like `/protocol-console/docs`. A markdown link written
 * relatively is resolved by the browser against THAT URL, not against
 * the repository — so
 *
 *     [FlashLoanLiquidatorRollout.md](FlashLoanLiquidatorRollout.md)
 *
 * requests `/protocol-console/FlashLoanLiquidatorRollout.md`. There is
 * no such route and no copied asset, so the Worker's
 * `not_found_handling: "single-page-application"` serves index.html
 * with a 200 and the reader gets the app shell where they expected a
 * document.
 *
 * The failure is invisible from both sides, which is why it needs a
 * guard rather than a sweep (#1639). In the repository the link looks
 * correct and resolves correctly. On the site it produces a page rather
 * than a 404, so nobody files a bug — the reader assumes they misread
 * the link.
 *
 * THE CONSTRAINT: the same bytes have to work in the repository and on
 * the published site. Only an absolute URL satisfies both. Hence the
 * rule enforced here:
 *
 *   allowed  — `https://…`, `http://`, `mailto:`, in-page `#anchor`,
 *              and site-absolute `/route` paths
 *   rejected — anything else, i.e. every relative path
 *
 * Site-absolute paths are deliberately NOT resolved against the route
 * table here. Whether a `/…` link points at a real route is a different
 * question with a different failure mode, and it is #1479's.
 *
 * Parsed with `mdast-util-from-markdown` rather than a regex, so a link
 * inside a fenced code block or inline code is not a finding — those
 * are being SHOWN, not followed. `link`, `image` and `definition` nodes
 * are all visited, so a reference-style link is caught at its
 * definition.
 *
 * Run: node apps/www/scripts/check-content-links.mjs
 * Wired into `pnpm --filter @vaipakam/www typecheck`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const CONTENT_ROOT = path.join(APP_ROOT, 'src', 'content');

/**
 * Files whose canonical copy lives elsewhere: editing the file under
 * `src/content/` is the wrong fix, because the mirror check would then
 * fail against the canonical. Keyed by the mirror's repo-relative path.
 */
const CANONICAL_SOURCE = {
  'apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md':
    'docs/ops/AdminConfigurableKnobsAndSwitches.md',
};

/**
 * The frozen Terms sources are PUBLISHED markdown too (#2010 round 2):
 * `TermsPage` renders `src/pages/terms/v<N>.md` at `/terms/v<N>`, so a
 * relative target in one resolves against that route and hands the
 * reader the app shell — the exact failure this guard exists for, and
 * one that must be caught BEFORE a version is published, because a
 * published frozen file is immutable and a relative link inside it
 * could never be fixed. The canonical `docs/Terms/TermsOfService.md`
 * is checked alongside so the fix lands in the source that gets
 * frozen, not in a copy.
 */
const TERMS_FROZEN_ROOT = path.join(APP_ROOT, 'src', 'pages', 'terms');
const TERMS_CANONICAL = path.join(
  REPO_ROOT,
  'docs',
  'Terms',
  'TermsOfService.md',
);

function collectTermsMarkdown() {
  const out = [];
  if (fs.existsSync(TERMS_FROZEN_ROOT)) {
    for (const entry of fs.readdirSync(TERMS_FROZEN_ROOT)) {
      if (/^v\d+\.md$/.test(entry)) out.push(path.join(TERMS_FROZEN_ROOT, entry));
    }
  }
  if (fs.existsSync(TERMS_CANONICAL)) out.push(TERMS_CANONICAL);
  if (out.length === 0) {
    // Same shape as the zero-content guard below: a moved directory
    // must not read as "no findings" forever.
    console.error(
      `check-content-links: found no Terms markdown under ${TERMS_FROZEN_ROOT} or at ${TERMS_CANONICAL}`,
    );
    process.exit(1);
  }
  return out;
}

/** Recursively collect every markdown file under `dir`. */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * True when `url` resolves the same way for a reader on the site as it
 * does for a contributor in the repository.
 */
function isPortable(url) {
  const target = url.trim();
  // An empty target is not a link to anywhere; leave it to the author.
  if (target === '') return true;
  if (target.startsWith('#')) return true; // in-page anchor
  if (target.startsWith('/')) return true; // site-absolute route (#1479's remit)
  return /^[a-z][a-z0-9+.-]*:/i.test(target); // any scheme: https, mailto, …
}

if (!fs.existsSync(CONTENT_ROOT)) {
  console.error(`check-content-links: no content directory at ${CONTENT_ROOT}`);
  process.exit(1);
}

const files = [...collectMarkdown(CONTENT_ROOT), ...collectTermsMarkdown()].sort();
if (files.length === 0) {
  // A silent zero-file pass would let a moved content directory read as
  // "no relative links found" forever.
  console.error(`check-content-links: found no markdown under ${CONTENT_ROOT}`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  const tree = fromMarkdown(source);
  visit(tree, ['link', 'image', 'definition'], (node) => {
    if (typeof node.url !== 'string' || isPortable(node.url)) return;
    findings.push({
      file: rel,
      line: node.position?.start?.line ?? 0,
      url: node.url,
      fixIn: CANONICAL_SOURCE[rel] ?? rel,
    });
  });
}

if (findings.length > 0) {
  console.error(
    `\ncheck-content-links: ${findings.length} relative link(s) in published markdown.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  →  ${f.url}`);
    if (f.fixIn !== f.file) {
      console.error(`      fix in the CANONICAL copy: ${f.fixIn}, then re-run the sync script`);
    }
  }
  console.error(
    `\nThese files are served by the SPA, so a relative target resolves against\n` +
      `the PUBLISHED ROUTE rather than the repository — the reader gets the app\n` +
      `shell with a 200, not the document, and nothing reports it.\n\n` +
      `Replace each with an absolute URL that works from both places, e.g.\n` +
      `  https://github.com/vaipakam/vaipakam/blob/main/docs/ops/<File>.md\n` +
      `An in-page \`#anchor\` or a site-absolute \`/route\` is fine and is not\n` +
      `flagged.\n`,
  );
  process.exit(1);
}

console.log(
  `check-content-links: OK — ${files.length} published markdown file(s), no relative links.`,
);
