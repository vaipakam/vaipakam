/**
 * Live post-deploy review — the Overview's worked example and the help
 * search, on the DEPLOYED marketing site (#1664 items 1 + 2, PR #1751).
 *
 * Why this is live-only rather than a CI spec: the two things it checks
 * are only true once the published protocol-config snapshot has been
 * fetched from the deployed indexer. A preview build, a guard, or a
 * bundle inspection can all pass while the rendered page still shows
 * something else — which is the whole reason the live-review
 * definition-of-done exists.
 *
 * What it asserts:
 *
 *   1. Each worked-example money figure renders as a DERIVED live value —
 *      its own `data-live-value` span, named, carrying the number the
 *      contract's integer arithmetic produces rather than a decimal
 *      approximation of it.
 *   2. A derived figure's provenance defers to its inputs: it may claim
 *      `published` only when the knobs it was computed from did.
 *   3. The help search finds a page by a figure PRINTED on that page.
 *      That is what the index-cache fix keeps true, and it is the check
 *      that would fail if the index were built before the snapshot
 *      landed.
 *
 * Usage:
 *
 *   node apps/www/e2e/live/live-worked-example.mjs
 *   WWW_ORIGIN=https://staging.example.com node apps/www/e2e/live/live-worked-example.mjs
 *
 * Exits non-zero if any check fails, so it can gate a release step.
 *
 * KNOWN ENVIRONMENT LIMITATION (#1777): this cannot run from a Claude
 * Code remote container. Chromium gets `ERR_CONNECTION_RESET` on every
 * navigation through the agent proxy while `curl` to the same URL
 * through the same proxy returns 200. Run it from an operator machine
 * until that is fixed.
 */
import { chromium } from 'playwright';

const BASE = process.env.WWW_ORIGIN ?? 'https://vaipakam.com';

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
 * Expected at the shipped defaults (2% treasury fee, 0.2% initiation
 * fee) on the documented example of 1,000 USDC at 8% for 30 days.
 *
 * These mirror the contract's integer arithmetic, which floors at each
 * division — `LibEntitlement.proRataInterest` then `splitTreasury`:
 *
 *   (1000e6 * 800 * 30) / (365 * 10000) = 6,575,342   (floors)
 *   (6,575,342 * 200)   / 10000         =   131,506   (floors)
 *
 * A decimal computation gives 0.131507, one micro-USDC high, on a page
 * that calls this figure exact and says settlement uses it. If a retune
 * has moved the live rates these will legitimately differ — the run
 * reports the mismatch rather than asserting the retune away.
 */
const EXPECTED_AT_DEFAULTS = {
  exampleTreasuryYieldFeeExact: '0.131506',
  exampleBorrowerReceives: '998.00',
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
});

try {
  // ── 1. Overview: the derived figures render, with honest provenance ──
  await page.goto(`${BASE}/help/overview`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  // The snapshot is fetched after first paint; give it room to land so a
  // slow fetch reads as slow rather than as "not live".
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

  // Values, but only where the live rates still match the shipped
  // defaults — otherwise a legitimate retune would read as a regression.
  const knobSpans = spans.filter((s) => INPUT_KNOBS.includes(s.name));
  const atDefaults =
    knobSpans.some((s) => s.name === 'treasuryFeeBps' && s.text === '2%') &&
    knobSpans.some((s) => s.name === 'loanInitiationFeeBps' && s.text === '0.2%');

  for (const [name, expected] of Object.entries(EXPECTED_AT_DEFAULTS)) {
    const hit = spans.find((s) => s.name === name);
    if (!atDefaults) {
      console.log(
        `SKIP  ${name} value check — live rates differ from the shipped ` +
          `defaults (${knobSpans.map((s) => `${s.name}=${s.text}`).join(', ')}); ` +
          `rendered ${hit?.text ?? 'nothing'}`,
      );
      continue;
    }
    record(
      `${name} matches the contract's integer arithmetic`,
      hit?.text === expected,
      hit ? `rendered ${hit.text}, expected ${expected}` : 'span absent',
    );
  }

  // Provenance defers to the least certain input: a derived figure may
  // claim `published` only when every knob it depends on did.
  const derivedSpans = spans.filter((s) => DERIVED.includes(s.name));
  const knobsLive = knobSpans.length > 0 && knobSpans.every((s) => s.source === 'published');
  const expectedSource = knobsLive ? 'published' : 'bundled';
  record(
    'derived provenance defers to its inputs',
    derivedSpans.length > 0 && derivedSpans.every((s) => s.source === expectedSource),
    `knobs ${knobSpans.map((s) => s.source).join('/')} → derived ` +
      `${[...new Set(derivedSpans.map((s) => s.source))].join('/')} (expected ${expectedSource})`,
  );

  // ── 2. The search finds a page by a figure printed on it ─────────────
  // Query with whatever the page ACTUALLY rendered, not a hardcoded
  // figure — that is precisely the invariant: index and page agree.
  const exact = spans.find((s) => s.name === 'exampleTreasuryYieldFeeExact');
  const query = exact?.text;

  if (!query) {
    record('search finds the page printing the exact figure', false, 'no figure to search for');
  } else {
    await page.goto(`${BASE}/help/search`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(3_000);

    const input = await page.$('input[type="search"], input[type="text"]');
    if (!input) {
      record('help search input present', false, 'no input found');
    } else {
      record('help search input present', true);
      await input.fill(query);
      await page.waitForTimeout(1_500);
      const bodyText = await page.textContent('body');
      const found = !/no results|no matches/i.test(bodyText) && bodyText.includes(query);
      record(
        `search finds the page printing ${query}`,
        found,
        found ? 'a result quotes the figure' : 'no result quoting the figure',
      );
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
