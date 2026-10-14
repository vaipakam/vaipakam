// #2467 live verification — the Rate Desk History panel states the terms a
// fill EXECUTED at, from the indexer's initiation snapshot, and never the
// live terms an extension rewrites.
//
// Read-only: the injected wallet signs nothing, and any page write is a FAIL.
//
// What is under test, for every row of the History response the PAGE itself
// receives (its `/loans/by-participant` request, for the wallet it is
// connected as — asserted to be ROLE's):
//   - the row's terms element (`data-testid="history-terms"`) states the
//     EXECUTED terms exactly — `data-terms="executed"`, the snapshot's rate and
//     duration as attributes, and the text the app's formatters produce —
//     whenever the snapshot is valid by the app's own both-or-nothing rule;
//   - otherwise it says `copy.desk.history.termsUnknown` and nothing else;
//   - the LIVE rate appears nowhere in the row where it differs.
//
// BLOCKED (2) when SITE_URL does not serve the same bundle as
// REFERENCE_SITE_URL (a workers.dev host; alpha02 refused), when the page's
// History request cannot be observed or fails, when the wallet has no rows,
// or when no row distinguishes the fix (see below). FAIL (1) on any
// row that contradicts the indexer, a missing row, or a page write/error.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… [ROLE=lender2] \
//     node live-desk-history-terms.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, blocked, blockedSync, ensureConnected, launch, requireSiteUrl, visit } from './driver.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';

const SITE_URL = requireSiteUrl();
const REFERENCE_SITE_URL = process.env.REFERENCE_SITE_URL ?? '';
if (!REFERENCE_SITE_URL) blockedSync('REFERENCE_SITE_URL is required: the workers.dev URL of the deploy under review.');
// A malformed URL is a configuration problem — BLOCKED, never a FAIL (#2492 r1).
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return blockedSync(`${u} is not a URL — check SITE_URL and REFERENCE_SITE_URL.`);
  }
};
for (const u of [SITE_URL, REFERENCE_SITE_URL]) {
  if (/alpha02\./i.test(hostOf(u))) blockedSync(`${u} is alpha02 — not the deploy under review.`);
}
if (!/\.workers\.dev$/i.test(hostOf(REFERENCE_SITE_URL))) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const ROLE = process.env.ROLE ?? 'lender';
const WALLET = addressOf(ROLE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const EN = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/app/src/i18n/locales/en.json'), 'utf8')).copy;
const HISTORY = EN?.desk?.history ?? {};
for (const k of ['tab', 'termsUnknown']) {
  if (typeof HISTORY[k] !== 'string') blockedSync(`en.json no longer carries copy.desk.history.${k}`);
}
const UNITS = EN?.units ?? {};
for (const k of ['durationDay_one', 'durationDay_other', 'durationMonth_one', 'durationMonth_other', 'durationYear_one', 'durationYear_other']) {
  if (typeof UNITS[k] !== 'string') blockedSync(`en.json no longer carries copy.units.${k}`);
}
/** The app's `formatDurationDays` (src/lib/format.ts) in English. */
function formatDurationDays(days) {
  const unit = (key, n) => (n === 1 ? UNITS[`${key}_one`] : UNITS[`${key}_other`].replace('{{count, number}}', n.toLocaleString('en-US')));
  if (days < 30) return unit('durationDay', days);
  if (days % 365 === 0) return unit('durationYear', days / 365);
  if (days % 30 === 0) return unit('durationMonth', days / 30);
  return unit('durationDay', days);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── Build check ────────────────────────────────────────────────────────
async function bundleOf(url) {
  const res = await fetch(new URL('/', url), { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
  return (await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}
let site;
let ref;
try {
  [site, ref] = await Promise.all([bundleOf(SITE_URL), bundleOf(REFERENCE_SITE_URL)]);
} catch (err) {
  await blocked('could not fetch the SPA shells for the build check', err);
}
if (!site || site !== ref) await blocked(`SITE_URL serves ${site} but the reference deploy serves ${ref}`);
console.log(`build: ${site} on both hosts`);

// ── The app's own rules, mirrored ──────────────────────────────────────
/** `initiatedTerms` (src/lib/positionAmounts.ts): BOTH snapshot fields must be
 *  whole numbers, the rate non-negative and the duration positive — otherwise
 *  the row's terms are unknown (#2492 r2). */
function initiatedTerms(l) {
  const r = l.initRateBps;
  const d = l.initDurationDays;
  if (typeof r !== 'number' || typeof d !== 'number' || !Number.isInteger(r) || !Number.isInteger(d)) return null;
  if (r < 0 || d <= 0) return null;
  return { rateBps: r, durationDays: d };
}
/** `formatBpsAsPercent` (src/lib/format.ts). */
const formatBpsAsPercent = (bps) => `${Number((bps / 100).toFixed(2))}%`;
/** A whole-token match, so "5%" never matches inside "15%" (#2492 r2). */
const hasToken = (text, token) =>
  new RegExp(`(^|[^0-9.])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(text);

// ── The History panel, against the page's OWN data ─────────────────────
const session = await launch({ role: ROLE, readOnly: true });
const { ctx, page, done, consoleErrors, blockedRequests } = session;
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vaipakam:language', 'en');
  } catch {
    /* stated by the rendered result */
  }
});
let loans = null;
let stopped = null;
try {
  await visit(page, '/desk');
  await ensureConnected(page);
  // The dataset under test is the one the PAGE fetched (#2492 r2), for the
  // wallet the PAGE is connected as — not a second fetch of our own, which a
  // different connected account or a different baked indexer origin would
  // make a different dataset.
  const historyResponse = page.waitForResponse(
    (r) => {
      try {
        const u = new URL(r.url());
        return u.pathname === '/loans/by-participant' && !u.searchParams.has('scope') && !u.searchParams.has('fields');
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: HISTORY.tab, exact: true }).first().click({ timeout: 60_000 });
  const res = await historyResponse.catch(() => null);
  if (!res) {
    await blocked('the History panel made no /loans/by-participant request the drive could observe', null, done);
  }
  const reqWallet = (new URL(res.url()).searchParams.get('wallet') ?? '').toLowerCase();
  if (reqWallet !== WALLET.toLowerCase()) {
    check(false, `the History panel asked for ${ROLE}'s wallet`, `it asked for ${reqWallet}`);
    throw new Error('the page is connected as a different wallet');
  }
  if (!res.ok()) await blocked(`the page's History request answered HTTP ${res.status()}`, null, done);
  loans = (await res.json()).loans ?? [];
  if (loans.length === 0) await blocked(`${ROLE} ${WALLET} has no History rows to judge`, null, done);

  // A row DISTINGUISHES the fix from the pre-#2467 code (which showed the
  // live terms) only if what it must show differs from them: unknown terms,
  // or executed terms an extension has since rewritten. Without one, both
  // versions read the same and a PASS would prove nothing (#2492 r1).
  const distinguishing = loans.filter((l) => {
    const t = initiatedTerms(l);
    return t === null || t.rateBps !== l.interestRateBps || t.durationDays !== l.durationDays;
  });
  console.log(
    `page data: ${loans.length} row(s) for ${ROLE}; ${loans.filter((l) => initiatedTerms(l) === null).length} with unknown terms; ` +
      `${distinguishing.length} distinguishing: ${distinguishing.map((l) => l.loanId).join(', ') || 'none'}`,
  );
  if (distinguishing.length === 0) {
    await blocked(`no row for ${ROLE} tells executed terms from live ones (none extended, none unknown) — nothing here could show the fix`, null, done);
  }

  const rowFor = (id) => page.locator('.item-row').filter({ has: page.locator(`a[href$="/positions/${id}"]`) });
  await rowFor(loans[0].loanId).first().waitFor({ state: 'visible', timeout: 60_000 });
  for (const l of loans) {
    const row = rowFor(l.loanId).first();
    // VISIBLE rows and terms only (#2492 r1, r2): a node kept in the DOM but
    // hidden shows the user nothing.
    if (!(await row.isVisible().catch(() => false))) {
      check(false, `loan ${l.loanId} has a visible History row`);
      continue;
    }
    const termsEl = row.getByTestId('history-terms');
    if ((await termsEl.count()) !== 1 || !(await termsEl.isVisible())) {
      check(false, `loan ${l.loanId}: its terms element is shown exactly once`, `${await termsEl.count()} found`);
      continue;
    }
    const kind = await termsEl.getAttribute('data-terms');
    const shown = (await termsEl.innerText()).replace(/\s+/g, ' ').trim();
    const rowText = (await row.innerText()).replace(/\s+/g, ' ');
    const t = initiatedTerms(l);
    if (t === null) {
      // Unknown: exactly the disclosure, and no rate or duration anywhere.
      check(
        kind === 'unknown' && shown === HISTORY.termsUnknown && !hasToken(rowText, formatBpsAsPercent(l.interestRateBps)),
        `loan ${l.loanId}: terms unknown → says so, and shows no rate`,
        `data-terms=${kind}; terms "${shown}"`,
      );
    } else {
      // Executed: the element's own values and its EXACT text, and the live
      // rate nowhere in the row where it differs (#2492 r2).
      const want = `${formatDurationDays(t.durationDays)} · ${formatBpsAsPercent(t.rateBps)}`;
      const liveRate = formatBpsAsPercent(l.interestRateBps);
      const liveLeaks = l.interestRateBps !== t.rateBps && hasToken(rowText, liveRate);
      check(
        kind === 'executed' &&
          Number(await termsEl.getAttribute('data-rate-bps')) === t.rateBps &&
          Number(await termsEl.getAttribute('data-duration-days')) === t.durationDays &&
          shown === want &&
          !liveLeaks,
        `loan ${l.loanId}: shows the executed terms exactly (${want})`,
        `terms "${shown}"${liveLeaks ? `; the live rate ${liveRate} also appears` : ''}`,
      );
    }
  }
  await session.shot('desk-history-terms').catch(() => {});
} catch (err) {
  stopped = err.message;
  console.log(`STOP  ${stopped}`);
}
// Close FIRST, then read what the page did (#2492 r2): a request emitted
// while the context closes must still count against a read-only run.
try {
  await done();
} catch {
  /* teardown is not evidence */
}
const pageErrors = consoleErrors.filter((e) => e.startsWith('PAGEERROR'));
check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | ').slice(0, 300));
const violations = splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations;
check(violations.length === 0, 'the page attempted no write in a read-only session', violations.map((v) => v.reason).join(' | '));
if (stopped && failures === 0) check(false, 'the History panel was driven to completion', stopped);
console.log(failures === 0 ? 'OUTCOME: PASS' : `OUTCOME: FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
