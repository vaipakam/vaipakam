/**
 * Live post-deploy review — the Overview's worked example and the help
 * search, on the DEPLOYED marketing site (#1664 items 1 + 2, PR #1751).
 *
 * Why this is live-only rather than a CI spec: the two things it checks
 * are only true once the published protocol-config snapshot has been
 * fetched from the deployed indexer. A preview build, a prebuild guard,
 * or an inspection of the shipped bundle can all pass while the
 * rendered page shows something else — which is the whole reason the
 * live-review definition-of-done exists.
 *
 * What it asserts:
 *
 *   1. Each worked-example money figure renders as a DERIVED live value
 *      — its own `data-live-value` span, named, carrying the number the
 *      contract's integer arithmetic produces rather than a decimal
 *      approximation of it. All four, not a sample.
 *   2. The figures are `published`, not bundled fallbacks. On the
 *      production origin this is REQUIRED: an all-bundled render is what
 *      a failed indexer fetch looks like, and passing on it would let
 *      the drive succeed without ever observing the thing it exists to
 *      observe.
 *   3. A derived figure's provenance defers to its inputs — it may
 *      claim `published` only when every knob it was computed from did.
 *   4. The help search finds a page by a figure PRINTED on that page,
 *      with the index built BEFORE the snapshot settles (see below).
 *
 * Usage:
 *
 *   node apps/www/e2e/live/live-worked-example.mjs
 *   WWW_ORIGIN=https://preview.example.com REQUIRE_PUBLISHED=0 \
 *     node apps/www/e2e/live/live-worked-example.mjs
 *
 * Exits non-zero if any check fails, so it can gate a release step.
 *
 * KNOWN ENVIRONMENT LIMITATION (#1777): this cannot run from a Claude
 * Code remote container. Chromium gets `ERR_CONNECTION_RESET` on every
 * navigation through the agent proxy while `curl` to the same URL
 * through the same proxy returns 200. Run it from an operator machine.
 */
import { chromium } from 'playwright';

/**
 * Normalise before deciding anything from the origin. A string compare
 * classified `https://vaipakam.com/` (trailing slash) and the canonical
 * redirect host `https://www.vaipakam.com` as non-production, which
 * turned the production-only provenance requirement off for the same
 * deployed surface purely on URL spelling (Codex #1778 r3 P2).
 */
const RAW_ORIGIN = process.env.WWW_ORIGIN ?? 'https://vaipakam.com';
const PARSED_ORIGIN = new URL(RAW_ORIGIN);
/** No trailing slash — route paths are appended directly. */
const BASE = PARSED_ORIGIN.origin;
const IS_PRODUCTION = PARSED_ORIGIN.hostname.replace(/^www\./, '') === 'vaipakam.com';
/** Default: demand a live snapshot on production, allow bundled elsewhere. */
const REQUIRE_PUBLISHED = process.env.REQUIRE_PUBLISHED
  ? process.env.REQUIRE_PUBLISHED !== '0'
  : IS_PRODUCTION;

/** The derived figures the Overview's worked example prints. */
const DERIVED = [
  'exampleBorrowerReceives',
  'exampleLenderNet',
  'exampleTreasuryYieldFee',
  'exampleTreasuryYieldFeeExact',
];

/** The knobs those figures are computed from. */
const INPUT_KNOBS = ['treasuryFeeBps', 'loanInitiationFeeBps'];

/**
 * The knob values the shipped defaults render as, in the EN document
 * locale — `formatKnob`'s `percent` case emits the bare number
 * (`Intl.NumberFormat(...).format(value / 100)`), and the `%` beside it
 * on the page is markdown, NOT part of the span. Comparing against
 * `'2%'` here silently skipped every value assertion in the first draft
 * of this file (Codex #1778 r1 P2).
 */
const DEFAULT_KNOB_TEXT = { treasuryFeeBps: '2', loanInitiationFeeBps: '0.2' };

/**
 * What each derived figure renders as at those defaults, for the
 * documented example of 1,000 USDC at 8% for 30 days.
 *
 * These mirror the contract's integer arithmetic, which floors at each
 * division — `LibEntitlement.proRataInterest` then `splitTreasury`:
 *
 *   (1000e6 * 800 * 30) / (365 * 10000) = 6,575,342   (floors)
 *   (6,575,342 * 200)   / 10000         =   131,506   (floors)
 *
 * A decimal computation gives 0.131507, one micro-USDC high, on a page
 * that calls the figure exact and says settlement uses it. All four are
 * pinned: checking only some lets a formula or format regression in the
 * others pass while the drive claims to cover every money figure.
 */
const EXPECTED_AT_DEFAULTS = {
  exampleBorrowerReceives: '998.00',
  exampleLenderNet: '1,006.44',
  exampleTreasuryYieldFee: '0.13',
  exampleTreasuryYieldFeeExact: '0.131506',
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
/**
 * A check that could not be run, recorded in the tally rather than only
 * printed. An untracked skip lets a partial run end with "7/7 checks
 * passed" (Codex #1778 r1 P2).
 */
const skip = (name, why) => {
  results.push({ name, skipped: true });
  console.log(`SKIP  ${name} — ${why}`);
};

const browser = await chromium.launch();
// Pin the locale. Every expectation here — the figure strings, the knob
// text, the no-results regex — is English. On an operator machine set to
// a supported non-English locale the site renders `0,2` and a localised
// no-results message, which would skip all four arithmetic checks as an
// apparent retune AND let a broken search pass, because the localised
// message does not match the English regex (Codex #1778 r3 P2).
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
});

/**
 * Did THIS document receive a config snapshot the page would ACCEPT?
 *
 * The provenance assertion below reads the Overview document's spans, but
 * the search page is a SEPARATE document with its own fetch. If that one
 * fails while the live rates equal the bundled defaults, its fallback
 * index still contains the figure and the search check passes without a
 * published snapshot ever arriving — no rebuild, nothing exercised
 * (Codex #1778 r3 P2). So the fetch is observed directly per document.
 *
 * Observed with the PAGE'S OWN acceptance conditions, not HTTP status.
 * `GET /config/:chainId` deliberately answers 200 with
 * `{ available: false }` when it has no row, and `useProtocolConfig`
 * additionally refuses stale and undecodable payloads — so a
 * status-only probe marks "published" exactly when the page falls back
 * to bundled defaults (Codex #1778 r4 P2). Mirrored here:
 * `available === true`, `updatedAt` within the same 24 h window with
 * the same 5-minute clock-skew refusal of future-dated rows, and the
 * bundle passing `decodeMarketingConfig`'s first gate (array, ≥9
 * entries). The full field-level decode is deliberately NOT duplicated
 * — that would be a drifting second copy of the store's logic; a
 * subtly undecodable bundle is instead caught by the Overview's span
 * provenance, which reads what the page itself concluded.
 */
const FRESH_WINDOW_SECONDS = 24 * 3600;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60;
let configOk = false;
const pendingConfigReads = [];
page.on('response', (res) => {
  const u = new URL(res.url());
  if (!/\/config\/\d+$/.test(u.pathname)) return;
  pendingConfigReads.push(
    (async () => {
      if (res.status() !== 200) return;
      let body;
      try {
        body = await res.json();
      } catch {
        return; // undecodable — the page rejects it, so must we
      }
      if (body?.available !== true) return;
      const age = Date.now() / 1000 - body.updatedAt;
      if (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt)) return;
      if (age < -CLOCK_SKEW_TOLERANCE_SECONDS || age > FRESH_WINDOW_SECONDS) return;
      if (!Array.isArray(body.bundle) || body.bundle.length < 9) return;
      configOk = true;
    })(),
  );
});
const gotoFresh = async (url) => {
  configOk = false;
  pendingConfigReads.length = 0;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  // The snapshot is fetched after first paint; give it room so a slow
  // fetch reads as slow rather than as "not live" — then settle the
  // async payload inspections before anything reads `configOk`.
  await page.waitForTimeout(3_000);
  await Promise.all(pendingConfigReads);
};

console.log(`Target: ${BASE}  (published snapshot ${REQUIRE_PUBLISHED ? 'REQUIRED' : 'optional'})\n`);

try {
  // ── 1. Overview: the derived figures render, with honest provenance ──
  await gotoFresh(`${BASE}/help/overview`);

  const spans = await page.$$eval('[data-live-value]', (els) =>
    els.map((e) => ({
      name: e.getAttribute('data-live-value'),
      source: e.getAttribute('data-live-value-source'),
      text: e.textContent.trim(),
    })),
  );

  record('overview renders live-value spans', spans.length > 0, `${spans.length} span(s)`);

  for (const name of DERIVED) {
    const hit = spans.find((s) => s.name === name);
    record(
      `derived figure rendered: ${name}`,
      Boolean(hit),
      hit ? `${hit.text} (${hit.source})` : 'absent',
    );
  }

  const knobSpans = spans.filter((s) => INPUT_KNOBS.includes(s.name));
  // EVERY declared input must be present and published — not "at least one
  // and all of those found". Renaming or dropping one knob span would
  // otherwise leave `knobsLive` true on the survivors, pass the published
  // and provenance checks, and turn all four arithmetic assertions into
  // skips, so the drive would exit 0 having never observed that input at
  // all (Codex #1778 r2 P2).
  const knobsLive = INPUT_KNOBS.every((name) =>
    knobSpans.some((s) => s.name === name && s.source === 'published'),
  );
  const missingKnobs = INPUT_KNOBS.filter((name) => !knobSpans.some((s) => s.name === name));

  // An all-bundled render is indistinguishable from a healthy one by
  // value alone, because the bundled defaults ARE the current on-chain
  // values. On production that is a failed indexer fetch, and letting it
  // pass would mean the drive never observes the published snapshot it
  // exists to check (Codex #1778 r1 P2).
  //
  // A missing knob is its own failure, reported separately from an
  // unpublished one, so the output says which of the two went wrong.
  record(
    'every declared input knob is present',
    missingKnobs.length === 0,
    missingKnobs.length ? `missing: ${missingKnobs.join(', ')}` : INPUT_KNOBS.join(', '),
  );

  if (REQUIRE_PUBLISHED) {
    record(
      'every input knob came from the published snapshot',
      knobsLive,
      knobSpans.map((s) => `${s.name}=${s.source}`).join(', ') || 'no knob spans',
    );
  } else {
    skip(
      'every input knob came from the published snapshot',
      'REQUIRE_PUBLISHED is off for this target',
    );
  }

  // Provenance defers to the least certain input: a derived figure may
  // claim `published` only when every knob it depends on did.
  const derivedSpans = spans.filter((s) => DERIVED.includes(s.name));
  const expectedSource = knobsLive ? 'published' : 'bundled';
  record(
    'derived provenance defers to its inputs',
    derivedSpans.length > 0 && derivedSpans.every((s) => s.source === expectedSource),
    `knobs ${knobSpans.map((s) => s.source).join('/') || 'none'} → derived ` +
      `${[...new Set(derivedSpans.map((s) => s.source))].join('/') || 'none'} (expected ${expectedSource})`,
  );

  // Values, but only while the live rates still match the shipped
  // defaults — otherwise a legitimate governance retune would read as a
  // regression. The skips are tallied, so a retuned run cannot look like
  // a complete pass.
  const atDefaults = INPUT_KNOBS.every((k) =>
    knobSpans.some((s) => s.name === k && s.text === DEFAULT_KNOB_TEXT[k]),
  );
  const knobReport = knobSpans.map((s) => `${s.name}=${s.text}`).join(', ') || 'none';

  for (const [name, expected] of Object.entries(EXPECTED_AT_DEFAULTS)) {
    const hit = spans.find((s) => s.name === name);
    if (!atDefaults) {
      skip(
        `${name} matches the contract's integer arithmetic`,
        `live rates differ from the shipped defaults (${knobReport}); rendered ${hit?.text ?? 'nothing'}`,
      );
      continue;
    }
    record(
      `${name} matches the contract's integer arithmetic`,
      hit?.text === expected,
      hit ? `rendered ${hit.text}, expected ${expected}` : 'span absent',
    );
  }

  // ── 2. The search finds a page by a figure printed on it ─────────────
  //
  // Navigate WITH the query rather than typing into the box. Two reasons,
  // both load-bearing (Codex #1778 r1, both P1s):
  //
  //  - `HelpSearch` derives `query` from `useSearchParams()` and the
  //    input is uncontrolled (`defaultValue`), so filling it changes
  //    nothing until the form is submitted. The first draft filled and
  //    read, and would have reported FAIL on every otherwise-healthy run.
  //  - `searchDocs` is only called for a query of 2+ characters, so an
  //    empty search page builds NO index. Arriving with `?q=` makes the
  //    first render — which happens before the snapshot resolves — build
  //    the index from bundled defaults, so the post-fetch render has a
  //    stale index to invalidate. That is the regression this check is
  //    for; without it, an implementation that never invalidates would
  //    pass.
  //
  // Honest limit: while the live rates equal the bundled defaults, the
  // figure is the same either way, so this cannot DISCRIMINATE a missing
  // invalidation — it verifies the path end-to-end (index builds
  // pre-snapshot, survives the rebuild, still finds the page). Its full
  // power arrives the first time a retune makes the two differ, which is
  // exactly when the bug would bite.
  // The two loads must sit on ONE config snapshot. The search page is a
  // fresh document whose store fetches independently, so a retune landing
  // between them makes this check meaningless in BOTH directions
  // (Codex #1778 r2 P2): a healthy rebuilt index correctly omits the old
  // figure and reads as a regression, while a stale-index implementation
  // that retained the old value would read as a pass. So the figure is
  // re-read from the Overview afterwards and the result is only trusted
  // if it did not move.
  const readExactFigure = async () => {
    const found = await page.$$eval('[data-live-value]', (els) =>
      els.map((e) => ({ name: e.getAttribute('data-live-value'), text: e.textContent.trim() })),
    );
    return found.find((s) => s.name === 'exampleTreasuryYieldFeeExact')?.text;
  };

  let query = spans.find((s) => s.name === 'exampleTreasuryYieldFeeExact')?.text;
  let settled = false;

  if (!query) {
    record('search finds the page printing the exact figure', false, 'no figure to search for');
  } else {
    // One retry: a retune is a single discrete event, so a second attempt
    // on the new value almost always lands on a stable pair.
    for (let attempt = 1; attempt <= 2 && !settled; attempt++) {
      await gotoFresh(`${BASE}/help/search?q=${encodeURIComponent(query)}`);

      // The search document is a SEPARATE fetch from the Overview's. If
      // it failed, the fallback index still contains the figure whenever
      // live equals bundled, so the check below would pass without a
      // published snapshot ever arriving (Codex #1778 r3 P2).
      const searchDocPublished = configOk;

      // Look inside an actual Overview RESULT, not the whole body.
      // `HelpSearch` interpolates the query into its result-count line and
      // into the always-present "Search the web" link, so
      // `body.includes(query)` is true for any hit at all — including an
      // unrelated one — and a non-empty hit list also removes the
      // no-results message (Codex #1778 r3 P2).
      const found = await page.$$eval(
        'a[href*="/help/overview"]',
        (links, q) => links.some((a) => a.textContent.includes(q)),
        query,
      );

      // Re-read the source of the figure before believing the result.
      await gotoFresh(`${BASE}/help/overview`);
      const after = await readExactFigure();

      if (after === undefined) {
        // A retune changes the figure; it cannot remove the span. A
        // missing span is a broken page, not an unstable snapshot, and
        // must not fall through to the configuration-race skip
        // (Codex #1778 r3 P2).
        settled = true;
        record(
          'exampleTreasuryYieldFeeExact still renders after the search',
          false,
          'the span disappeared between loads — a deploy or a partial page failure, not a retune',
        );
      } else if (after === query) {
        settled = true;
        if (REQUIRE_PUBLISHED) {
          record(
            'the search document received a published snapshot',
            searchDocPublished,
            searchDocPublished ? 'config fetch succeeded' : 'config fetch did not succeed on that document',
          );
        } else {
          skip(
            'the search document received a published snapshot',
            'REQUIRE_PUBLISHED is off for this target',
          );
        }
        record(
          `search finds the page printing ${query}`,
          found,
          found ? 'an Overview result quotes the figure' : 'no Overview result quotes the figure',
        );
      } else if (attempt === 1) {
        console.log(
          `      configuration moved mid-run (${query} → ${after ?? 'nothing'}); ` +
            `retrying the search with the current figure`,
        );
        query = after;
        if (!query) break;
      }
    }

    if (!settled) {
      skip(
        'search finds the page printing the exact figure',
        'the published configuration changed mid-run, so the two page loads sat on ' +
          'different snapshots and the result would be meaningless either way',
      );
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.skipped);
const passed = results.filter((r) => r.ok === true);
console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped ` +
    `(${results.length} checks)`,
);
process.exit(failed.length ? 1 : 0);
