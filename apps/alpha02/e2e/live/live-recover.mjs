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
/** apps/www's fixed navbar is 72px; anything landing above this is
 *  behind it. The guide's own `scroll-margin-top` is 96px (desktop) /
 *  132px (mobile, which also has a sticky role bar), so a correct
 *  landing clears this comfortably. */
const NAVBAR_CLEARANCE_PX = 72;

const fails = [];
/** Console/page errors from the separately-opened guide page. */
const guideErrors = [];
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

/** Hrefs of every anchor on the page that targets a `/recover` path,
 *  absolute or relative. Destination-based, so a relabelled or
 *  icon-only link cannot slip past.
 *
 *  Deliberately origin-AGNOSTIC: this feeds the FORBIDDEN-link check,
 *  where any link pointing at a recovery route — including one on
 *  another host — is worth failing on rather than quietly allowing. */
async function recoverLinkHrefs(page) {
  return page.$$eval('a[href]', (as) =>
    as
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => /(^|\/)recover(\/|$|[?#])/.test(href)),
  );
}

/**
 * Does a robots value carry BOTH directives as complete tokens?
 *
 * Substring matching passed `noindexing, nofollowing` — values that
 * contain the directive names but are not them, so a crawler receives
 * neither and the run reports the policy green over a broken response
 * (Codex #1561 r3). Split on commas and match exactly instead; the
 * same helper covers the header and the meta tag so the two can't be
 * checked to different standards.
 */
function hasRobotsDirectives(value) {
  const tokens = (value ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tokens.includes('noindex') && tokens.includes('nofollow');
}

/** Does `href` resolve to THIS app's own `/recover` route?
 *
 *  Origin matters here in a way it doesn't for the forbidden-link scan:
 *  a Help link changed to `https://attacker.example/recover` satisfies
 *  any path-shaped test while sending users off-site from the one
 *  entry point the safety gate funnels them through (Codex #1561 r2).
 *  Resolved against SITE, so a relative href keeps working. */
function isOwnRecoverRoute(href) {
  try {
    const url = new URL(href, SITE);
    return url.origin === new URL(SITE).origin && /^\/recover\/?$/.test(url.pathname);
  } catch {
    return false;
  }
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
    const explainerHrefs = await explainer
      .locator('a[href], [role="link"][href]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    const deepLinkHref = explainerHrefs.find((href) => isOwnRecoverRoute(href)) ?? null;
    const offSiteRecover = explainerHrefs.filter(
      (href) => /(^|\/)recover(\/|$|[?#])/.test(href) && !isOwnRecoverRoute(href),
    );
    check(
      `help links this app's own /recover (href ${deepLinkHref ?? 'MISSING'})`,
      Boolean(deepLinkHref),
    );
    check(
      `no off-site recovery link in the explainer${offSiteRecover.length ? ` (${offSiteRecover.join(', ')})` : ''}`,
      offSiteRecover.length === 0,
    );

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
      // `driver.mjs` attaches its console/pageerror listeners to the
      // ORIGINAL page only, so anything this page throws would never
      // reach the final assertion that claims uncaught errors fail the
      // run (Codex #1561 r2). Wire up an equivalent pair here.
      guidePage.on('console', (m) => {
        if (m.type() === 'error') guideErrors.push(m.text());
      });
      guidePage.on('pageerror', (e) => guideErrors.push('PAGEERROR: ' + e.message));
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

        // Existence is not the property the user cares about — LANDING
        // is. The marker can stay attached while losing `display:block`
        // or its `scroll-margin-top`, which puts it at viewport top
        // under the fixed navbar with the named heading inside the
        // covered strip: the link "works" and the reader sees the wrong
        // thing (Codex #1561 r3). Measure where the heading actually
        // ends up after fragment navigation.
        if (anchored) {
          await guidePage.waitForTimeout(1500); // let the fragment scroll settle
          const landing = await guidePage
            .locator(`[id="${GUIDE_ANCHOR_ID}"]`)
            .evaluate((el) => {
              const heading = el.nextElementSibling;
              const box = heading?.getBoundingClientRect();
              return {
                tag: heading?.tagName ?? null,
                top: box ? Math.round(box.top) : null,
                viewport: window.innerHeight,
              };
            })
            .catch(() => null);
          const isHeading = /^H[1-6]$/.test(landing?.tag ?? '');
          const clearsChrome =
            landing?.top != null &&
            landing.top >= NAVBAR_CLEARANCE_PX &&
            landing.top < landing.viewport;
          check(
            `attested section lands clear of the fixed chrome ` +
              `(${landing?.tag ?? 'no heading'} at ${landing?.top ?? '?'}px, need >= ${NAVBAR_CLEARANCE_PX})`,
            isHeading && clearsChrome,
          );
        }
      } finally {
        await guidePage.close();
      }
    }
  }

  // 2. No nav/Settings entry anywhere — the gate is the whole point.
  //    Checked by destination on both the Settings page and the shell
  //    around it (the nav renders on every route).
  // Scanned in BOTH experience modes. Advanced-only nav items and
  // Settings cards are filtered by `isAdvanced`, so a forbidden link
  // added to one of those simply would not be in the Basic DOM — and a
  // persistent profile sitting in Basic would have certified the gate
  // clean without ever rendering the thing that breaks it (Codex #1561
  // r3). The mode is read from localStorage at boot, so it is set
  // directly and the page reloaded rather than driven through the UI.
  for (const mode of ['basic', 'advanced']) {
    await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate((m) => localStorage.setItem('alpha02.mode', m), mode);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureConnected(page);
    // Settings is `React.lazy` like Help, so a fixed sleep can scan the
    // Suspense fallback — which has no links at all, making a
    // deployment that DID add the forbidden link look clean (Codex
    // #1561 r2). Wait for the page itself, and fail loudly if it never
    // renders rather than reporting a link-free page.
    const settingsReady = await page
      .getByRole('heading', { name: /settings/i })
      .first()
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    check(`settings renders in ${mode} mode (the link scan means nothing otherwise)`, settingsReady);
    const settingsRecoverLinks = settingsReady
      ? await recoverLinkHrefs(page)
      : ['<settings never rendered>'];
    check(
      `no Settings/nav link targets /recover in ${mode} mode${
        settingsRecoverLinks.length ? ` (found ${settingsRecoverLinks.join(', ')})` : ''
      }`,
      settingsRecoverLinks.length === 0,
    );
  }

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
    hasRobotsDirectives(xRobots),
  );

  await ensureConnected(page);
  const posture = await settledPosture(page);
  check(`/recover settles on a definite state (got ${posture ?? 'STILL PROBING'})`, posture !== null);

  // WALLET-SPECIFIC postures are correct whatever the oracle says, and
  // they render AHEAD of the availability state — a durable unresolved
  // record locks the page before it ever asks about the oracle, and a
  // flagged wallet is blocked either way. Judging them against the
  // oracle branch made a correct page look like a deployment failure
  // the moment the oracle was reset under a profile carrying a pending
  // record (Codex #1561 r3). The driver can't clear either condition
  // from a read-only run, so both are skips wherever they appear.
  if (posture === 'sanctioned' || posture === 'pending') {
    console.log(
      `skip  this wallet is in the "${posture}" posture — the form is correctly ` +
        'withheld regardless of the oracle setting; re-run with a clean, unflagged ' +
        'wallet with no outstanding attempt to exercise the availability arms.',
    );
  } else if (oracleSet) {
    // Configured deployment: the form is the correct posture for a
    // clean wallet with nothing outstanding.
    check('oracle configured → form offered', posture === 'form');
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
  check(`meta robots is noindex,nofollow (got ${robots})`, hasRobotsDirectives(robots));
} finally {
  await done();
}

/**
 * Is this blocked request Cloudflare's Real User Monitoring beacon?
 *
 * `/cdn-cgi/` is Cloudflare's reserved path — injected by the edge into
 * pages it serves, never routed by application code — and `rum` is the
 * monitoring beacon specifically. Blocking it is correct (it is a POST
 * and this run is read-only), but FAILING on it is not: it says nothing
 * about whether the surface under review tried to mutate anything, and
 * it fires on the marketing page the guide arm opens as a second tab,
 * which isn't even this app.
 *
 * Matched by exact PATHNAME on a first-party host, not by substring.
 * A `/cdn-cgi/` substring test would also have waved through a genuine
 * mutating POST to something like `/cdn-cgi/upload`, or any external
 * URL that merely contains the segment — turning a narrow carve-out
 * into a hole in the one check that proves this review didn't write
 * anything (Codex #1576 r1).
 *
 * Kept narrow deliberately. A guard that reports a failure nobody can
 * act on gets ignored, and the real violation it exists to catch gets
 * ignored with it — but a guard widened past its reason stops being a
 * guard at all.
 */
function isCloudflareBeacon({ reason, url: rawUrl }) {
  // The REASON has to match too, not just the URL. `readOnlyViolation`
  // classifies by content: a JSON-RPC body carrying a write method is
  // recorded as `json-rpc eth_sendTransaction`, whatever URL it was
  // posted to. A URL-only filter would therefore have exempted a
  // signing or broadcast attempt aimed at the beacon path — the single
  // worst thing this check exists to catch (Codex #1576 r2).
  //
  // POST specifically, not any method. The documented beacon is a POST;
  // a PUT/PATCH/DELETE to the same path is an anomaly, and accepting
  // the generic shape would have filed it as expected telemetry —
  // contradicting the claim that everything else stays fatal (Codex
  // #1576 r3). Every `json-rpc *` and `wallet rpc *` reason falls
  // through and stays fatal too, as does any reason shape this doesn't
  // recognise: unknown means fatal, the safe direction for a guard.
  if (reason !== 'POST (non-RPC mutating request)') return false;
  try {
    const url = new URL(rawUrl);
    // ORIGIN, not hostname: `hostname` ignores both scheme and port, so
    // `http://alpha02.vaipakam.com/cdn-cgi/rum` (cleartext) and
    // `https://vaipakam.com:8443/cdn-cgi/rum` (odd port) matched a
    // hostname test while being nothing Cloudflare's edge would emit
    // (Codex #1576 r4). `url.origin` folds scheme, host and non-default
    // port into one comparable value, so the default HTTPS port is the
    // only one that can match.
    const firstPartyOrigin =
      url.protocol === 'https:' &&
      (url.hostname === 'vaipakam.com' || url.hostname.endsWith('.vaipakam.com')) &&
      url.origin === `https://${url.hostname}`;
    return firstPartyOrigin && url.pathname === '/cdn-cgi/rum';
  } catch {
    return false;
  }
}

// 5. The read-only guard's own findings. A blocked request means the
//    page attempted a signing RPC or a backend write during a review
//    that claims to be read-only — that is a finding in its own right,
//    not noise to discard under otherwise-green checks.
const telemetry = blockedRequests.filter((b) => isCloudflareBeacon(b));
const violations = blockedRequests.filter((b) => !isCloudflareBeacon(b));
if (telemetry.length) {
  console.log(
    `\nBlocked ${telemetry.length} edge-telemetry request(s) (expected, not a finding):`,
  );
  for (const b of telemetry.slice(0, 5)) console.log(`  ${b.reason} ${b.url}`);
}
if (violations.length) {
  console.log(`\nBlocked ${violations.length} non-read request(s):`);
  for (const b of violations.slice(0, 20)) console.log(`  ${b.reason} ${b.url}`);
  fails.push(`${violations.length} blocked non-read request(s)`);
}
// Uncaught exceptions are app defects and fail the run. Ordinary
// console.error noise on a live page (a rate-limited RPC, a third-party
// asset) is reported but not fatal — it is not evidence about this
// surface.
const allConsoleErrors = [...consoleErrors, ...guideErrors];
const pageErrors = allConsoleErrors.filter((e) => e.startsWith('PAGEERROR:'));
if (allConsoleErrors.length) {
  console.log(`\n${allConsoleErrors.length} console error(s) (app + guide page):`);
  for (const e of allConsoleErrors.slice(0, 12)) console.log(`  ${e.slice(0, 200)}`);
}
if (pageErrors.length) fails.push(`${pageErrors.length} uncaught page error(s)`);

if (fails.length) {
  console.log('\nFAILED checks:', fails.join(' | '));
  process.exit(1);
}
console.log('\nlive recover review: ALL CHECKS PASSED');
