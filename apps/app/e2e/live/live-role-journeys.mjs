/**
 * Role-based JOURNEY review of the deployed connected app.
 *
 * Why this exists alongside the other live drivers: `COVERAGE.md` is
 * organised by FEATURE — one row per PR or issue, each asserting that a
 * specific mechanism works. That answers "did #1131 ship?" It does not
 * answer "can a person who has never seen this product get from the
 * landing page to a lending offer without hitting a dead end?" Those are
 * different questions, and only the second one catches a surface that is
 * individually correct and collectively unusable.
 *
 * So each scenario here is written as a USER GOAL with an explicit
 * DESIRED outcome recorded before the run, and the ACTUAL outcome
 * captured from the live page. A scenario whose desired outcome is
 * "nothing happens" is as real as one that transacts — a route that
 * silently renders an empty shell to a disconnected visitor is a defect
 * even though every feature test passes.
 *
 * ROLES are wallet postures, not personas for their own sake:
 *   - `visitor`   KEYLESS: no `window.ethereum` installed and no
 *                 EIP-6963 provider announced. This is the only posture
 *                 that reproduces a first-time arrival honestly. Two
 *                 weaker versions were tried and are worth naming: an
 *                 auto-connecting wallet tests a RETURNING user, and an
 *                 installed-but-account-less wallet tests someone who
 *                 has an extension and has not connected it. Neither
 *                 reaches the app's no-provider branches, so a
 *                 regression confined to visitors without a wallet
 *                 extension passes both.
 *   - `lender` / `borrower`  connected, funded testnet roles.
 *
 * READ-ONLY, AND ENFORCED RATHER THAN PROMISED. Every session launches
 * with `readOnly: true`, so the injected wallet DENIES `personal_sign`,
 * typed-data signing and `eth_sendTransaction` at the provider. A run
 * that records any such attempt FAILS.
 *
 * That enforcement is the point, and an earlier revision of this file
 * got it wrong in a way worth recording: it made this same claim in
 * prose while launching with the default `readOnly: false`. A funded
 * wallet is injected for the connected roles, so a regressed or
 * hostile bundle served from the caller-controlled `SITE_URL` could
 * have had a signature approved automatically on page load — spending
 * testnet funds or creating signed commitments with no scenario doing
 * anything. A comment is not a guard.
 *
 * The signing journeys are already driven by `live-dryrun-review.mjs`,
 * `live-signed-book.mjs` and `live-rate-desk.mjs`; duplicating them
 * here would spend testnet gas to re-prove covered ground.
 *
 * Usage:
 *   SITE_URL=https://app.vaipakam.com \
 *   TESTNET_WALLETS_FILE=~/secrets/vaipakam-dev-wallets.json \
 *     node live-role-journeys.mjs
 *
 *   JOURNEY_ROLES=visitor        # optional subset, comma-separated
 *   JOURNEY_JSON=out/report.json # optional machine-readable dump
 *
 * `TESTNET_WALLETS_FILE` is required for the CONNECTED roles, whose
 * sessions build an injected provider from the role's key. The visitor
 * posture is keyless and needs no credential at all. No key is ever used
 * to sign here — `readOnly` denies write RPCs outright.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  launch,
  visit,
  ensureConnected,
  LiveSetupError,
  SITE,
  requireSiteUrl,
} from './driver.mjs';

requireSiteUrl();

/** Text that means the app rendered its own not-found, not a blank shell. */
const NOT_FOUND = /doesn.t exist|not found|404/i;

/**
 * Strings a scenario expects the page to render, read from the app's own
 * English catalog rather than restated here.
 *
 * A copy of an expected string in a test is a second source that drifts:
 * rename the heading and the assertion keeps passing against the old
 * text until someone notices. `live-recover-locales.mjs` established
 * this rule and it applies for the same reason. English because this
 * drive runs in the default locale — the locale sweep is that drive's
 * job, not this one's.
 */
const EN = JSON.parse(
  readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url), 'utf8'),
);
const EXPECTED = {
  offersTitle: EN.copy.offers.title,
};

/**
 * A scenario's `check` returns { ok, actual }. `actual` is recorded
 * verbatim in the report whether or not it passed — a report that only
 * describes failures cannot be diffed against the next run.
 */
const SCENARIOS = [
  // ─── visitor: the first-arrival journey ────────────────────────────
  {
    id: 'V1',
    role: 'visitor',
    goal: 'Landing page tells a newcomer what this is and offers a way in',
    route: '/',
    desired:
      'Page renders substantive copy (>200 chars) AND surfaces at least one ' +
      'primary action (connect / lend / borrow). Not a bare shell.',
    async check(page) {
      const txt = await bodyText(page);
      const actions = await countMatches(page, /connect wallet|lend|borrow|get started/i);
      return {
        ok: txt.length > 200 && actions > 0,
        actual: `body=${txt.length} chars, ${actions} primary-action match(es)`,
      };
    },
  },
  {
    id: 'V2',
    role: 'visitor',
    goal: 'Public offer book is readable WITHOUT connecting a wallet',
    route: '/offers',
    desired:
      'Offer book renders its own content (not NotFound, not a connect wall ' +
      'that hides everything). Browsing before committing is the point.',
    async check(page) {
      // ASSERT THE OFFER BOOK, NOT ITS SIZE (review round 16 P2). This
      // used to pass on `length > 150 && !NotFound`, which a connect
      // wall clears comfortably — so the one scenario whose whole point
      // is "no wallet needed to browse" could not detect the book being
      // put behind a wallet. The `desired` text already said that; the
      // predicate did not implement it.
      //
      // The heading is read from the repo's OWN catalog, not hardcoded
      // here — the same no-second-copy-to-drift rule
      // `live-recover-locales.mjs` follows. It is what makes this
      // book-specific: a first attempt asserted `h1` + one of
      // `.row-list` / `.empty-state`, and calibration against
      // `/positions` showed that predicate passing there too, because
      // `EmptyState` is a shared component every gated route renders.
      // A structural marker only discriminates if it is not shared.
      //
      // Then one of `.row-list` (rows) or `.empty-state` (the book's
      // empty, loading and unavailable postures — all legitimate), so
      // an empty market still passes while a stripped page does not.
      const txt = await bodyText(page);
      const heading = (await page.locator('#main-content h1').first().textContent().catch(() => ''))?.trim() ?? '';
      const rows = await page.locator('#main-content .row-list').count().catch(() => 0);
      const empty = await page.locator('#main-content .empty-state').count().catch(() => 0);
      const gated = await gateMasked(page);
      const isBookHeading = heading === EXPECTED.offersTitle;
      const book = rows > 0 || empty > 0;
      return {
        ok: !gated && isBookHeading && book && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `heading=${JSON.stringify(heading.slice(0, 40))} (want ${JSON.stringify(EXPECTED.offersTitle)}), rowList=${rows}, emptyState=${empty}, legalGate=${gated}`,
        note: gated
          ? 'the book was replaced by the Terms gate — a visitor with no wallet must not need to accept anything to browse'
          : !isBookHeading
            ? 'this is not the offer book — the route rendered some other surface'
            : book
              ? ''
              : 'neither offer rows nor an empty/unavailable state rendered — the book is behind something',
      };
    },
  },
  {
    id: 'V3',
    role: 'visitor',
    goal: 'A wallet-gated route explains itself rather than rendering blank',
    route: '/positions',
    desired:
      'Either a connect prompt or an explanatory empty state. A route that ' +
      'renders almost nothing to a disconnected visitor is a dead end.',
    async check(page) {
      const txt = await bodyText(page);
      const explains = /connect|wallet|no .*(position|loan)|sign in/i.test(txt);
      return {
        ok: txt.length > 80 && explains,
        actual: `body=${txt.length} chars, explanatory=${explains}`,
      };
    },
  },
  {
    id: 'V4',
    role: 'visitor',
    goal: 'Help is reachable and populated',
    route: '/help',
    desired: 'Substantial help content (>500 chars).',
    async check(page) {
      const txt = await bodyText(page);
      return { ok: txt.length > 500, actual: `body=${txt.length} chars` };
    },
  },
  {
    id: 'V5',
    role: 'visitor',
    goal: 'Privacy controls reachable without a wallet (#1960)',
    route: '/data-rights',
    desired:
      'Data Rights renders its own surface. These controls are same-origin ' +
      'to the app, so no other site can stand in for them.',
    async check(page) {
      const txt = await bodyText(page);
      const h1 = await firstHeading(page);
      return {
        ok: txt.length > 200 && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `h1="${h1}", body=${txt.length} chars`,
      };
    },
  },
  {
    id: 'V6',
    role: 'visitor',
    goal: 'An unknown URL fails honestly',
    route: '/definitely-not-a-real-route',
    desired: 'The app renders its own not-found copy, not a blank page.',
    async check(page) {
      const txt = await bodyText(page);
      return {
        ok: NOT_FOUND.test(txt),
        actual: `notFound=${NOT_FOUND.test(txt)}, body=${txt.length} chars`,
      };
    },
  },
  {
    id: 'V7',
    role: 'visitor',
    goal: 'Recovery gates on connection BEFORE offering any form (#1547)',
    route: '/recover',
    desired:
      'Explains what the flow is, warns about the blocking risk, and asks ' +
      'the visitor to connect — while rendering ZERO inputs. A recovery ' +
      'form shown to someone with no wallet is a form that cannot work.\n' +
      '      NOTE: the oracle-unset "unavailable" posture is NOT visible ' +
      'here; it is only observable once connected, so asserting it against ' +
      'a disconnected visitor tests nothing. See R1.',
    async check(page) {
      const txt = await bodyText(page);
      const inputs = await page.locator('form, input').count();
      const gates = /connect a wallet|connect wallet/i.test(txt);
      const warns = /blocked|don.t recognise|don.t recognize/i.test(txt);
      // `warns` is part of `ok`, not just reported. The desired outcome
      // and the coverage claim both say this warning was verified; if it
      // is only printed, losing it leaves the scenario green and the
      // claim false.
      return {
        ok: gates && inputs === 0 && warns && txt.length > 100,
        actual: `connect-gate=${gates}, inputs=${inputs}, risk-warning=${warns}`,
      };
    },
  },
  {
    id: 'R1',
    role: 'lender',
    goal: 'Recovery states its ORACLE posture honestly once connected (#1547)',
    route: '/recover',
    desired:
      'With the recovery oracle unset (the retail default), the connected ' +
      'view should present recovery as unavailable rather than offer a form ' +
      'that is guaranteed to fail. This is the arm the Anvil fork cannot ' +
      'check honestly, because its spec installs a mock oracle.',
    // Polled, not slept. `/recover` runs parallel availability checks and
    // can legitimately sit on "Checking whether recovery is available
    // here…" for longer than any fixed delay — `live-recover.mjs` uses a
    // bounded poll for exactly this reason. A fixed sleep reports a
    // healthy-but-slow page as a product FAIL.
    async settle(page) {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const t = (await page.locator('body').innerText().catch(() => '')) || '';
        const inputs = await page.locator('input').count();
        if (inputs > 0 || /(is|are)n[''\u2019]?t available|not available|unavailable/i.test(t)) return;
        await page.waitForTimeout(1_500);
      }
    },
    async check(page) {
      const txt = await bodyText(page);
      const inputs = await page.locator('input').count();
      // The shared "Recovery isn't available on this network yet" TITLE is
      // also rendered for a sanctions-flagged wallet. Matching only the
      // title would let a wallet-specific block be reported as
      // "oracle UNSET", asserting a configuration fact the run never
      // established. So the oracle arm keys on the SCREENING-SERVICE body
      // copy, and a wallet-specific block is reported as its own posture.
      const oracleUnset =
        /screening service|isn[''\u2019]t configured on this network|not configured on this network/i.test(
          txt,
        );
      const walletBlocked = /your wallet|this wallet|flagged|sanction/i.test(txt);
      const anyUnavailable =
        /(is|are)n[''\u2019]?t available|not available|unavailable/i.test(txt);

      if (oracleUnset) {
        // An unavailable posture that ALSO renders the form is the
        // regression this scenario exists to catch — the banner says
        // nothing can be recovered while the doomed form sits under it.
        return {
          ok: inputs === 0,
          actual: `oracle-unset=true, inputs=${inputs}`,
          note:
            inputs === 0
              ? 'unavailable posture with no form (correct for retail)'
              : 'REGRESSION: form rendered beneath the unavailable banner',
        };
      }
      if (anyUnavailable && walletBlocked) {
        // NOT A PASS. The wallet-specific block renders the same
        // "unavailable" title the oracle-unset posture does, so this
        // scenario cannot tell them apart — and its whole purpose is to
        // observe the ORACLE setting. Reporting PASS here would have the
        // run assert it checked something it demonstrably did not, with
        // the note underneath saying so. Re-run against an unflagged
        // wallet to actually verify it.
        return {
          unverified: true,
          ok: false,
          actual: `wallet-specific block, inputs=${inputs} — oracle posture NOT observed`,
          note: 'blocked for THIS wallet; the oracle setting is unverified. Re-run with an unflagged wallet.',
        };
      }
      return {
        ok: inputs > 0,
        actual: `oracle-unset=false, unavailable=${anyUnavailable}, inputs=${inputs}`,
        note:
          inputs > 0
            ? 'form rendered — implies an oracle IS configured; confirm that is intended'
            : 'neither a posture nor a form after polling — inspect',
      };
    },
  },

  // ─── lender ────────────────────────────────────────────────────────
  {
    id: 'L1',
    role: 'lender',
    goal: 'Lending entry point is usable once connected',
    route: '/lend',
    desired: 'Lend surface renders form/controls, not an empty shell.',
    async check(page) {
      const txt = await bodyText(page);
      const controls = await controlCount(page);
      return {
        ok: txt.length > 150 && controls >= 3,
        actual: `body=${txt.length} chars, ${controls} control(s)`,
      };
    },
  },
  {
    id: 'L2',
    role: 'lender',
    goal: 'Rate Desk reachable by URL even though nav hides it in Basic mode',
    route: '/desk',
    desired: 'Renders (URL-reachable is the documented contract for #1129).',
    async check(page) {
      const txt = await bodyText(page);
      return {
        ok: txt.length > 150 && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `body=${txt.length} chars`,
      };
    },
  },
  {
    id: 'L3',
    role: 'lender',
    goal: 'Vault shows the connected identity, not a stranger',
    route: '/vault',
    desired: 'Renders vault surface for the connected wallet.',
    async check(page) {
      const txt = await bodyText(page);
      return { ok: txt.length > 100, actual: `body=${txt.length} chars` };
    },
  },

  // ─── borrower ──────────────────────────────────────────────────────
  {
    id: 'B1',
    role: 'borrower',
    goal: 'Borrowing entry point is usable once connected',
    route: '/borrow',
    desired: 'Borrow surface renders form/controls.',
    async check(page) {
      const txt = await bodyText(page);
      const controls = await controlCount(page);
      return {
        ok: txt.length > 150 && controls >= 3,
        actual: `body=${txt.length} chars, ${controls} control(s)`,
      };
    },
  },
  {
    id: 'B2',
    role: 'borrower',
    goal: 'Claim Center reachable',
    route: '/claims',
    desired: 'Renders claims surface or an explanatory empty state.',
    async check(page) {
      const txt = await bodyText(page);
      return { ok: txt.length > 100, actual: `body=${txt.length} chars` };
    },
  },
  {
    id: 'B3',
    role: 'borrower',
    goal: 'Faucet is discoverable so a new testnet user can self-serve',
    route: '/faucet',
    desired: 'Renders mint controls.',
    async check(page) {
      const txt = await bodyText(page);
      const controls = await controlCount(page, 'button');
      return {
        ok: txt.length > 150 && controls >= 1,
        actual: `body=${txt.length} chars, ${controls} button(s)`,
      };
    },
  },
  {
    id: 'B4',
    role: 'borrower',
    goal: 'NFT rental surface reachable',
    route: '/rent',
    desired: 'Renders rental surface, not NotFound.',
    async check(page) {
      const txt = await bodyText(page);
      return {
        ok: txt.length > 100 && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `body=${txt.length} chars`,
      };
    },
  },
];

/**
 * The ROUTED content, not the whole document.
 *
 * `body` includes the persistent shell — navigation, mode switch,
 * wallet controls, footer — which on its own clears every body-length
 * and control-count threshold in this file. Scoping to the shell's main
 * landmark means a check describes the surface under review rather than
 * the chrome around it (review round 7 P2). Falls back to `body` when
 * the landmark is absent, so a page outside the shell still reads.
 */
async function bodyText(page) {
  const main = page.locator('#main-content');
  if ((await main.count().catch(() => 0)) > 0) {
    return (await main.innerText().catch(() => '')) || '';
  }
  return (await page.locator('body').innerText().catch(() => '')) || '';
}

/**
 * Interactive controls in the ROUTED content, for the same reason
 * `bodyText` is scoped (review round 8 P2): scoping the text and
 * leaving the control counts on the whole document only half-fixed it.
 * `AppShell`'s topbar, mode switch and wallet controls clear a
 * `>= 3` threshold on their own, so `/lend` could lose its entire form
 * and still pass as long as the remaining routed copy ran long enough.
 */
async function controlCount(page, selector = 'input, select, button') {
  const scoped = page.locator(`#main-content ${selector}`);
  if ((await page.locator('#main-content').count().catch(() => 0)) > 0) {
    return await scoped.count().catch(() => 0);
  }
  return await page.locator(selector).count().catch(() => 0);
}

/**
 * True when the Terms gate has replaced the route WITHOUT changing the
 * URL.
 *
 * A connected wallet that has not accepted the current Terms gets the
 * gate's card in place of the routed surface. Scoping to `#main-content`
 * is not enough to see that, because the gate renders THERE — so a
 * gated `/lend` still satisfies "renders controls" using the gate's own
 * heading and its accept button, and the journey reports PASS having
 * never exercised lending.
 *
 * A legitimate posture, not a product failure: the scenario simply did
 * not run, which is what UNVERIFIED is for.
 */
async function gateMasked(page) {
  // A DOM MARKER, NOT A WORD. The first version of this matched
  // /terms/i against the routed text, which fired on `/lend`, `/borrow`
  // and `/desk` — whose ordinary copy says "terms you choose" — and
  // reported three healthy surfaces as unverified. Every gate state
  // renders inside `.legal-gate`, so the container is the fact; the
  // word is a coincidence, and writing the check from what the copy
  // probably says rather than from what the component renders is the
  // same mistake that produced a false `/recover` failure earlier.
  return (await page.locator('.legal-gate').count().catch(() => 0)) > 0;
}
async function firstHeading(page) {
  return (
    (await page.locator('h1').first().innerText().catch(() => '')) || ''
  ).replace(/\s+/g, ' ').slice(0, 60);
}
async function countMatches(page, re) {
  const txt = await bodyText(page);
  return (txt.match(re) || []).length;
}

const ROLE_POSTURE = {
  // A first-time arrival: no announced account, and requestAccounts refused.
  // KEYLESS, so no `window.ethereum` is installed and no EIP-6963
  // provider is announced (review round 8 P2). `preAuthorized: false`
  // alone still INSTALLS a wallet and merely has it report no accounts —
  // which is a user who has an extension and has not connected it, not
  // the first arrival this posture is described as. The app's
  // no-provider branches were never reached, so a regression confined to
  // visitors without a wallet extension passed this driver silently.
  visitor: { keyless: true, preAuthorized: false, allowRequestAccounts: false },
  lender: { role: 'lender', preAuthorized: true, allowRequestAccounts: true },
  borrower: { role: 'borrower', preAuthorized: true, allowRequestAccounts: true },
};

/** Applied to EVERY posture. Not a per-role option on purpose: a driver
 *  that can be made to sign by editing one table entry has no read-only
 *  guarantee, only a read-only default. */
const READ_ONLY = { readOnly: true };

const wanted = (process.env.JOURNEY_ROLES ?? 'visitor,lender,borrower')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// An empty normalized selection means the advertised review ran NOTHING.
// Exiting 0 there reports green for a run that verified nothing at all,
// which a mistyped CI variable would produce silently.
if (wanted.length === 0) {
  console.error(
    'BLOCKED: JOURNEY_ROLES normalized to no roles. ' +
      `Known roles: ${Object.keys(ROLE_POSTURE).join(', ')}`,
  );
  process.exit(2);
}

for (const r of wanted) {
  if (!ROLE_POSTURE[r]) {
    console.error(`BLOCKED: unknown role "${r}" — known: ${Object.keys(ROLE_POSTURE).join(', ')}`);
    process.exit(2);
  }
}

// ONE reachability probe for the WHOLE RUN, not one per role (review
// round 2 P2). `visit()` calls the shared BLOCKED exit directly on a
// timeout or HTTP error — correct before anything has been observed,
// and wrong afterwards. Declared per-role, `probed` reset on every
// launch, so the lender's or borrower's first navigation went through
// `visit()` again: a 500 there terminated the process with exit 2 and
// threw away product failures the visitor scenarios had already found,
// which is the precise inversion of the failure-over-blocked precedence
// this driver applies at the end.
//
// Run-scoped, so exactly the first served page of the run can report
// BLOCKED and every navigation after it is a guarded goto.
let probed = false;

/** Connection dialogs currently on screen.
 *
 *  No visitor scenario clicks anything, so a dialog present once a
 *  scenario has settled was opened by the page itself.
 *
 *  THE SELECTOR IS CALIBRATED, NOT INFERRED (review round 17 P2). The
 *  first version of this check looked for
 *  `[aria-modal="true"], [data-testid="connectkit-modal"]`, and the
 *  installed ConnectKit (1.9.2) renders NEITHER: its build contains no
 *  `aria-modal` at all and no `data-testid` anywhere, and its
 *  `ModalContainer` carries `role="dialog"`. So the check matched
 *  nothing and reported "no modal" with the picker wide open — an
 *  inert assertion, which is worse than the absent one it replaced,
 *  because the report then reads as proof.
 *
 *  Measured against the deployed app rather than reasoned about:
 *
 *    clean load          [aria-modal|data-testid] -> 0   [role=dialog] -> 0
 *    after clicking connect                       -> 0                 -> 1
 *
 *  `aria-modal` is kept alongside it so a dialog from any other source
 *  still counts; `role="dialog"` is the one that actually fires.
 *
 *  Re-calibrate this if ConnectKit is upgraded. A wallet-modal locator
 *  that silently stops matching cannot be distinguished from a clean
 *  run by anything except running it with the modal open.
 *
 *  Swallows its own failure to zero deliberately: this is a supporting
 *  observation taken after every scenario, and a locator error on one
 *  must not fail a scenario that was otherwise fine. */
async function modalCount(page) {
  return page
    .locator('[role="dialog"], [aria-modal="true"]')
    .count()
    .catch(() => 0);
}

/** Navigates, as a precondition on the very first page and as an
 *  ordinary product assertion from then on. Throws on HTTP >= 400 so
 *  the caller records it against the route it happened on. */
async function navigate(page, route) {
  const want = new URL(`${SITE}${route}`).pathname.replace(/\/+$/, '') || '/';
  if (!probed) {
    await visit(page, route);
    probed = true;
    // RETURN THE WANTED PATH HERE TOO (review round 7 P2). This branch
    // used to return nothing, so the caller's post-settle landing check
    // was skipped for the FIRST scenario of the run — and `visit()`
    // checks only HTTP status. A `/` redirected by the edge or a client
    // guard to another substantive page still cleared V1's body-length
    // and action thresholds, so the one scenario that establishes the
    // site is reachable was also the one that could not tell whether it
    // had reached the right place.
    return want;
  }
  const resp = await page.goto(`${SITE}${route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const status = resp?.status();
  if (typeof status === 'number' && status >= 400) {
    throw new Error(`${route} answered HTTP ${status}`);
  }
  // A 200 IS NOT PROOF THE REQUESTED ROUTE RENDERED (review round 5 P2).
  // A route redirected away — by the edge, or client-side by a guard on
  // mount — answers 200 from wherever it landed. Every check below reads
  // body text and control counts, so a redirect to `/` sails through the
  // length thresholds on homepage content while the surface under review
  // was never shown: a green report for a scenario that did not run.
  //
  // Both hops, because they fail differently and are visible at
  // different moments: the RESPONSE url is where the document was
  // committed (an edge redirect), and the PAGE url after the settle is
  // where the app ended up (a React Router redirect, which never moves
  // the response url). `live-ux-sweep.mjs` checks the same two.
  //
  // Compared on pathname only: a scenario may legitimately request a
  // fragment (`/vpfi#deposit`), and the app may normalise or drop it.
  const servedPath = (() => {
    try {
      return new URL(resp?.url() ?? '').pathname.replace(/\/+$/, '') || '/';
    } catch {
      return null;
    }
  })();
  if (servedPath !== null && servedPath !== want) {
    throw new Error(`${route} was redirected to ${servedPath} before rendering`);
  }
  return want;
}

/** Where the app actually sat after settling. Read AFTER the per-scenario
 *  settle, because a client-side redirect happens on mount and is
 *  invisible to the response url. */
function landedPathOf(page) {
  try {
    return new URL(page.url()).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

const results = [];
const setupFailures = [];
let hardFail = 0;
// A THIRD VERDICT, because two were not enough (review round 4 P2).
// R1 can land in a posture where the page is correct and the scenario
// still learned nothing: a sanctions-flagged wallet gets the same
// "recovery isn't available" title the oracle-unset case produces, so
// "no form rendered" is true and says nothing about the oracle setting
// the scenario exists to check. Recording that as PASS let the run
// claim it had verified something it had not — and the note beside it
// already admitted as much, which is a verdict contradicting its own
// evidence. FAIL is equally wrong: nothing is broken.
let unverified = 0;

for (const roleKey of wanted) {
  const scenarios = SCENARIOS.filter((s) => s.role === roleKey);
  if (!scenarios.length) continue;

  const posture = ROLE_POSTURE[roleKey];
  // Per ROLE, not per run: each role gets its own browser, and the
  // session record below is emitted per role.
  const modalSightings = [];
  // `onSetupFailure: 'throw'` because this driver ACCUMULATES findings
  // across three launches. The default exits 2 immediately, which after a
  // visitor regression has already been recorded would discard it and
  // report the whole run as BLOCKED — claiming nothing was verified when
  // something was, and something was wrong.
  let session;
  try {
    session = await launch({
      ...posture,
      ...READ_ONLY,
      freshProfile: true,
      onSetupFailure: 'throw',
    });
  } catch (err) {
    if (err instanceof LiveSetupError) {
      setupFailures.push(`${roleKey}: ${err.message}`);
      console.log(`BLOCKED-SETUP  [${roleKey}] ${err.message}`);
      continue;
    }
    throw err;
  }
  const { page, done, blockedRequests, consoleErrors } = session;

  if (posture.preAuthorized) {
    // preAuthorized alone does not prove wagmi ACCEPTED the provider. If
    // connector rehydration regresses, several connected-role checks
    // still pass against public or connect-prompt content, because they
    // count body text and generic buttons. Prove the connection first.
    try {
      await navigate(page, '/');
      await ensureConnected(page);
      await page.waitForTimeout(1_200);
      const connected = !(await page
        .getByRole('button', { name: /connect wallet/i })
        .first()
        .isVisible()
        .catch(() => false));
      if (!connected) {
        hardFail += 1;
        results.push({
          id: `CONN-${roleKey}`,
          roleKey,
          role: roleKey,
          route: '/',
          goal: 'The connected role is actually connected before its scenarios run',
          desired: 'The Connect CTA is gone, proving wagmi accepted the injected provider.',
          ok: false,
          actual: 'Connect CTA still visible — scenarios below did NOT exercise a connected session.',
        });
        console.log(
          `FAIL  CONN-${roleKey}  [${roleKey}] /\n` +
            '      goal    : connected role is actually connected\n' +
            '      actual  : Connect CTA still visible',
        );
        // STOP THIS ROLE HERE (review round 8 P2). Having just
        // established the session is NOT connected, running the
        // connected scenarios anyway exercises the wrong posture: some
        // pass on public or connect-prompt content and others fail for
        // reasons that have nothing to do with the surface under review,
        // so the report fills with verdicts about a session that does
        // not exist. The thrown-error path already closes and moves on;
        // this branch fell through.
        await done();
        continue;
      }
    } catch (err) {
      // A FAILED CONNECTION IS A PRODUCT FAILURE, NOT A SETUP ONE
      // (review round 3 P2). `ensureConnected()` throwing means the
      // deployed app did not accept an injected provider that was
      // announced and pre-authorized — which is the precise regression
      // this preflight was added to detect. Routing it into
      // `setupFailures` reported the whole run as BLOCKED whenever the
      // rest of it was clean, so the finding arrived dressed as an
      // infrastructure problem and pointed the operator at their own
      // environment instead of at the app.
      //
      // BLOCKED stays reserved for what it means: the browser or profile
      // could not be created at all, which is decided in `launch()`
      // above and reaches this loop as a `LiveSetupError`.
      const why = String(err.message || err).slice(0, 120);
      hardFail += 1;
      results.push({
        id: `CONN-${roleKey}`,
        roleKey,
        role: roleKey,
        route: '/',
        goal: 'The connected role is actually connected before its scenarios run',
        desired: 'wagmi accepts the announced, pre-authorized provider.',
        ok: false,
        actual: `connection never established: ${why}`,
      });
      console.log(
        `FAIL  CONN-${roleKey}  [${roleKey}] /\n` +
          '      goal    : connected role is actually connected\n' +
          `      actual  : connection never established: ${why}`,
      );
      await done();
      continue;
    }
  }

  for (const s of scenarios) {
    let ok = false;
    let actual = '';
    let note = '';
    let unverifiable = false;
    try {
      const wantPath = await navigate(page, s.route);
      // Per-scenario settle: a surface whose state arrives from an async
      // chain/config read needs longer than one that renders from props.
      // A scenario may replace it with a bounded poll (see R1).
      if (s.settle) await s.settle(page);
      else await page.waitForTimeout(s.settleMs ?? 1800);
      // SAMPLED PER SCENARIO, because a modal does not survive to the
      // end of the role (review round 16 P2). Every scenario navigates
      // with `page.goto`, a full document navigation that tears down any
      // ConnectKit portal the previous route opened — so a single sample
      // after the last scenario can only ever see a modal opened by the
      // last route, and the six before it were never examined. The
      // session record below asserts a property of the WHOLE journey;
      // this is what actually collects the evidence for it.
      if (!posture.preAuthorized && (await modalCount(page)) > 0) {
        modalSightings.push(s.id);
      }
      // Checked HERE rather than in `navigate`: a client-side guard
      // redirects on mount, so before the settle the app may not have
      // moved yet.
      const landed = landedPathOf(page);
      if (wantPath && landed !== null && landed !== wantPath) {
        throw new Error(`redirected to ${landed} after mount — ${s.route} never rendered`);
      }
      // The URL can be right and the surface still absent: see
      // `gateMasked`. Neither pass nor fail — the journey did not run.
      if (posture.preAuthorized && (await gateMasked(page))) {
        unverifiable = true;
        actual = 'the Terms gate replaced this route — the surface never mounted';
        note = 'legitimate posture, but this scenario verified nothing. Accept the current Terms with the dev wallet and re-run.';
      } else {
        const r = await s.check(page);
        ok = r.ok;
        actual = r.actual;
        note = r.note ?? '';
        unverifiable = r.unverified === true;
      }
    } catch (err) {
      actual = `ERROR: ${String(err.message || err).slice(0, 120)}`;
    }
    if (unverifiable) unverified += 1;
    else if (!ok) hardFail += 1;
    results.push({
      ...s,
      roleKey,
      ok: unverifiable ? null : ok,
      unverified: unverifiable,
      actual,
      note,
      check: undefined,
    });
    console.log(
      `${unverifiable ? 'UNVERIFIED' : ok ? 'PASS' : 'FAIL'}  ${s.id}  [${roleKey}] ${s.route}\n` +
        `      goal    : ${s.goal}\n` +
        `      desired : ${s.desired}\n` +
        `      actual  : ${actual}${note ? `\n      note    : ${note}` : ''}`,
    );
  }

  // THE READ-ONLY GUARANTEE, CHECKED. `readOnly: true` makes the injected
  // wallet refuse write RPCs; this turns a refusal into a FAILED RUN.
  // Without it the driver would deny the write and carry on green, which
  // reports "these journeys are fine" about a build that tried to sign
  // unprompted — the single most important thing a read-only review could
  // have told you, silently swallowed.
  //
  // CLASSIFY BY EXCLUSION, NOT BY MATCHING (review round 2 P1). The
  // first version of this listed the reasons it expected to see —
  // `wallet rpc`, `sign`, `sendTransaction` — and a substring list is
  // the wrong shape for a guard. A bundle that bypasses the injected
  // provider and posts JSON-RPC over the network is recorded with
  // reasons like `json-rpc eth_sendRawTransaction`, `wallet_sendCalls`
  // or `eth_sendUserOperation`, and NOT ONE of those matched: the
  // request was denied, and the run still reported green. Every method
  // that ever gets added to the wallet's write set would have had to be
  // remembered here too, silently, forever.
  //
  // `blockedRequests` only ever holds things the driver REFUSED, so
  // there is nothing benign in it to filter for. Every entry is a
  // read-only violation. The one exception is the visitor's account
  // prompt, which is not a write and has its own check immediately
  // below — excluded only for that posture, so a prompt appearing where
  // no check owns it still fails here rather than falling through both.
  // UNCAUGHT PAGE ERRORS FAIL THE RUN (review round 6 P2). Every check
  // here is shallow by design — body length, control counts — so a route
  // that throws AFTER painting enough shell to clear those thresholds
  // reported PASS while the surface was broken underneath. `launch()`
  // has been collecting console errors and uncaught `pageerror` events
  // all along; this driver simply threw the array away, which is the
  // same shape of mistake as discarding `blockedRequests` was.
  //
  // ONE exclusion, and it is the HARNESS rather than the app. `driver.mjs`
  // serves every page request from this process via undici, because the
  // egress gateway resets Chromium's own TLS handshakes — and its comment
  // states plainly that WebSockets are NOT covered by that shim. So a
  // `wss://` connection failure here is this environment refusing the
  // transport, not the deployed build misbehaving, and without this the
  // check would fail every run for a reason the driver documents about
  // itself.
  //
  // This is deliberately NOT the start of an allowlist of "expected"
  // errors — a curated denylist is how a real one eventually gets waved
  // through. It excludes exactly one class, on the grounds that the
  // harness cannot support it, and the honest cost is recorded rather
  // than hidden: a genuine WebSocket regression in the app is invisible
  // to THIS driver and needs a run where the transport actually works.
  const HARNESS_WS = /WebSocket connection to .*failed/i;
  const pageErrors = (consoleErrors ?? []).filter((e) => !HARNESS_WS.test(String(e)));
  if (pageErrors.length > 0) {
    hardFail += 1;
    const shown = pageErrors.slice(0, 5).map((e) => String(e).slice(0, 160));
    results.push({
      id: `PAGEERR-${roleKey}`,
      roleKey,
      role: roleKey,
      route: '(session)',
      goal: 'The deployed build raises no uncaught errors during this role\'s journeys',
      desired: 'Zero console errors and zero uncaught pageerror events across the session.',
      ok: false,
      actual: `${pageErrors.length} error(s): ${shown.join(' | ')}`,
    });
    console.log(
      `FAIL  PAGEERR-${roleKey}  [${roleKey}] (session)\n` +
        `      goal    : no uncaught errors during this role's journeys\n` +
        `      actual  : ${pageErrors.length} error(s)\n` +
        shown.map((e) => `                - ${e}`).join('\n'),
    );
  }

  const isAccountPrompt = (b) =>
    /requestAccounts|requestPermissions/i.test(b.reason ?? '');
  const writeAttempts = (blockedRequests ?? []).filter(
    (b) => !(!posture.preAuthorized && isAccountPrompt(b)),
  );

  // A VISITOR must not be asked to connect unprompted — and with a
  // KEYLESS session the RPC check alone can no longer see that (review
  // round 15 P2). `keyless: true` installs no provider, so there is no
  // handler for `eth_requestAccounts` to reach and `blockedRequests`
  // always reports zero prompts for this role. The posture became more
  // honest about what a visitor's browser looks like and, in doing so,
  // lost the signal that caught a build opening the wallet UI by itself.
  //
  // So this now asks the question at the level the user experiences it:
  // is a connection dialog on screen that nobody asked for? ConnectKit
  // renders its picker into a portal with `aria-modal`, and no visitor
  // scenario clicks anything, so any modal present after a scenario
  // settles was opened by the page.
  if (!posture.preAuthorized) {
    if (modalSightings.length > 0) {
      hardFail += 1;
      results.push({
        id: `MODAL-${roleKey}`,
        roleKey,
        role: roleKey,
        route: '(session)',
        goal: 'A first-time visitor is not shown a wallet dialog they did not ask for',
        desired: 'No connection modal is open at any point during the visitor journeys.',
        ok: false,
        actual: `a connection modal was open after ${modalSightings.length} scenario(s) — ${modalSightings.join(', ')} — without any of them having clicked connect`,
      });
      console.log(
        `FAIL  MODAL-${roleKey}  [${roleKey}] (session)\n` +
          "      goal    : no unsolicited wallet dialog for a first arrival\n" +
          `      actual  : modal open after ${modalSightings.join(', ')}`,
      );
    }
  }

  // The RPC-level check still runs for any posture that DOES install a
  // provider, and stays as the stronger signal where it applies: the
  // driver rejects `eth_requestAccounts` / `wallet_requestPermissions`,
  // but the page can catch that rejection and still satisfy every
  // assertion — leaving a green first-arrival report for a build that
  // would have thrown a wallet dialog at a real newcomer.
  if (!posture.preAuthorized) {
    const prompts = (blockedRequests ?? []).filter(isAccountPrompt);
    if (prompts.length > 0) {
      hardFail += 1;
      results.push({
        id: `PROMPT-${roleKey}`,
        roleKey,
        role: roleKey,
        route: '(session)',
        goal: 'A first-time visitor is never asked for accounts unprompted',
        desired: 'Zero eth_requestAccounts / wallet_requestPermissions during the visitor run.',
        ok: false,
        actual: `${prompts.length} unsolicited account request(s)`,
      });
      console.log(
        `FAIL  PROMPT-${roleKey}  [${roleKey}] (session)\n` +
          '      goal    : a first-time visitor is never asked for accounts unprompted\n' +
          `      actual  : ${prompts.length} unsolicited account request(s)`,
      );
    }
  }
  if (writeAttempts.length > 0) {
    hardFail += 1;
    const detail = writeAttempts.map((b) => b.reason).join('; ');
    results.push({
      id: `RO-${roleKey}`,
      roleKey,
      role: roleKey,
      route: '(session)',
      goal: 'No surface attempts a signature or transaction during a read-only review',
      desired: 'Zero write RPCs reach the injected wallet across every scenario.',
      ok: false,
      actual: `${writeAttempts.length} blocked write attempt(s): ${detail}`,
      note: 'Denied at the provider, so nothing was signed — but a page tried.',
    });
    console.log(
      `FAIL  RO-${roleKey}  [${roleKey}] (session)\n` +
        `      goal    : No signature or transaction attempts during a read-only review\n` +
        `      desired : Zero write RPCs reach the injected wallet\n` +
        `      actual  : ${writeAttempts.length} blocked attempt(s): ${detail}`,
    );
  }

  await done();
}

console.log(
  `\n=== ${SITE} — ${results.length} scenario(s), ` +
    `${results.length - hardFail - unverified} pass, ${hardFail} fail` +
    `${unverified ? `, ${unverified} unverified` : ''} ===`,
);
if (unverified) {
  console.log(
    `  ${unverified} scenario(s) could not be verified — counted as neither ` +
      'pass nor fail. See their notes; they are not evidence of correctness.',
  );
}

if (process.env.JOURNEY_JSON) {
  // The usage example advertises `out/report.json`. Without this, every
  // scenario can pass and the driver then dies on ENOENT, producing exit
  // 1 and no report — a green run reported as a failure.
  mkdirSync(dirname(process.env.JOURNEY_JSON), { recursive: true });
  writeFileSync(
    process.env.JOURNEY_JSON,
    JSON.stringify(
      { site: SITE, at: new Date().toISOString(), results, setupFailures },
      null,
      2,
    ),
  );
  console.log(`report → ${process.env.JOURNEY_JSON}`);
}

// FAILURE OUTRANKS BLOCKED. A real regression found before a later role's
// setup broke is still a regression, and reporting it as "we could not
// check" would bury it. Only a run that found nothing wrong AND could not
// complete is BLOCKED (exit 2).
if (setupFailures.length) {
  console.log(`\nsetup failures: ${setupFailures.length}\n  ${setupFailures.join('\n  ')}`);
}
// UNVERIFIED REACHES THE EXIT CODE (review round 5 P2). Adding the
// verdict to the printed summary and not to `process.exit` left the
// batch runner reporting PASS for a run whose own output said a
// scenario was "not evidence of correctness" — the same contradiction
// the verdict was introduced to remove, moved one layer out. A run that
// could not verify something it set out to verify is BLOCKED, not
// green; a real failure still outranks it.
if (hardFail > 0) process.exit(1);
process.exit(setupFailures.length || unverified ? 2 : 0);
