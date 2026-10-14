// #2467 live verification — the Rate Desk History panel states the terms a
// fill EXECUTED at, from the indexer's initiation snapshot, and never the
// live terms an extension rewrites.
//
// Read-only: the injected wallet signs nothing, and any page write is a FAIL.
//
// What is under test, for every loan the indexer lists for ROLE's wallet on
// the desk's own scope (`/loans/by-participant` with no `scope`: ERC-20 both
// legs, no sale vehicles — the same query the History panel makes):
//   - the row's rate is the EXECUTED rate — its `title` carries
//     `${initRateBps} bps` — whenever the indexer serves `initRateBps`;
//   - when it serves null (no ledger-backed snapshot), the row says
//     `copy.desk.history.termsUnknown` and shows no rate at all;
//   - a row never carries the LIVE rate where it differs from the executed one.
//
// BLOCKED (2) when SITE_URL does not serve the same bundle as
// REFERENCE_SITE_URL (a workers.dev host; alpha02 refused), when the indexer
// cannot be read, or when the wallet has no loans to judge. FAIL (1) on any
// row that contradicts the indexer, a missing row, or a page write/error.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… [ROLE=lender2] [INDEXER_ORIGIN=https://indexer.vaipakam.com] \
//     node live-desk-history-terms.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressOf, blocked, blockedSync, ensureConnected, launch, requireSiteUrl, visit } from './driver.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';

const SITE_URL = requireSiteUrl();
const REFERENCE_SITE_URL = process.env.REFERENCE_SITE_URL ?? '';
if (!REFERENCE_SITE_URL) blockedSync('REFERENCE_SITE_URL is required: the workers.dev URL of the deploy under review.');
for (const u of [SITE_URL, REFERENCE_SITE_URL]) {
  if (/alpha02\./i.test(new URL(u).host)) blockedSync(`${u} is alpha02 — not the deploy under review.`);
}
if (!/\.workers\.dev$/i.test(new URL(REFERENCE_SITE_URL).host)) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const ROLE = process.env.ROLE ?? 'lender';
const WALLET = addressOf(ROLE);
const INDEXER = process.env.INDEXER_ORIGIN ?? 'https://indexer.vaipakam.com';
const CHAIN_ID = 84532;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const EN = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/app/src/i18n/locales/en.json'), 'utf8')).copy;
const HISTORY = EN?.desk?.history ?? {};
for (const k of ['tab', 'termsUnknown']) {
  if (typeof HISTORY[k] !== 'string') blockedSync(`en.json no longer carries copy.desk.history.${k}`);
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

// ── What the indexer says ──────────────────────────────────────────────
let loans;
try {
  const res = await fetch(`${INDEXER}/loans/by-participant?chainId=${CHAIN_ID}&wallet=${WALLET}&limit=25`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  loans = (await res.json()).loans ?? [];
} catch (err) {
  await blocked('the indexer could not be read for this wallet', err);
}
if (loans.length === 0) await blocked(`${ROLE} ${WALLET} has no loans to judge`);
console.log(`indexer: ${loans.length} loan(s) for ${ROLE}; ${loans.filter((l) => l.initRateBps === null).length} without backed terms`);

// ── The History panel ──────────────────────────────────────────────────
const session = await launch({ role: ROLE, readOnly: true });
const { ctx, page, done, consoleErrors, blockedRequests } = session;
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vaipakam:language', 'en');
  } catch {
    /* stated by the language check below */
  }
});
try {
  await visit(page, '/desk');
  await ensureConnected(page);
  await page.getByRole('button', { name: HISTORY.tab, exact: true }).first().click({ timeout: 60_000 });
  const rowFor = (id) => page.locator('.item-row').filter({ has: page.locator(`a[href$="/positions/${id}"]`) });
  // Rows render once the history read answers. The panel shows its first page
  // of 25, the same page the indexer read above returns.
  await rowFor(loans[0].loanId).first().waitFor({ state: 'visible', timeout: 60_000 });
  for (const l of loans) {
    const row = rowFor(l.loanId).first();
    if ((await row.count()) === 0) {
      check(false, `loan ${l.loanId} has a History row`);
      continue;
    }
    const titles = await row.locator('[title$=" bps"]').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    if (l.initRateBps === null || l.initRateBps === undefined) {
      check(
        text.includes(HISTORY.termsUnknown) && titles.length === 0,
        `loan ${l.loanId}: terms withheld → says they are not available, shows no rate`,
        titles.length ? `shows ${titles.join(', ')}` : '',
      );
    } else {
      check(
        titles.length === 1 && titles[0] === `${l.initRateBps} bps`,
        `loan ${l.loanId}: shows the executed rate (${l.initRateBps} bps)`,
        `row title ${titles.join(', ') || 'none'}${l.interestRateBps !== l.initRateBps ? `; live rate ${l.interestRateBps} bps must not appear` : ''}`,
      );
    }
  }
  await session.shot('desk-history-terms').catch(() => {});
} catch (err) {
  check(false, 'the History panel was driven to completion', err.message);
}
const pageErrors = consoleErrors.filter((e) => e.startsWith('PAGEERROR'));
check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | ').slice(0, 300));
const violations = splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations;
check(violations.length === 0, 'the page attempted no write in a read-only session', violations.map((v) => v.reason).join(' | '));
try {
  await done();
} catch {
  /* teardown is not evidence */
}
console.log(failures === 0 ? 'OUTCOME: PASS' : `OUTCOME: FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
