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
/** Routes `src/contracts/tosExitRoutes.ts` exempts from the Terms gate.
 *
 *  Duplicated rather than imported because this driver is plain ESM and
 *  the source of truth is TypeScript compiled into the app bundle. The
 *  duplication is deliberate and narrow: a route dropped from the real
 *  list and left here makes this driver fail LOUDLY on a route that is
 *  now legitimately gated, which is the safe direction for a check whose
 *  whole purpose is refusing to accept a gate on an exit. */
const TOS_EXEMPT_ROUTES = new Set(['/claims', '/vault', '/recover', '/desk']);

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
  vaultTitle: EN.copy.vault.title,
  claimsTitle: EN.copy.claims.title,
  faucetTitle: EN.copy.faucet.title,
  rentTitle: EN.copy.rent.title,
  deskTitle: EN.copy.desk.title,
  dataRightsTitle: EN.copy.dataRights.title,
  lendTitle: EN.copy.lend.title,
  borrowTitle: EN.copy.borrow.title,
  helpTitle: EN.copy.help.title,
  notFoundTitle: EN.copy.notFound.title,
};

/** The route's own `h1`, trimmed. Empty string when absent. */
async function headingOf(page) {
  return (
    (await page.locator('#main-content h1').first().textContent().catch(() => ''))?.trim() ?? ''
  );
}

/**
 * "This route rendered ITS OWN surface", the reusable form of what the
 * offer-book scenario needed (review round 16 P2, extended round 18).
 *
 * A `body.length > N` predicate cannot tell the intended page from a
 * connect wall, a redirect, or a not-found — all of which clear any
 * plausible threshold. Several scenarios stated a page by name in their
 * `desired` and then tested only length, so they could not have failed
 * if the route had started rendering something else entirely.
 *
 * The expected heading comes from the app's own catalog, never restated
 * here, so renaming a page fails the assertion instead of leaving it
 * passing against text the product no longer uses.
 */
async function rendersPage(page, expectedTitle) {
  const heading = await headingOf(page);
  return {
    ok: heading === expectedTitle,
    actual: `h1=${JSON.stringify(heading.slice(0, 40))} (want ${JSON.stringify(expectedTitle)})`,
  };
}

/**
 * Is this surface still loading, and what has it rendered so far?
 *
 * Round 19 caught the first half: `.empty-state` is not evidence of a
 * settled page, because the loading posture renders the same component
 * with a spinner, so "rows or an empty state" accepted a request that
 * never came back.
 *
 * Round 20 caught the fix's own mistake, and it is the more instructive
 * one. That version decided SETTLED by enumerating the shapes it
 * expected — rows, or a finished empty state — and the Claim Center has
 * a third: with rewards pending and no loan claimables it deliberately
 * suppresses its empty state and shows the rewards card instead
 * (`Claims.tsx`, `hasOtherClaimable ? null :`). That is a perfectly
 * settled page with neither marker, so the check polled for fifteen
 * seconds and called a healthy surface stuck. Having just fixed
 * "reports stuck as healthy", it introduced "reports healthy as stuck"
 * — the same error, opposite sign, because a guessed list of settled
 * shapes is never exhaustive.
 *
 * So this reports LOADING, which has exactly one shape and is knowable,
 * and leaves each scenario to say what content it additionally
 * requires. `.empty-state .spin` and not `.spin` anywhere: the latter
 * also marks a busy button, so a page mid-transaction would read as
 * loading.
 */
async function settledState(page) {
  const scope = '#main-content';
  const rows = await page.locator(`${scope} .row-list`).count().catch(() => 0);
  const empties = await page.locator(`${scope} .empty-state`).count().catch(() => 0);
  // The LOADING PLACEHOLDER specifically — `.empty-state .spin`, not
  // `.spin` anywhere. `.spin` also marks a busy BUTTON mid-action
  // (`ClaimAllCard`, `ConfirmReceipt`, `Claims.tsx:119`), so a page
  // where someone is confirming a transaction would otherwise read as
  // still loading.
  // AN ERROR MUST NOT READ AS "NOT LOADING". `.catch(() => 0)` here
  // would send an unobservable page down the PASSING branch, which is
  // the inert-check shape this file has now been caught in twice. `null`
  // means "could not observe", and the caller treats that as not
  // settled — the failing direction, which is the safe one for a signal
  // whose whole job is to catch a page that never finished.
  const spins = await page
    .locator(`${scope} .empty-state .spin`)
    .count()
    .catch(() => null);
  const loading = spins === null || spins > 0;
  // The Claim Center's THIRD settled shape, now marked rather than
  // inferred (review round 21 P2). Round 20 accepted
  // `{rows: 0, empties: 0, loading: false}` on the theory that it meant
  // "the rewards card is showing" — but a subtree that regressed to
  // rendering nothing produces exactly that shape too, so the fix
  // restored the false green through a different door. `RewardsCard`
  // now carries `data-testid="rewards-card"` on every branch that
  // renders, so this is an observation instead of a deduction.
  const rewards = await page.locator(`${scope} [data-testid="rewards-card"]`).count().catch(() => 0);
  return { rows, empties, rewards, loading, content: rows + empties + rewards };
}

/**
 * Bounded poll for the above, rather than trusting the fixed settle.
 *
 * The per-scenario settle is sized for a surface that renders from
 * props; one whose state arrives over the network can legitimately take
 * longer, and failing it for being slow would be as wrong as passing it
 * for being stuck. Bounded so a genuinely stuck page still fails.
 */
async function waitSettled(page, ms = 15_000) {
  const deadline = Date.now() + ms;
  let st = await settledState(page);
  while (st.loading && Date.now() < deadline) {
    await page.waitForTimeout(500);
    st = await settledState(page);
  }
  return st;
}

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
      // INTERACTIVE ELEMENTS, NOT PROSE (review round 22 P2). This
      // counted regex matches over the page TEXT, so a landing page that
      // lost every link and button while keeping explanatory copy about
      // lending still passed — the one scenario whose point is "offers a
      // way in" could not tell a way in from a description of one.
      const txt = await bodyText(page);
      const actions = await page
        .locator(
          '#main-content a[href="/lend"], #main-content a[href="/borrow"], ' +
            '#main-content a[href="/offers"], #main-content button',
        )
        .count()
        .catch(() => 0);
      return {
        ok: txt.length > 200 && actions > 0,
        actual: `body=${txt.length} chars, ${actions} actionable element(s)`,
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
      const heading = await headingOf(page);
      const gated = await gateMasked(page);
      const isBookHeading = heading === EXPECTED.offersTitle;
      // SAME LOADING HOLE AS THE CLAIM CENTER (review round 19 P2): the
      // book's loading posture is an `.empty-state` too, so "rows or an
      // empty state" accepted a request that never returned.
      const st = await waitSettled(page);
      const rows = st.rows;
      const empty = st.empties;
      // The book's postures ARE exhaustively `.row-list` or
      // `.empty-state` (rows / filtered-empty / empty / unavailable /
      // loading), unlike the Claim Center's — so requiring one here is
      // sound where requiring it there was not.
      const book = !st.loading && (rows > 0 || empty > 0);
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
    desired:
      'The HELP page renders and is substantially populated (>500 chars). ' +
      'Length alone would accept any other verbose surface served at this ' +
      'URL — including the landing page or a wordy error.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.helpTitle);
      const txt = await bodyText(page);
      return {
        ok: r.ok && txt.length > 500,
        actual: `${r.actual}, body=${txt.length} chars`,
      };
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
      const r = await rendersPage(page, EXPECTED.dataRightsTitle);
      return {
        ok: r.ok && txt.length > 200 && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `${r.actual}, body=${txt.length} chars`,
      };
    },
  },
  {
    id: 'V6',
    role: 'visitor',
    goal: 'An unknown URL fails honestly',
    route: '/definitely-not-a-real-route',
    desired:
      "The app's OWN not-found page renders — identified by its heading, " +
      'not by the words "not found" appearing somewhere on whatever ' +
      'surface answered.',
    async check(page) {
      // Was a body regex for /not found|404/. Any OTHER error surface —
      // a crash boundary, a gateway page — can carry those words while
      // the app's NotFound never rendered, so the check passed on the
      // one outcome it exists to distinguish. `NotFound.tsx` renders a
      // catalog-backed h1 (`titleAs="h1"`, `copy.notFound.title`), so
      // page identity is available and is what the scenario claims to
      // test. Same correction as `/help` in an earlier round.
      const heading = await headingOf(page);
      const txt = await bodyText(page);
      // `.ok`, not the object (round 28 P2). `rendersPage` returns
      // `{ ok, actual }`, and assigning the whole thing here made the
      // verdict truthy no matter what the heading was — the correction
      // to the old body regex silently un-checked the very thing it was
      // written to check, and PASSed on the failure it exists to catch.
      const { ok } = await rendersPage(page, EXPECTED.notFoundTitle);
      return {
        ok,
        actual: `h1=${JSON.stringify(heading)} (want ${JSON.stringify(
          EXPECTED.notFoundTitle,
        )}), body=${txt.length} chars`,
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
      // NOT A PASS EITHER (review round 21 P2). This returned PASS on
      // `inputs > 0`, reasoning that a form implies a configured oracle
      // — which INFERS the configuration fact from the very UI this
      // scenario exists to check against it. The retail default is an
      // unset oracle, so the case that matters is a regression rendering
      // the form WITHOUT the unavailable copy: a guaranteed-to-fail
      // recovery form, reported green, with the note underneath calling
      // it confirmation.
      //
      // The oracle setting is not observable from this page, and reading
      // it on-chain is outside a read-only UI drive. So the honest
      // verdict is UNVERIFIED — the scenario ran and established
      // nothing — which the run already propagates to exit 2 rather than
      // burying in a note nobody reads on a green line.
      return {
        unverified: true,
        ok: false,
        actual: `oracle-unset=false, unavailable=${anyUnavailable}, inputs=${inputs} — oracle posture NOT observed`,
        note:
          inputs > 0
            ? 'a form rendered with no unavailable copy. That is EITHER a configured oracle OR the regression this scenario watches for, and the page cannot tell them apart. Read the oracle setting on-chain to resolve it.'
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
    desired:
      'The LEND page renders, and it renders form/controls rather than an ' +
      'empty shell. Control count alone did not say which page they were on.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.lendTitle);
      const controls = await controlCount(page);
      return {
        ok: r.ok && controls >= 3,
        actual: `${r.actual}, ${controls} control(s)`,
      };
    },
  },
  {
    id: 'L2',
    role: 'lender',
    goal: 'Rate Desk reachable by URL even though nav hides it in Basic mode',
    route: '/desk',
    desired:
      'The Rate Desk itself renders (URL-reachable is the documented ' +
      'contract for #1129) — not a redirect to whatever Basic mode shows ' +
      'instead, which a length check cannot tell apart from the real page.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.deskTitle);
      const txt = await bodyText(page);
      return { ...r, actual: `${r.actual}, body=${txt.length} chars` };
    },
  },
  {
    id: 'L3',
    role: 'lender',
    // The goal says what is OBSERVED, not what one might wish to
    // observe (review round 19 P2). It read "Vault shows the connected
    // identity, not a stranger" while the page displays no address at
    // all — so every PASS printed and serialized a claim the check had
    // just been corrected to stop making.
    goal: 'Vault surface renders for an already-connected session',
    route: '/vault',
    desired:
      'The vault surface itself renders for a session that is already ' +
      'connected. NOTE what this does NOT assert: the page displays no ' +
      'address, so there is nothing on it to check a wallet against. The ' +
      'connection is established at session level instead — the role fails ' +
      'before any scenario runs if `ensureConnected` leaves a connect ' +
      'prompt on screen. Said plainly because the earlier wording claimed ' +
      'to verify the connected wallet while testing only body length.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.vaultTitle);
      const txt = await bodyText(page);
      return { ...r, actual: `${r.actual}, body=${txt.length} chars` };
    },
  },

  // ─── borrower ──────────────────────────────────────────────────────
  {
    id: 'B1',
    role: 'borrower',
    goal: 'Borrowing entry point is usable once connected',
    route: '/borrow',
    desired:
      'The BORROW page renders, and it renders form/controls. Same reason ' +
      'as the lend scenario: a control count does not identify a page.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.borrowTitle);
      const controls = await controlCount(page);
      return {
        ok: r.ok && controls >= 3,
        actual: `${r.actual}, ${controls} control(s)`,
      };
    },
  },
  {
    id: 'B2',
    role: 'borrower',
    goal: 'Claim Center reachable',
    route: '/claims',
    desired:
      'The Claim Center renders, is not stuck loading, and shows ' +
      'SOMETHING — claimable rows, its own empty state, or the rewards ' +
      'card. All three are legitimate; rendering none of them is not, ' +
      'and an earlier revision accepted that silently by treating the ' +
      'reward-only shape as "no markers expected".',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.claimsTitle);
      const st = await waitSettled(page);
      return {
        ok: r.ok && !st.loading && st.content > 0,
        actual: `${r.actual}, rowList=${st.rows}, emptyState=${st.empties}, rewardsCard=${st.rewards}, loading=${st.loading}`,
        note: st.loading
          ? 'the Claim Center never left its loading state'
          : st.content === 0
            ? 'settled but rendered NOTHING — no rows, no empty state, no rewards card'
            : '',
      };
    },
  },
  {
    id: 'B3',
    role: 'borrower',
    goal: 'Faucet is discoverable so a new testnet user can self-serve',
    route: '/faucet',
    desired:
      'The faucet page itself renders AND offers mint controls. One ' +
      'button on some other page satisfied the old predicate.',
    async check(page) {
      // MINT ROWS, NOT ANY BUTTON (review round 19 P2). On a chain with
      // no mocks the faucet renders this very heading plus a
      // switch-network button and a "back home" link, so `h1` + at least
      // one control passed while offering nothing to mint. The mint UI is
      // a `.row-list`; its three no-mocks / empty postures are not.
      const r = await rendersPage(page, EXPECTED.faucetTitle);
      const st = await waitSettled(page);
      const controls = await controlCount(page, 'button');
      return {
        ok: r.ok && !st.loading && st.rows > 0 && controls >= 1,
        actual: `${r.actual}, mintRows=${st.rows}, loading=${st.loading}, ${controls} button(s)`,
        note: st.rows > 0 ? '' : 'the faucet rendered a fallback (wrong chain, or no mocks deployed) rather than mint controls',
      };
    },
  },
  {
    id: 'B4',
    role: 'borrower',
    goal: 'NFT rental surface reachable',
    route: '/rent',
    desired:
      'The rental surface itself renders. Rejecting NotFound is weaker ' +
      'than naming the page: any OTHER route would also have passed.',
    async check(page) {
      const r = await rendersPage(page, EXPECTED.rentTitle);
      const txt = await bodyText(page);
      return { ...r, actual: `${r.actual}, body=${txt.length} chars` };
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
  // Same rule as `settledState`: a locator error must not answer "no
  // gate", which is the direction that lets a gated page pass. Treat
  // unobservable as gated, so the scenario reports rather than assumes.
  const n = await page.locator('.legal-gate').count().catch(() => null);
  return n === null || n > 0;
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
 *  The REPORTING PATH is calibrated separately, because "the selector
 *  matches" and "a match becomes a failure" are different claims and
 *  the first does not imply the second. Injecting a `role="dialog"`
 *  element after every scenario settles produces:
 *
 *    FAIL  MODAL-visitor  modal open after V1, V2, V3, V4, V5, V6, V7
 *    8 scenario(s), 7 pass, 1 fail  → exit 1
 *
 *  Naming all seven rather than only the last is the point: that is the
 *  per-scenario sampling working, and a single end-of-role sample —
 *  what this replaced — could only ever have named V7.
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
      // A POSITIVE MARKER, not the absence of a label (review round 21
      // P2). This began as `!(connect-wallet button visible)`, so
      // anything that stopped that locator matching — a copy change to
      // "Connect" being the obvious case — was negated into "connected",
      // and the whole lender set would then run against a disconnected
      // app: `/lend` shows controls disconnected, and `/desk` and
      // `/vault` still render their headings, so nothing downstream
      // would have caught it.
      //
      // Round 22 then caught the first fix comparing the DISPLAYED
      // label: an ENS name matched on merely being non-empty, and a hex
      // chip on four nibbles, so a wrong wallet with a reverse name or a
      // 16-bit prefix collision still passed. The chip now carries
      // `data-address`, and this compares the account wagmi actually
      // bound rather than how it chose to render it.
      const chip = page.locator('.connect-addr').first();
      const chipText = ((await chip.textContent().catch(() => '')) ?? '').trim();
      const shown = ((await chip.getAttribute('data-address').catch(() => null)) ?? '')
        .trim()
        .toLowerCase();
      const want = (session.account?.address ?? '').toLowerCase();
      // THREE OUTCOMES, NOT TWO. A build that predates `data-address`
      // renders the chip without it, and treating that as "not
      // connected" would be a false failure on every run until the app
      // deploys — the mirror of the false pass this check exists to
      // stop. The chip itself still proves wagmi accepted the provider;
      // what cannot be established on such a build is WHICH account, so
      // that is reported as unverified rather than decided either way.
      const staleBuild = chipText.length > 0 && shown === '';
      const connected = want !== '' && shown === want;
      if (staleBuild) {
        unverified += 1;
        results.push({
          id: `CONN-${roleKey}`,
          roleKey,
          role: roleKey,
          route: '/',
          goal: 'The connected role is actually connected before its scenarios run',
          desired:
            "The header chip carries this role's account, which the app " +
            'only renders once wagmi has accepted the injected provider.',
          ok: null,
          unverified: true,
          actual: `the header chip renders ${JSON.stringify(chipText.slice(0, 30))} but exposes no account marker — this build predates it, so WHICH account is bound could not be established`,
          note: 'a session is connected; the account behind it is unverified until the app carrying `data-address` is deployed',
        });
        console.log(
          `UNVERIFIED  CONN-${roleKey}  [${roleKey}] /\n` +
            '      goal    : connected role is actually connected\n' +
            '      actual  : chip present, no account marker (build predates it)',
        );
      } else if (!connected) {
        hardFail += 1;
        results.push({
          id: `CONN-${roleKey}`,
          roleKey,
          role: roleKey,
          route: '/',
          goal: 'The connected role is actually connected before its scenarios run',
          desired:
            "The header chip renders this role's account, which the app " +
            'only does once wagmi has accepted the injected provider.',
          ok: false,
          actual:
            shown === ''
              ? 'no connected-account marker — wagmi never accepted the provider, so the scenarios below did NOT exercise a connected session'
              : `the header is bound to ${shown.slice(0, 10)}…, not this role's account ${want.slice(0, 10)}… (chip reads ${JSON.stringify(chipText.slice(0, 30))})`,
        });
        console.log(
          `FAIL  CONN-${roleKey}  [${roleKey}] /\n` +
            '      goal    : connected role is actually connected\n' +
            `      actual  : bound=${shown.slice(0, 10) || '(none)'} want=${want.slice(0, 10)}`,
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
        if (TOS_EXEMPT_ROUTES.has(s.route)) {
          // ROUND 47 P2 — a gate HERE is a product regression, not a
          // posture. `src/contracts/tosExitRoutes.ts` exempts these
          // routes on purpose: claims, the vault, stuck-token recovery
          // and the desk are how a user gets their money OUT, and the
          // functional spec requires them to stay reachable for someone
          // who has not accepted a pending Terms revision. Paperwork
          // must not stand between somebody and funds they are owed.
          //
          // Reporting it as unverified was worse than not checking:
          // the note told the operator to accept the Terms and re-run,
          // which makes the run pass and the regression vanish — while
          // every real user who has not accepted stays locked out. A
          // check that instructs you to perform the action that hides
          // the bug is not a lenient check, it is an actively
          // misleading one.
          ok = false;
          actual = `the Terms gate replaced ${s.route}, which is an exempt exit route`;
          note =
            'REGRESSION: this route must remain reachable without accepting a pending Terms revision. Do NOT accept the Terms to make this pass — that hides it.';
        } else {
          unverifiable = true;
          actual = 'the Terms gate replaced this route — the surface never mounted';
          note = 'legitimate posture, but this scenario verified nothing. Accept the current Terms with the dev wallet and re-run.';
        }
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
