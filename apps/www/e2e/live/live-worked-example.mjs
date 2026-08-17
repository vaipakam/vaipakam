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

const BASE = process.env.WWW_ORIGIN ?? 'https://vaipakam.com';
const IS_PRODUCTION = BASE === 'https://vaipakam.com';
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
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
});

console.log(`Target: ${BASE}  (published snapshot ${REQUIRE_PUBLISHED ? 'REQUIRED' : 'optional'})\n`);

try {
  // ── 1. Overview: the derived figures render, with honest provenance ──
  await page.goto(`${BASE}/help/overview`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  // The snapshot is fetched after first paint; give it room so a slow
  // fetch reads as slow rather than as "not live".
  await page.waitForTimeout(3_000);

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
  const knobsLive = knobSpans.length > 0 && knobSpans.every((s) => s.source === 'published');

  // An all-bundled render is indistinguishable from a healthy one by
  // value alone, because the bundled defaults ARE the current on-chain
  // values. On production that is a failed indexer fetch, and letting it
  // pass would mean the drive never observes the published snapshot it
  // exists to check (Codex #1778 r1 P2).
  if (REQUIRE_PUBLISHED) {
    record(
      'input knobs came from the published snapshot',
      knobsLive,
      knobSpans.map((s) => `${s.name}=${s.source}`).join(', ') || 'no knob spans',
    );
  } else {
    skip('input knobs came from the published snapshot', 'REQUIRE_PUBLISHED is off for this target');
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
  const exact = spans.find((s) => s.name === 'exampleTreasuryYieldFeeExact');
  const query = exact?.text;

  if (!query) {
    record('search finds the page printing the exact figure', false, 'no figure to search for');
  } else {
    await page.goto(`${BASE}/help/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    const bodyText = await page.textContent('body');
    const found = !/no results|no matches/i.test(bodyText) && bodyText.includes(query);
    record(
      `search finds the page printing ${query}`,
      found,
      found ? 'a result quotes the figure' : 'no result quoting the figure',
    );
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
