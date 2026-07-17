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
import { LOCALES, ROUTES, EN_ONLY_ROUTES, localizedPath } from './seo-routes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const CONCURRENCY = 4;

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

/**
 * Launch Chromium with graceful fallbacks so the deploy pipeline
 * never dies on a browserless runner (Codex #1309 r3), in order:
 *   1. Playwright's own managed browser (exact-revision match).
 *   2. `PRERENDER_CHROMIUM` env — explicit executable override.
 *   3. Any chromium under PLAYWRIGHT_BROWSERS_PATH (revision-mismatch
 *      tolerant — fine for a static snapshot pass, which exercises no
 *      bleeding-edge browser APIs).
 *   4. Self-heal: `npx playwright install chromium` (the same step
 *      the alpha02 e2e workflow runs), then retry (1). One-shot —
 *      a runner without network/deps still fails loudly after this.
 */
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (err) {
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
      try {
        console.warn(`[prerender] falling back to ${executablePath}`);
        return await chromium.launch({ executablePath });
      } catch {
        /* try the next candidate */
      }
    }
    // Last resort: fetch Playwright's managed Chromium, then retry.
    try {
      console.warn(
        '[prerender] no usable Chromium found — running `npx playwright install chromium`…',
      );
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      return await chromium.launch();
    } catch {
      throw err;
    }
  }
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
    // The app is mounted once #root has children; give the SEO hooks'
    // effects one more tick to settle head tags.
    await page.waitForFunction(
      () => document.getElementById('root')?.children.length > 0,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(100);

    let html = await page.evaluate(() => {
      // Un-pin the prerender machine's theme; the inline bootstrap
      // re-derives it per visitor before first paint.
      document.documentElement.removeAttribute('data-theme');
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
    writeFileSync(join(outDir, 'index.html'), html);
    return { urlPath, ok: true };
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
// English-only routes (no localized content — see seo-routes.mjs):
// snapshot the root URL only, matching the sitemap's advertisement.
for (const route of EN_ONLY_ROUTES) {
  jobs.push({ route, locale: 'en' });
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
  ...EN_ONLY_ROUTES,
];
let headersBody = existsSync(HEADERS_PATH)
  ? readFileSync(HEADERS_PATH, 'utf8')
  : '';
const markerIdx = headersBody.indexOf(MARKER);
if (markerIdx !== -1) headersBody = headersBody.slice(0, markerIdx);
const generated = [MARKER, ...rulePaths.map((p) => `${p}\n${CACHE_LINE}`)].join(
  '\n\n',
);
writeFileSync(HEADERS_PATH, `${headersBody.trimEnd()}\n\n${generated}\n`);
console.log(
  `[prerender] ${rulePaths.length} snapshot cache rules appended → dist/_headers`,
);
