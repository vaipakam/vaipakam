// #1056 post-merge live review — kill-switch ZERO-REGRESSION check.
// Production sets no VITE_DISABLED_FLOWS, so the observable contract
// is: every page renders normally and the kill-switch banner copy
// appears NOWHERE. (Flipping the switch on production is an operator
// action we don't do for a review — exception stated in the PR body.)
import {
  blocked,
  ensureConnected,
  launch,
  SITE,
  visit,
  pasteAssetLive,
  watchPageRpc,
} from './driver.mjs';

const KILL_COPY = 'switched off right now';
// EVERY public route in App.tsx — the claim is "the banner appears
// nowhere", so the sweep must cover the whole route table.
const PAGES = [
  '/', '/borrow', '/lend', '/rent', '/positions', '/claims', '/offers',
  '/vault', '/activity', '/vpfi', '/nft', '/settings', '/faucet', '/help',
];

const { page, done } = await launch({ role: 'lender' });
const rpc = watchPageRpc(page);
// Connect BEFORE the sweep: several killable surfaces render only in
// the connected branch (Vpfi.tsx shows the connect-first card to an
// unauthenticated visit, hiding the deposit banner spot), so an
// unauthenticated sweep couldn't honestly claim the vpfi-deposit id
// (round 4). The session persists across gotos in this context.
// BLOCKED, not FAIL, if the site itself never answers (#1581) — the
// sweep below keeps exiting 1, since by then the site is known
// reachable and a route that will not render IS the regression this
// driver hunts.
await visit(page, '/');
await page.waitForTimeout(2500);
await ensureConnected(page);
let failures = 0;
for (const path of PAGES) {
  const resp = await page.goto(`${SITE}${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  const hasKillCopy = body.toLowerCase().includes(KILL_COPY);
  const rendered = body.trim().length > 100;
  // The status, not just the body length (Codex #1621 r13). This drive's
  // pass condition is "the page rendered AND the banner copy is absent",
  // and a 404 or CDN 5xx error document over 100 characters satisfies BOTH
  // — it renders, and it certainly does not mention the kill switch. So an
  // unreachable route scored PASS on a sweep whose entire claim is "the
  // banner appears NOWHERE", which is the most dangerous shape of false
  // pass: a safety-mechanism regression check that reports clean because
  // the page never loaded.
  //
  // Counted as a FAILURE (exit 1), not BLOCKED — the reachability probe
  // above already proved the site serves, so per the contract a route that
  // will not load from here IS a finding, which is what the comment on
  // that probe already promised and this loop did not deliver.
  const status = resp?.status();
  const served = typeof status !== 'number' || status < 400;
  const ok = served && rendered && !hasKillCopy;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${path} http=${status ?? 'n/a'} rendered=${rendered}` +
      ` killCopy=${hasKillCopy} len=${body.trim().length}`,
  );
}
// Review-state banners (round 3): the offer/rent banners render only
// inside the review card, so root visits alone can't prove those flow
// ids are enabled. Drive the deepest killable surface — the lend
// post-offer review — and require BOTH no banner AND the sign button
// actually enabling (which also proves the normal gates are clear).
// Per-id coverage: post-offer = this review drive; vpfi-deposit = the
// CONNECTED /vpfi visit in the sweep above (deposit is the default
// tab and the wallet is connected before the sweep, so its banner
// spot renders); accept-offer / nft-list / nft-rent share the same
// flowDisabled() config read and banner component but their review
// states need live book/NFT fixtures — root visits only, stated here
// honestly rather than claimed.
console.log('driving lend post-offer review…');
// Same status check as the sweep, and the review drive is SKIPPED when it
// fails. Without the skip an error document reaches `pasteAssetLive` and
// the run dies on a missing form control — still exit 1, but blaming a UI
// selector for a route that never served.
const lendResp = await page.goto(`${SITE}/lend`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
const lendStatus = lendResp?.status();
if (typeof lendStatus === 'number' && lendStatus >= 400) {
  console.log(`FAIL — /lend answered HTTP ${lendStatus}; post-offer review not driven`);
  failures++;
} else {
  await page.waitForTimeout(2500);
  await ensureConnected(page);
  await pasteAssetLive(page, 'lending-asset', '0x2affacdea8119e38d9754b2c2c15ec79af360807');
  await page.waitForTimeout(1500);
  await page.locator('input[placeholder="0.0"]').fill('25');
  await page.getByRole('button', { name: /see matching offers/i }).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.waitForTimeout(800);
  await page.locator('input[placeholder="5"]').fill('9');
  await pasteAssetLive(page, 'collateral-asset', '0x2A6c7149199991243aCbc04e1d59Aa052A6f00c3');
  await page.waitForTimeout(1500);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
  await page.getByRole('button', { name: /continue to review/i }).click();
  await page.waitForTimeout(3000);
  const post = page.getByRole('button', { name: /post lending offer/i });
  // The submit button is gated on LIVE chain reads (grace seconds, leg
  // liquidity, token metadata, wallet balance, the sanctions oracle). With
  // the RPC unavailable — or the hardcoded faucet fixture drained or
  // redeployed — none of those settle, the button never enables, and the
  // deadline below used to spend a FAIL on it. The old message admitted as
  // much ("a closed gate or the kill switch") while still reporting a
  // kill-switch product regression for an outage (Codex #1621 r13).
  rpc.reset();
  let reviewOk = false;
  const reviewDeadline = Date.now() + 90_000;
  for (;;) {
    for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
      if (!(await box.isChecked().catch(() => true))) await box.check().catch(() => {});
    }
    await page.waitForTimeout(2000);
    const reviewBody = await page.locator('body').innerText();
    if (reviewBody.toLowerCase().includes(KILL_COPY)) {
      console.log('FAIL — kill banner visible in the post-offer review');
      break;
    }
    if (await post.isEnabled().catch(() => false)) { reviewOk = true; break; }
    if (Date.now() > reviewDeadline) {
      // Nothing answered in the window ⇒ the gates this button waits on
      // could not have resolved either way, so the kill switch was never
      // observed here. BLOCKED, not a FAIL against the banner.
      //
      // But only when the RPC outage is the run's ONLY problem (Codex
      // #1621 r14). A route in the sweep above may already have proven a
      // defect — an HTTP 500, or the banner copy actually present — and
      // exiting 2 here would discard it and report "verified nothing"
      // about a run that verified something real. Same evidence-precedence
      // rule live-ux-sweep and live-recover-locales apply.
      if (failures === 0 && (await rpc.settled()) === 0) {
        await done();
        await blocked(
          'the submit gate never resolved and the page received no answer from' +
            ' its JSON-RPC endpoint in that window, so nothing was observed' +
            ' about the post-offer kill switch. Check the chain endpoint and' +
            ' that the lender wallet still holds the faucet fixture token.',
        );
      }
      console.log('FAIL — sign button never enabled with a live RPC (a closed gate or the kill switch)');
      break;
    }
  }
  console.log(`${reviewOk ? 'PASS' : 'FAIL'} post-offer review: no banner, sign button enabled`);
  if (!reviewOk) failures++;
}

await done();
process.exit(failures === 0 ? 0 : 1);
