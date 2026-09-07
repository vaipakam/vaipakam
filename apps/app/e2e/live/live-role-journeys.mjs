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
 *   - `visitor`   no wallet announced, and `eth_requestAccounts` refused.
 *                 This is the only posture that reproduces a first-time
 *                 arrival honestly; a driver that lets the injected
 *                 wallet auto-connect tests a returning user and calls it
 *                 a first visit.
 *   - `lender` / `borrower`  connected, funded testnet roles.
 *
 * READ-ONLY. No scenario here signs or broadcasts. The signing journeys
 * are already driven by `live-dryrun-review.mjs`, `live-signed-book.mjs`
 * and `live-rate-desk.mjs`; duplicating them here would spend testnet
 * gas to re-prove covered ground.
 *
 * Usage:
 *   SITE_URL=https://app.vaipakam.com \
 *   NODE_USE_ENV_PROXY=1 \
 *   LIVE_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node live-role-journeys.mjs
 *
 *   JOURNEY_ROLES=visitor       # optional subset, comma-separated
 *   JOURNEY_JSON=out/report.json # optional machine-readable dump
 */
import { launch, visit, SITE, requireSiteUrl } from './driver.mjs';

requireSiteUrl();

/** Text that means the app rendered its own not-found, not a blank shell. */
const NOT_FOUND = /doesn.t exist|not found|404/i;

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
      const txt = await bodyText(page);
      return {
        ok: txt.length > 150 && !NOT_FOUND.test(txt.slice(0, 400)),
        actual: `body=${txt.length} chars, notFound=${NOT_FOUND.test(txt.slice(0, 400))}`,
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
      return {
        ok: gates && inputs === 0 && txt.length > 100,
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
    // The oracle state is read ASYNCHRONOUSLY after mount, so this needs
    // longer than the default settle. At 1800ms the page had rendered
    // neither posture yet, which reads identically to the disconnected
    // view and produced a false FAIL on the first run of this driver.
    settleMs: 3500,
    async check(page) {
      const txt = await bodyText(page);
      const inputs = await page.locator('input').count();
      // Match the SHIPPED copy, including its curly apostrophe: "Recovery
      // isn't available on this network yet". A pattern written from
      // imagination ("not available") misses "isn’t available" and fails
      // a page that is behaving correctly — which is what happened here.
      const unavailable =
        /(is|are)n[''’]?t available|not available|unavailable|isn[''’]t configured|not configured/i.test(
          txt,
        );
      return {
        // Either posture can be correct depending on the LIVE oracle
        // setting, so this records rather than asserts a single answer —
        // what must never happen is a form with NEITHER a stated posture
        // NOR inputs, which means the page told the user nothing.
        ok: unavailable || inputs > 0,
        actual: `states-unavailable=${unavailable}, inputs=${inputs}`,
        note: unavailable
          ? 'oracle UNSET — unavailable posture shown, no doomed form (correct for retail)'
          : `form rendered (${inputs} input(s)) — implies an oracle IS set; confirm that is intended`,
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
      const controls = await page.locator('input, select, button').count();
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
      const controls = await page.locator('input, select, button').count();
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
      const controls = await page.locator('button').count();
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

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')) || '';
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
  visitor: { role: 'lender', preAuthorized: false, allowRequestAccounts: false },
  lender: { role: 'lender', preAuthorized: true, allowRequestAccounts: true },
  borrower: { role: 'borrower', preAuthorized: true, allowRequestAccounts: true },
};

const wanted = (process.env.JOURNEY_ROLES ?? 'visitor,lender,borrower')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const r of wanted) {
  if (!ROLE_POSTURE[r]) {
    console.error(`BLOCKED: unknown role "${r}" — known: ${Object.keys(ROLE_POSTURE).join(', ')}`);
    process.exit(2);
  }
}

const results = [];
let hardFail = 0;

for (const roleKey of wanted) {
  const scenarios = SCENARIOS.filter((s) => s.role === roleKey);
  if (!scenarios.length) continue;

  const posture = ROLE_POSTURE[roleKey];
  const { page, done } = await launch({ ...posture, freshProfile: true });

  for (const s of scenarios) {
    let ok = false;
    let actual = '';
    let note = '';
    try {
      await visit(page, s.route);
      // Per-scenario settle: a surface whose state arrives from an async
      // chain/config read needs longer than one that renders from props.
      await page.waitForTimeout(s.settleMs ?? 1800);
      const r = await s.check(page);
      ok = r.ok;
      actual = r.actual;
      note = r.note ?? '';
    } catch (err) {
      actual = `ERROR: ${String(err.message || err).slice(0, 120)}`;
    }
    if (!ok) hardFail += 1;
    results.push({ ...s, roleKey, ok, actual, note, check: undefined });
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${s.id}  [${roleKey}] ${s.route}\n` +
        `      goal    : ${s.goal}\n` +
        `      desired : ${s.desired}\n` +
        `      actual  : ${actual}${note ? `\n      note    : ${note}` : ''}`,
    );
  }
  await done();
}

console.log(
  `\n=== ${SITE} — ${results.length} scenario(s), ` +
    `${results.length - hardFail} pass, ${hardFail} fail ===`,
);

if (process.env.JOURNEY_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    process.env.JOURNEY_JSON,
    JSON.stringify({ site: SITE, at: new Date().toISOString(), results }, null, 2),
  );
  console.log(`report → ${process.env.JOURNEY_JSON}`);
}

process.exit(hardFail ? 1 : 0);
