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
 * `TESTNET_WALLETS_FILE` is REQUIRED even for `visitor`: every posture
 * goes through `launch()`, which loads the role's key to build the
 * injected provider. The visitor posture simply refuses to ANNOUNCE or
 * grant that account. The key is never used to sign here — `readOnly`
 * denies write RPCs outright.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
        return {
          ok: inputs === 0,
          actual: `wallet-specific block, inputs=${inputs}`,
          note: 'blocked for THIS wallet — says nothing about the oracle setting',
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

const results = [];
const setupFailures = [];
let hardFail = 0;

for (const roleKey of wanted) {
  const scenarios = SCENARIOS.filter((s) => s.role === roleKey);
  if (!scenarios.length) continue;

  const posture = ROLE_POSTURE[roleKey];
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
  const { page, done, blockedRequests } = session;

  // First navigation uses `visit()`, which is the REACHABILITY probe: it
  // exits 2 on an HTTP error, which is right before anything has been
  // observed. Later routes use a guarded goto so a 500 on one route is
  // recorded as that route's FAIL instead of aborting the run as BLOCKED
  // and discarding what earlier scenarios already found.
  let probed = false;

  if (posture.preAuthorized) {
    // preAuthorized alone does not prove wagmi ACCEPTED the provider. If
    // connector rehydration regresses, several connected-role checks
    // still pass against public or connect-prompt content, because they
    // count body text and generic buttons. Prove the connection first.
    try {
      await visit(page, '/');
      probed = true;
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
      }
    } catch (err) {
      setupFailures.push(`${roleKey} connect: ${String(err.message || err).slice(0, 120)}`);
      console.log(`BLOCKED-SETUP  [${roleKey}] connect: ${String(err.message || err).slice(0, 120)}`);
      await done();
      continue;
    }
  }

  for (const s of scenarios) {
    let ok = false;
    let actual = '';
    let note = '';
    try {
      if (!probed) {
        await visit(page, s.route);
        probed = true;
      } else {
        const resp = await page.goto(`${SITE}${s.route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        const status = resp?.status();
        if (typeof status === 'number' && status >= 400) {
          throw new Error(`${s.route} answered HTTP ${status}`);
        }
      }
      // Per-scenario settle: a surface whose state arrives from an async
      // chain/config read needs longer than one that renders from props.
      // A scenario may replace it with a bounded poll (see R1).
      if (s.settle) await s.settle(page);
      else await page.waitForTimeout(s.settleMs ?? 1800);
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

  // THE READ-ONLY GUARANTEE, CHECKED. `readOnly: true` makes the injected
  // wallet refuse write RPCs; this turns a refusal into a FAILED RUN.
  // Without it the driver would deny the write and carry on green, which
  // reports "these journeys are fine" about a build that tried to sign
  // unprompted — the single most important thing a read-only review could
  // have told you, silently swallowed.
  const writeAttempts = (blockedRequests ?? []).filter((b) =>
    /wallet rpc|sign|sendTransaction/i.test(b.reason ?? ''),
  );

  // A VISITOR must not be asked to connect unprompted. The driver rejects
  // `eth_requestAccounts` / `wallet_requestPermissions` for this posture,
  // but the page can catch that rejection and still satisfy every
  // assertion — leaving a green first-arrival report for a build that
  // would have thrown a wallet dialog at a real newcomer.
  if (!posture.preAuthorized) {
    const prompts = (blockedRequests ?? []).filter((b) =>
      /requestAccounts|requestPermissions/i.test(b.reason ?? ''),
    );
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
    `${results.length - hardFail} pass, ${hardFail} fail ===`,
);

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
if (hardFail > 0) process.exit(1);
process.exit(setupFailures.length ? 2 : 0);
