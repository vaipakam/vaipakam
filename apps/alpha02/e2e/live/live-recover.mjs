// #1547 post-deploy live review — the unlisted /recover surface on
// production alpha02.
//
// What this can prove live, and why it is worth proving:
//
//  - DISCOVERABILITY GATE: /recover has no nav or Settings entry; the
//    only in-app path is the Help explainer's deep link. A regression
//    that added it to the nav would defeat the dust-poisoning gate.
//    Checked by LINK DESTINATION, never by label: a link added as
//    "Stuck tokens", or an icon-only one with no matching accessible
//    name, defeats the gate just as thoroughly (Codex #1561 r1).
//  - FAIL-SAFE BLOCKED STATE: the retail deploy ships the sanctions
//    oracle UNSET and recovery hard-requires it, so production must
//    present recovery as unavailable rather than offer a doomed form.
//    This is the one arm the fork CANNOT check honestly — the fork
//    spec has to install a mock oracle to drive the success path — so
//    production is where the shipped default is actually verified.
//    (When the oracle is later configured, this flips: the form
//    renders and this driver says so rather than failing, since both
//    are correct for their configuration.)
//  - GUIDE LINK: the signed declaration attests to reading the
//    Advanced User Guide section, so the link to it must resolve —
//    it pointed at a non-existent route until #1547 r11. Status alone
//    proves nothing here: apps/www runs with
//    `not_found_handling: "single-page-application"`, so EVERY unknown
//    path returns 200 with the SPA shell. The check therefore opens the
//    link and asserts the anchored section actually exists on the page
//    it lands on (Codex #1561 r1).
//  - ROBOTS: the DEPLOYED `X-Robots-Tag` header, not just the meta tag.
//    A JS-less crawler never runs React, so if Cloudflare stops
//    applying the /recover rule from public/_headers the meta tag alone
//    is not the directive those crawlers see — and the fork/Vite tier
//    cannot check deployment headers at all (Codex #1561 r1).
//
// Read-only: no wallet writes. The read-only guard's own violation log
// is asserted at the end, so an attempted signing RPC or backend write
// fails the run instead of passing quietly underneath green checks.
// Recovery itself cannot be driven on production without real stuck
// dust, which is a manual exercise.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { ensureConnected, launch, SITE } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAMOND = JSON.parse(
  readFileSync(
    path.join(HERE, '../../../../packages/contracts/src/deployments.json'),
    'utf8',
  ),
)['84532'].diamond;
const ORACLE_ABI = parseAbi([
  'function getSanctionsOracle() view returns (address)',
]);
const pub = createPublicClient({
  transport: http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org'),
});
const ZERO = '0x0000000000000000000000000000000000000000';

// The exact guide target the recovery declaration attests to. Kept in
// sync with src/lib/externalLinks.ts — a drift here is itself the bug
// this check exists to catch.
const GUIDE_URL = 'https://vaipakam.com/help/advanced#stuck-recovery.what';
const GUIDE_ANCHOR_ID = 'stuck-recovery.what';

const fails = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${label}`);
  if (!ok) fails.push(label);
};

/**
 * The /recover page's terminal postures. Every one of these is a
 * DEFINITE answer; `checkingAvailability` deliberately is not, because
 * the page retries the oracle probe up to three times before settling.
 * Sampling on a fixed sleep raced that retry window and could mark a
 * healthy deployment failed (Codex #1561 r1), so the driver waits for
 * one of these to appear instead of guessing how long probing takes.
 */
const POSTURES = [
  { key: 'form', find: (p) => p.getByLabel(/token contract address/i) },
  { key: 'unavailable', find: (p) => p.getByText(/recovery isn[’']t available on this network yet/i) },
  { key: 'unreachable', find: (p) => p.getByText(/couldn[’']t check whether recovery is available/i) },
  { key: 'contractWallet', find: (p) => p.getByText(/this kind of wallet can[’']t use recovery yet/i) },
  { key: 'sanctioned', find: (p) => p.getByText(/flagged by the sanctions oracle/i) },
  { key: 'wrongChain', find: (p) => p.getByText(/switch your wallet to a supported network to use recovery/i) },
  // An unresolved attempt on record: the page withholds the form on
  // purpose until the user resolves it.
  { key: 'pending', find: (p) => p.getByText(/check the transaction again|start over|i[’']ve checked my wallet/i) },
];

/** Poll until one of `POSTURES` is visible, or time out. Returns the
 *  key, or null. */
async function settledPosture(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const { key, find } of POSTURES) {
      if (await find(page).first().isVisible().catch(() => false)) return key;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/** Hrefs of every anchor on the page that targets `/recover`, absolute
 *  or relative. Destination-based, so a relabelled or icon-only link
 *  cannot slip past. */
async function recoverLinkHrefs(page) {
  return page.$$eval('a[href]', (as) =>
    as
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => /(^|\/)recover(\/|$|[?#])/.test(href)),
  );
}

const { page, ctx, done, blockedRequests, consoleErrors } = await launch({
  role: 'borrower',
  readOnly: true,
});
try {
  // The live oracle setting decides which posture is CORRECT — read it
  // first so this driver checks the deployment it actually found.
  const oracle = await pub.readContract({
    address: DIAMOND,
    abi: ORACLE_ABI,
    functionName: 'getSanctionsOracle',
  });
  const oracleSet = oracle.toLowerCase() !== ZERO;
  console.log(`sanctions oracle: ${oracleSet ? 'configured' : 'UNSET'}`);

  // 1. Discoverability gate — in via Help only.
  await page.goto(SITE + '/help', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureConnected(page);
  // Help is a React.lazy route and `domcontentloaded` does not wait for
  // its dynamic import, so an immediate isVisible() can read the
  // Suspense fallback and fail a healthy deployment (Codex #1561 r1).
  const explainer = page.locator('#stuck-tokens');
  const explainerVisible = await explainer
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  check('help explainer section renders', explainerVisible);

  if (explainerVisible) {
    // The deep link must POINT AT /recover, not merely be labelled as
    // if it does — a wrong href makes the only in-app path to the
    // safety-gated flow dead while the label still reads correctly.
    const deepLinkHref = await explainer
      .locator('a[href], [role="link"][href]')
      .evaluateAll((as) =>
        as
          .map((a) => a.getAttribute('href') ?? '')
          .find((href) => /(^|\/)recover(\/|$|[?#])/.test(href)) ?? null,
      );
    check(`help links the recovery flow (href ${deepLinkHref ?? 'MISSING'})`, Boolean(deepLinkHref));

    // The guide the signed declaration attests to must be linked AND
    // land on the real section.
    const guideHref = await explainer
      .getByRole('link', { name: /advanced user guide|guide/i })
      .first()
      .getAttribute('href')
      .catch(() => null);
    check(`help links the Advanced User Guide (${guideHref ?? 'MISSING'})`, guideHref === GUIDE_URL);

    if (guideHref) {
      // apps/www serves the SPA shell with 200 for unknown paths, so a
      // status check cannot tell a real section from a NotFound page.
      // Open it and require the anchored element to exist.
      const guidePage = await ctx.newPage();
      try {
        const res = await guidePage.goto(guideHref, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        const anchored = await guidePage
          .locator(`[id="${GUIDE_ANCHOR_ID}"]`)
          .waitFor({ state: 'attached', timeout: 45_000 })
          .then(() => true)
          .catch(() => false);
        check(
          `guide link resolves to the attested section (status ${res?.status()}, ` +
            `#${GUIDE_ANCHOR_ID} ${anchored ? 'present' : 'ABSENT'})`,
          Boolean(res && res.ok()) && anchored,
        );
      } finally {
        await guidePage.close();
      }
    }
  }

  // 2. No nav/Settings entry anywhere — the gate is the whole point.
  //    Checked by destination on both the Settings page and the shell
  //    around it (the nav renders on every route).
  await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureConnected(page);
  await page.waitForTimeout(2500);
  const settingsRecoverLinks = await recoverLinkHrefs(page);
  check(
    `no Settings/nav link targets /recover${
      settingsRecoverLinks.length ? ` (found ${settingsRecoverLinks.join(', ')})` : ''
    }`,
    settingsRecoverLinks.length === 0,
  );

  // 3. The route itself: deployed robots header, then the posture
  //    matching the live oracle.
  const recoverRes = await page.goto(SITE + '/recover', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // Header first — it is a property of the RESPONSE, so it must be read
  // from the navigation rather than inferred from the rendered DOM.
  const xRobots = recoverRes?.headers()['x-robots-tag'] ?? null;
  check(
    `X-Robots-Tag is noindex, nofollow (got ${xRobots ?? 'ABSENT'})`,
    /noindex/i.test(xRobots ?? '') && /nofollow/i.test(xRobots ?? ''),
  );

  await ensureConnected(page);
  const posture = await settledPosture(page);
  check(`/recover settles on a definite state (got ${posture ?? 'STILL PROBING'})`, posture !== null);

  if (oracleSet) {
    // Configured deployment: the form is the correct posture for a
    // clean wallet with nothing outstanding. A flagged wallet or an
    // unresolved attempt on record ALSO correctly withholds the form,
    // so those are reported as skips, not failures (Codex #1561 r1) —
    // the driver has no way to clear either from a read-only run.
    if (posture === 'sanctioned' || posture === 'pending') {
      console.log(
        `skip  oracle configured, but this wallet is in the "${posture}" posture — ` +
          'the form is correctly withheld; re-run with a clean, unflagged wallet ' +
          'to exercise the form arm.',
      );
    } else {
      check('oracle configured → form offered', posture === 'form');
    }
  } else {
    // Shipped retail default: recovery must be presented as
    // unavailable, never as a form that could only produce a doomed
    // signature.
    check('oracle unset → recovery presented as unavailable', posture === 'unavailable');
  }

  // 4. Meta robots too — belt and braces with the header above, since
  //    the two are set in different places and can drift apart.
  const robots = await page
    .locator('meta[name="robots"]')
    .getAttribute('content')
    .catch(() => null);
  check(
    `meta robots is noindex,nofollow (got ${robots})`,
    /noindex/.test(robots ?? '') && /nofollow/.test(robots ?? ''),
  );
} finally {
  await done();
}

// 5. The read-only guard's own findings. A blocked request means the
//    page attempted a signing RPC or a backend write during a review
//    that claims to be read-only — that is a finding in its own right,
//    not noise to discard under otherwise-green checks.
if (blockedRequests.length) {
  console.log(`\nBlocked ${blockedRequests.length} non-read request(s):`);
  for (const b of blockedRequests.slice(0, 20)) console.log(`  ${b.reason} ${b.url}`);
  fails.push(`${blockedRequests.length} blocked non-read request(s)`);
}
// Uncaught exceptions are app defects and fail the run. Ordinary
// console.error noise on a live page (a rate-limited RPC, a third-party
// asset) is reported but not fatal — it is not evidence about this
// surface.
const pageErrors = consoleErrors.filter((e) => e.startsWith('PAGEERROR:'));
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e.slice(0, 200)}`);
}
if (pageErrors.length) fails.push(`${pageErrors.length} uncaught page error(s)`);

if (fails.length) {
  console.log('\nFAILED checks:', fails.join(' | '));
  process.exit(1);
}
console.log('\nlive recover review: ALL CHECKS PASSED');
