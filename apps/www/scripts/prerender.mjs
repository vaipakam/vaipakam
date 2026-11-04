#!/usr/bin/env node
/**
 * Post-build prerenderer — snapshots every marketing route × locale
 * to static HTML so crawlers get REAL page content, not an empty SPA
 * shell.
 *
 * Why this exists: Googlebot executes JS (eventually, via a rendering
 * queue), but most AI crawlers — GPTBot, ClaudeBot, PerplexityBot,
 * CCBot — do NOT. Before this pass, they saw `<div id="root"></div>`
 * plus a meta description; after it, every sitemap URL serves its
 * full rendered HTML (headings, copy, FAQ text, JSON-LD, per-locale
 * title/description/canonical/hreflang — everything the runtime SEO
 * hooks write into <head> gets baked in).
 *
 * How: serves `dist/` on a loopback port with the same SPA fallback
 * the production Worker uses, drives real Chromium (Playwright) over
 * ROUTES × LOCALES from seo-routes.mjs, and writes each snapshot to
 * `dist/<locale>/<route>/index.html` (English at the root, mirroring
 * the URL scheme). Cloudflare Workers Static Assets then serves the
 * snapshot for exact-path hits; React mounts on top and replaces the
 * DOM (`createRoot().render()` — no hydration mismatch concerns, at
 * the cost of a paint-over that's invisible when markup matches).
 *
 * Post-processing per snapshot:
 *   - the `data-theme` attribute set by the boot script is removed —
 *     a snapshot must not pin the prerender machine's theme; the
 *     inline bootstrap re-derives it on every real visit.
 *   - the boot-time `lang`/`dir` attributes stay AS RENDERED for the
 *     locale being snapshotted (that's the point).
 *
 * Wiring: `pnpm run deploy` runs build → prerender → wrangler deploy.
 * Deliberately NOT part of plain `build`: typecheck/CI builds should
 * not require a browser. If prerendering fails, the SPA build in
 * dist/ is still fully deployable — you lose the static snapshots,
 * not the site (the script exits non-zero so a deploy pipeline
 * notices).
 *
 * Route/locale set: seo-routes.mjs (shared with the sitemap
 * generator, so the sitemap and the snapshot set can't drift).
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { provideChromiumSystemLibs } from './chromiumSystemLibs.mjs';
import { policyScriptSources, uncoveredScripts } from '@vaipakam/lib/cspScriptHashes';
import {
  LOCALES,
  ROUTES,
  hasBodyFile,
  indexedLocales,
  localizedPath,
} from './seo-routes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const CONCURRENCY = 4;

/** The apex every page declares (`CANONICAL_ORIGIN` in usePageMeta.ts). */
const CANONICAL_ORIGIN = 'https://vaipakam.com';

/**
 * What a snapshot's head must say about indexing (#1314): the page reads
 * `src/content/bodySources.json` against its own bundled body files, the
 * sitemap reads it against the filesystem, and this compares the two on
 * every page the deploy ships. An indexed copy canonicalises to itself and
 * names every indexed copy (plus `x-default`) when there is more than one;
 * a copy whose body fell back to English canonicalises to English and
 * names none.
 */
function expectedIndexing(route, locale) {
  const indexed = indexedLocales(route);
  const self = indexed.includes(locale);
  return {
    canonical: `${CANONICAL_ORIGIN}${self ? localizedPath(route, locale) : route}`,
    alternates:
      self && indexed.length > 1
        ? [
            ...indexed.map((l) => `${l} ${CANONICAL_ORIGIN}${localizedPath(route, l)}`),
            `x-default ${CANONICAL_ORIGIN}${route}`,
          ].sort()
        : [],
  };
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[prerender] dist/index.html not found — run the build first.');
  process.exit(1);
}

// Keep the ORIGINAL shell for the SPA fallback while we overwrite
// per-route files (the '/' snapshot replaces dist/index.html itself).
const SHELL = readFileSync(join(DIST, 'index.html'), 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Minimal static server over dist/ with SPA fallback — the same
 *  shape the production Worker's `not_found_handling:
 *  single-page-application` provides. Serves the ORIGINAL shell as
 *  the fallback so route snapshots written mid-run can't leak into
 *  other routes' renders. */
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  let file = join(DIST, path);
  if (path.endsWith('/')) file = join(file, 'index.html');
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHELL);
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/** The first line of an error, for the attempt list. */
function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}

/**
 * The managed browser is launched as the full Chromium build in its new
 * headless mode (`channel: 'chromium'`), not as the separate
 * `chromium-headless-shell` binary Playwright picks by default. That way
 * `chromium.executablePath()` names the binary that actually launches, so
 * the install check and the library check below look at the right file.
 * The default would launch the headless shell while `executablePath()`
 * names the full browser, and either can be installed without the other.
 */
const MANAGED = { channel: 'chromium' };

/**
 * Launch Chromium, trying in order:
 *   1. Playwright's own managed browser (exact-revision match).
 *   2. `PRERENDER_CHROMIUM` env — explicit executable override.
 *   3. Any chromium under PLAYWRIGHT_BROWSERS_PATH (revision-mismatch
 *      tolerant — fine for a static snapshot pass, which exercises no
 *      bleeding-edge browser APIs).
 *   4. When the managed browser is not installed:
 *      `npx playwright install --no-shell chromium` (the full browser
 *      only — the headless shell is not what MANAGED launches), then
 *      retry (1).
 *   5. When the managed browser is installed but cannot load its system
 *      libraries — the Workers Builds image (#2903) — fetch them into a
 *      private folder (chromiumSystemLibs.mjs) and retry (1) with them on
 *      LD_LIBRARY_PATH.
 *
 * Every attempt's reason is kept, and a launch that never succeeds fails
 * with all of them. It used to rethrow only the FIRST error, which hid why
 * the last resort failed: on Workers Builds the report read "Executable
 * doesn't exist" for a browser the self-heal had just installed.
 */
async function launchChromium() {
  const attempts = [];
  async function attempt(label, options) {
    try {
      return await chromium.launch(options);
    } catch (err) {
      attempts.push(`${label}: ${firstLine(err)}`);
      return null;
    }
  }

  let browser = await attempt('managed browser', MANAGED);
  if (browser) return browser;

  const candidates = [];
  if (process.env.PRERENDER_CHROMIUM) {
    candidates.push(process.env.PRERENDER_CHROMIUM);
  }
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersDir && existsSync(browsersDir)) {
    for (const entry of readdirSync(browsersDir)) {
      if (/^chromium-\d+$/.test(entry)) {
        candidates.push(join(browsersDir, entry, 'chrome-linux', 'chrome'));
      }
    }
  }
  for (const executablePath of candidates) {
    if (!existsSync(executablePath)) continue;
    console.warn(`[prerender] falling back to ${executablePath}`);
    browser = await attempt(executablePath, { executablePath });
    if (browser) return browser;
  }

  const managed = chromium.executablePath();
  if (!existsSync(managed)) {
    console.warn('[prerender] managed Chromium not installed — running `npx playwright install --no-shell chromium`…');
    try {
      execSync('npx playwright install --no-shell chromium', { stdio: 'inherit' });
      browser = await attempt('managed browser after install', MANAGED);
      if (browser) return browser;
    } catch (err) {
      attempts.push(`npx playwright install --no-shell chromium: ${firstLine(err)}`);
    }
  }

  try {
    const env = provideChromiumSystemLibs(managed);
    if (env) {
      // Set on THIS process, not only as a launch option: before starting
      // a managed browser Playwright may re-check its dependencies with
      // ldd under process.env, and would otherwise report the libraries
      // as still missing. Nothing else this script runs after this point
      // loads them.
      Object.assign(process.env, env);
      browser = await attempt('managed browser with fetched system libraries', MANAGED);
      if (browser) return browser;
    }
  } catch (err) {
    attempts.push(`system libraries: ${firstLine(err)}`);
  }

  throw new Error(
    `[prerender] could not start Chromium. Attempts:\n${attempts.map((a) => `  - ${a}`).join('\n')}`,
  );
}

const browser = await launchChromium();

/** Snapshot one route × locale. */
async function snapshot(context, route, locale) {
  const urlPath = localizedPath(route, locale);
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${PORT}${urlPath}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    // Wait for the page itself to declare its indexing, not for a fixed
    // delay. The shell mounts (#root gains children) before a lazy route
    // has rendered, and usePageMeta writes the canonical and hreflang
    // links in one effect only once the route's component commits. A
    // heavy route — the translated advanced guide — can commit well after
    // the network goes idle on a slow build machine, and the old 100 ms
    // settle snapshotted /zh and /ja/help/advanced with no canonical at
    // all on Workers Builds (#2903). Every route declares a canonical
    // (expectedIndexing), and the shell carries none, so its presence is
    // the signal; a route that never declares one fails here by name.
    await page
      .waitForFunction(
        () => document.querySelector('link[rel="canonical"][data-page-meta="1"]') !== null,
        { timeout: 30_000 },
      )
      .catch(() => {
        throw new Error('the page declared no canonical link within 30 s of loading');
      });
    // The structured-data hooks run in the same commit; one more tick
    // lets every effect of that commit finish.
    await page.waitForTimeout(100);

    const head = await page.evaluate(() => ({
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
      alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')]
        .map((l) => `${l.hreflang} ${l.href}`)
        .sort(),
      // The article body's own language, as the page declares it in its
      // structured data (`inLanguage`, set from the body actually
      // rendered). `null` on a page with no article.
      bodyLanguage:
        [...document.querySelectorAll('script[type="application/ld+json"]')]
          .flatMap((s) => {
            try {
              const d = JSON.parse(s.textContent ?? '');
              return Array.isArray(d['@graph']) ? d['@graph'] : [d];
            } catch {
              return [];
            }
          })
          .find((n) => n && n['@type'] === 'TechArticle')?.inLanguage ?? null,
    }));
    const want = expectedIndexing(route, locale);
    if (
      head.canonical !== want.canonical ||
      JSON.stringify(head.alternates) !== JSON.stringify(want.alternates)
    ) {
      throw new Error(
        `indexing disagrees with seo-routes.mjs: canonical ${head.canonical} ` +
          `(want ${want.canonical}), hreflang [${head.alternates.join(', ')}] ` +
          `(want [${want.alternates.join(', ')}])`,
      );
    }

    // Indexing is decided from file presence; the body is chosen by the
    // page. Check they agree on what was actually rendered, so a body file
    // the page does not serve can never be advertised as a translation
    // (Codex #3036 r1). An indexed copy's article must be in its own
    // language; any other copy's must be English.
    if (hasBodyFile(route) && head.bodyLanguage !== null) {
      const wantLang = indexedLocales(route).includes(locale) ? locale : 'en';
      if (head.bodyLanguage !== wantLang) {
        throw new Error(
          `rendered body language ${head.bodyLanguage} disagrees with indexing ` +
            `(want ${wantLang}): the page does not serve the body seo-routes.mjs indexed`,
        );
      }
    }

    let html = await page.evaluate(() => {
      // Un-pin the prerender machine's theme; the inline bootstrap
      // re-derives it per visitor before first paint.
      document.documentElement.removeAttribute('data-theme');
      // And the BUILD machine's config conclusion. `useProtocolConfig`
      // stamps `data-protocol-config` with what THIS document concluded
      // about the published snapshot; serialized, that bakes the build
      // machine's verdict into every visitor's HTML, where it would
      // outlive a live document whose store never ran — exactly the
      // regression the live drive reads the marker to catch (Codex
      // #1778 r6 P2). Shipped HTML carries no marker; only a store that
      // actually ran in the visitor's document writes one.
      document.documentElement.removeAttribute('data-protocol-config');
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    });

    // Output path mirrors the URL scheme: '/' → index.html at the
    // locale root; '/help/basic' → help/basic/index.html.
    const relDir =
      locale === 'en'
        ? route === '/'
          ? '.'
          : `.${route}`
        : route === '/'
          ? `./${locale}`
          : `./${locale}${route}`;
    const outDir = resolve(DIST, relDir);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, 'index.html');
    writeFileSync(file, html);
    return { urlPath, ok: true, file };
  } catch (err) {
    return { urlPath, ok: false, error: err.message };
  } finally {
    await page.close();
  }
}

const jobs = [];
for (const route of ROUTES) {
  for (const locale of LOCALES) {
    jobs.push({ route, locale });
  }
}

const results = [];
let cursor = 0;
async function worker() {
  // One context per worker — contexts are cheap, and isolation stops
  // localStorage writes (i18next caches the detected language) from
  // bleeding between locales.
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const context = await browser.newContext();
    results.push(await snapshot(context, job.route, job.locale));
    await context.close();
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `[prerender] ${results.length - failed.length}/${jobs.length} pages snapshotted → ${DIST}`,
);
if (failed.length > 0) {
  for (const f of failed) console.error(`  FAILED ${f.urlPath}: ${f.error}`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// The snapshots under the script policy (#43 / ET-017). The build allowed
// the inline scripts of the BUILT index.html by hash; a snapshot is a page
// a browser serialised later, and it ships under that same policy. Each
// inline script a snapshot carries must be one the policy allows, or a
// visitor's browser refuses it — the boot script that sets the theme and
// the reading direction before first paint, today. Refused here, so the
// deploy stops instead of shipping pages whose own policy blocks them. A
// data block (the structured data) never runs, and is not asked for.
const policy = policyScriptSources(readFileSync(join(DIST, '_headers'), 'utf8'));
const blocked = results.flatMap((r) =>
  uncoveredScripts(readFileSync(r.file, 'utf8'), policy).map((body) => ({ urlPath: r.urlPath, body })),
);
if (blocked.length > 0) {
  for (const b of blocked) {
    console.error(
      `  BLOCKED ${b.urlPath}: an inline script the script policy does not allow: ` +
        `${JSON.stringify(b.body.slice(0, 80))}…`,
    );
  }
  process.exit(1);
}
console.log(`[prerender] every snapshot's inline scripts are allowed by the script policy`);

// ---------------------------------------------------------------------
// Cache-Control for the snapshots (Codex #1309 r9). The hand-written
// rules in public/_headers cover only `/` and `/index.html`; without a
// matching rule, every OTHER prerendered HTML entry point ships with no
// Cache-Control at all, so browsers/CDNs apply heuristic caching and a
// direct visitor (or crawler) can be pinned post-deploy to a stale
// snapshot whose content-hashed asset references no longer exist.
// Appended HERE — not hand-written in public/_headers — so the rule set
// derives from the same route registry as the snapshots themselves and
// cannot drift when a route or locale is added. One splat per locale
// covers the whole prefixed tree (nothing but HTML lives under a locale
// prefix; /assets/* keeps its immutable rule untouched); English routes
// get exact rules. Marker-delimited so a re-run replaces its own
// section instead of appending duplicates.
const HEADERS_PATH = join(DIST, '_headers');
const MARKER =
  '# --- generated by prerender.mjs: snapshot revalidation rules ---';
const CACHE_LINE = '  Cache-Control: public, max-age=0, must-revalidate';
const rulePaths = [
  ...LOCALES.filter((l) => l !== 'en').flatMap((l) => [`/${l}`, `/${l}/*`]),
  ...ROUTES.filter((r) => r !== '/'),
];
let headersBody = '';
try {
  headersBody = readFileSync(HEADERS_PATH, 'utf8');
} catch {
  // No _headers in dist (public/ copy absent) — emit the generated
  // section alone. Read-with-catch instead of exists-then-read keeps
  // CodeQL's TOCTOU checker satisfied, though this single-process
  // build script has no concurrent writers.
}
const markerIdx = headersBody.indexOf(MARKER);
if (markerIdx !== -1) headersBody = headersBody.slice(0, markerIdx);
const generated = [MARKER, ...rulePaths.map((p) => `${p}\n${CACHE_LINE}`)].join(
  '\n\n',
);
writeFileSync(HEADERS_PATH, `${headersBody.trimEnd()}\n\n${generated}\n`);
console.log(
  `[prerender] ${rulePaths.length} snapshot cache rules appended → dist/_headers`,
);
