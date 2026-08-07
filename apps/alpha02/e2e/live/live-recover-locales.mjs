// #1560 post-deploy live review — do the nine advertised languages
// actually reach the reader on the deployed build?
//
// This is a different question from the one `check-locale-coverage`
// answers, and neither implies the other:
//
//  - The guard reads the JSON on disk. It proves the KEYS EXIST and
//    that interpolation tokens survived. It cannot prove the deployed
//    app ever SERVES that bundle: locale resources are code-split
//    (`import('./locales/xx.json')`, one Vite chunk each) and fetched at
//    runtime, so a chunk that 404s, a locale dropped from the split, or
//    a detector that never switches all leave the guard perfectly green
//    while the reader sees English. `copy.*` resolves via
//    `i18n.t(key, { defaultValue: englishSource })`, so that fallback
//    renders with nothing logged anywhere.
//  - The fork/Vite tier cannot close the gap either: it serves assets
//    from a dev server with a different chunking story than the
//    deployed Worker.
//
// Two independent layers, because either alone can lie:
//
//  1. RESOURCE — capture the locale CHUNK the deployed page actually
//     fetched and assert it carries the expected values for this
//     revision. Every expected string is read from the repo's own
//     locale JSON, so there is no second copy to drift (Codex #1590 r1)
//     — and the assertion includes the keys THIS change adds, so an
//     older deployment, or a stale cached chunk, fails instead of
//     passing on pre-existing content.
//  2. RENDER — assert the page actually switched: `<html lang>`, the
//     expected text direction, and an `<h1>` equal to that locale's own
//     `copy.recover.title`. Comparing against the EXPECTED heading (not
//     merely "not English") means a loader wired to the wrong bundle, or
//     a redirect to some other localized page that happens to have an
//     `<h1>`, fails rather than passing on "it's non-English".
//
// A locale passes only when BOTH layers pass. The resource layer alone
// would not prove the reader sees it; the render layer alone would not
// distinguish this build from an older one.
//
// Keyless: launched with `keyless: true`, so no wallet is injected and
// no dev-wallet key is read. `/recover` renders its language-bearing
// chrome unconnected, and a drive that needs no key should not hold
// one. It still rides driver.mjs's egress route shim rather than
// duplicating it — a second copy of that shim is how the two start
// diverging.
//
// Usage (from apps/alpha02/e2e/live/):
//   LIVE_CHROMIUM_PATH=/opt/pw-browsers/chromium node live-recover-locales.mjs
//
// SITE_URL overrides the target (defaults to production). Run it
// against the branch preview to check a change BEFORE it is merged —
// the resource layer is revision-specific, so production will correctly
// fail until the change is actually deployed there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SITE } from './driver.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(HERE, '..', '..', 'src', 'i18n', 'locales');

// The nine advertised translations. Deliberately NOT imported from the
// app's own locale registry: this drive checks the DEPLOYED build
// against the set we believe we ship, and reading the build's list
// would make the two agree by construction — a locale silently dropped
// from the split would then be dropped from the check too.
const LOCALES = ['ar', 'de', 'es', 'fr', 'hi', 'ja', 'ko', 'ta', 'zh'];

/** Text direction each locale must render in. */
const EXPECTED_DIR = (code) => (code === 'ar' ? 'rtl' : 'ltr');

/**
 * Does `lang` name this locale, as a well-formed BCP-47 tag?
 *
 * Delegated to `Intl.Locale` rather than a hand-rolled pattern. My
 * regex accepted `de-12` and `de-a1` (both invalid) while REJECTING
 * `de-u-co-phonebk` (valid — a Unicode extension), so it was wrong in
 * both directions: malformed metadata could pass and a legitimate
 * extended tag could fail. The platform already has a standards-aware
 * parser; a second, worse copy of the grammar is not worth owning
 * (Codex #1590 r5).
 */
const langMatches = (lang, code) => {
  try {
    return new Intl.Locale(String(lang)).language.toLowerCase() === code.toLowerCase();
  } catch {
    return false; // not a well-formed tag at all
  }
};

/**
 * The keys asserted against the deployed chunk, by catalog path.
 *
 * `copy.recover.title` is the heading this drive reads off the page, so
 * it ties the two layers together. The `copy.match.riskGate*` pair is
 * what #1560's follow-up ADDED — without them a build predating this
 * change would satisfy every other assertion here.
 */
const ASSERTED_KEYS = [
  'copy.recover.title',
  'copy.match.riskGateCreatorBlocked',
  'copy.match.riskGateTierTooLow',
];

const leafAt = (obj, dotted) =>
  dotted.split('.').reduce((node, k) => (node ?? {})[k], obj);

/** Expected values per locale, read from the repo — the single source. */
const EXPECTED = Object.fromEntries(
  LOCALES.map((code) => {
    const bundle = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'),
    );
    const values = {};
    for (const key of ASSERTED_KEYS) {
      const v = leafAt(bundle, key);
      if (typeof v !== 'string' || v.trim() === '') {
        console.error(
          `\nBLOCKED: ${code}.json has no usable string at ${key} — the drive` +
            ` cannot assert a value it does not have. Fix the bundle (or the` +
            ` key list) before running.`,
        );
        process.exit(2);
      }
      values[key] = v;
    }
    return [code, values];
  }),
);

/**
 * A locale chunk is `var e=JSON.parse(`{…}`)` with literal UTF-8 inside
 * a template literal, so an exact substring is a sound membership test
 * for our values (none contain a backtick, backslash or `${`, which are
 * the only sequences the builder escapes). The bundle marker guards
 * against matching some unrelated chunk whose name merely starts with
 * the same two letters.
 */
const BUNDLE_MARKER = '"app":{"name":"Vaipakam"';
const chunkUrlFor = (code) =>
  new RegExp(`/assets/${code}-[A-Za-z0-9_-]+\\.js(?:\\?|$)`);

async function probe(page, code) {
  const expected = EXPECTED[code];
  const problems = [];

  // ---- layer 1: the resource the deployed page actually fetched
  //
  // Playwright fires `response` when the HEADERS arrive and does NOT
  // await the handler, so reading the body is still in flight when the
  // page has already painted. Collect the read PROMISES and settle them
  // before asserting, or a slow or large chunk reads as "never fetched"
  // and fails a healthy deployment (Codex #1590 r2).
  let chunkBody = null;
  const bodyReads = [];
  const onResponse = (res) => {
    if (!chunkUrlFor(code).test(res.url())) return;
    bodyReads.push(
      res
        .text()
        .then((body) => {
          if (chunkBody === null && body.includes(BUNDLE_MARKER)) {
            chunkBody = body;
          }
        })
        .catch(() => {}),
    );
  };
  page.on('response', onResponse);

  await page.goto(`${SITE}/recover`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // Wait for the REQUESTED locale to settle, not merely for any
  // heading: on a slow chunk fetch the English fallback paints first,
  // and a predicate satisfied by "an h1 exists" would sample that and
  // report a healthy deployment as broken (Codex #1590 r1). Waiting for
  // the expected title means a slow load reads as slow, not as failed.
  await page
    .waitForFunction(
      (want) => {
        // Same rule as `langMatches`, evaluated in the page (which has
        // its own Intl) because this predicate is serialised across.
        let base = null;
        try {
          base = new Intl.Locale(document.documentElement.lang).language.toLowerCase();
        } catch {
          return false;
        }
        return (
          base === want.code &&
          (document.querySelector('h1')?.textContent ?? '').trim() === want.title
        );
      },
      { code, title: expected['copy.recover.title'] },
      { timeout: 30_000 },
    )
    .catch(() => {});

  page.off('response', onResponse);
  await Promise.all(bodyReads);

  if (chunkBody === null) {
    problems.push('locale chunk never fetched (or did not look like a bundle)');
  } else {
    for (const key of ASSERTED_KEYS) {
      if (!chunkBody.includes(expected[key])) {
        problems.push(`deployed chunk is missing the expected ${key}`);
      }
    }
  }

  // ---- layer 2: what actually rendered
  const lang = await page.evaluate(() => document.documentElement.lang || '');
  const dir = await page.evaluate(() => document.documentElement.dir || 'ltr');
  const h1 = (
    (await page.locator('h1').first().textContent().catch(() => '')) ?? ''
  ).trim();

  if (!langMatches(lang, code)) {
    problems.push(`lang="${lang}" (wanted ${code} or ${code}-<subtag>)`);
  }
  if (dir !== EXPECTED_DIR(code)) {
    problems.push(`dir="${dir}" (wanted ${EXPECTED_DIR(code)})`);
  }
  if (h1 !== expected['copy.recover.title']) {
    problems.push(
      h1 === ''
        ? 'h1 empty'
        : `h1="${h1}" (wanted "${expected['copy.recover.title']}")`,
    );
  }

  return { lang, dir, h1, problems };
}

const rows = [];
for (const code of LOCALES) {
  // A fresh profile per locale: the persistent one carries the previous
  // locale's `vaipakam:language` and cached resources, so a run could
  // pass on a stale bundle. `done()` (not `ctx.close()`) is what removes
  // the throwaway profile directory afterwards (Codex #1590 r1).
  // Browser SETUP failure is a missing precondition, not a product
  // regression: Chromium absent, LIVE_CHROMIUM_PATH wrong, no space for
  // a profile. Left uncaught it escapes the per-locale try below and
  // exits 1 — and now that this script is registered in
  // THREE_VERDICT_DRIVERS the batch TRUSTS that code and reports a
  // missing browser as FAIL. Hit exactly this in review with
  // Playwright's "Executable doesn't exist" (Codex #1590 r5).
  let session;
  try {
    session = await launch({
      role: 'public',
      keyless: true,
    // keyless removes the WALLET; readOnly is what stops the route shim
    // forwarding a page-initiated POST/PUT/DELETE to a real backend.
    // They are separate guards and this drive needs both — a locale
    // check pointed at a regressed or hostile SITE_URL must not be able
    // to mutate external state (Codex #1590 r2).
      readOnly: true,
      freshProfile: true,
    });
  } catch (err) {
    console.error(
      `\nBLOCKED: could not start the browser for ${code} — this is a setup` +
        ` precondition, not a product finding.\n  ${String(err).split('\n')[0]}` +
        `\n  → check LIVE_CHROMIUM_PATH, or that Chromium is installed.`,
    );
    process.exit(2);
  }
  const { ctx, page, done, blockedRequests } = session;
  try {
    await ctx.addInitScript((c) => {
      try {
        window.localStorage.setItem('vaipakam:language', c);
      } catch {
        /* storage disabled — the lang assertion below catches it */
      }
    }, code);
    const row = { code, ...(await probe(page, code)) };
    // The read-only guard's own log, asserted rather than trusted: a
    // blocked write means the page TRIED to mutate something during a
    // review that advertises itself as read-only, which is a finding in
    // its own right.
    //
    // Cloudflare's edge injects a `POST /cdn-cgi/rum` beacon into the
    // deployed page, which the guard blocks correctly and which is not
    // an application write. Counting it would have failed every locale
    // on a healthy production run — or worse, failed them
    // nondeterministically depending on whether the beacon fired before
    // this loop sampled the log (Codex #1590 r4). Classified with the
    // SHARED predicate rather than a second copy.
    const { telemetry, violations } = splitBlocked(blockedRequests, [SITE]);
    if (telemetry.length > 0) {
      row.telemetry = telemetry.length;
    }
    for (const b of violations) {
      row.problems.push(`read-only violation: ${b.reason} → ${b.url}`);
    }
    rows.push(row);
  } catch (err) {
    rows.push({
      code,
      lang: '?',
      dir: '?',
      h1: '',
      problems: [`drive error: ${String(err).slice(0, 140)}`],
    });
  } finally {
    await done();
  }
}

let failed = 0;
for (const r of rows) {
  if (r.problems.length > 0) {
    failed++;
    console.log(`FAIL ${r.code}  ${r.problems.join('; ')}`);
  } else {
    const tel = r.telemetry ? `  (${r.telemetry} edge-telemetry request(s) blocked, expected)` : '';
    console.log(`ok   ${r.code}  lang=${r.lang} dir=${r.dir}  h1="${r.h1}"${tel}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(
    `live recover locales: ${failed} of ${rows.length} locale(s) FAILED`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `live recover locales: all ${rows.length} serve and render the expected` +
      ' resource in their own language',
  );
}
