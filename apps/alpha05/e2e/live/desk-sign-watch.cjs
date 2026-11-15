// Watch-only live review of signing a new order from the rate desk's ticket
// (OFF-59, RB-DESK-SIGN) (live tier, run after each deploy), through the
// shared watch-only wallet (watch-wallet.cjs), which refuses every signature:
// nothing is signed and nothing reaches the offer book. As <address> in
// Advanced mode it opens the desk's first market, switches the ticket to
// "signed without gas" and prints the ticket (the vault line and the one
// shape in place of the balance and the fill choice), the blocker for an
// order that never lapses, then types a small order lapsing in 7 days and
// opens the review. It prints the receipt (or the Terms step, when the
// wallet has not accepted the Terms), ticks the consent and presses "Sign and
// list": the wallet's refusal must come back as "Nothing was signed".
// Checks that nothing scrolls sideways and saves full-page screenshots per
// device.
// Usage: node e2e/live/desk-sign-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
const width = (p) => p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  const posts = [];
  p.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/signed-offers')) posts.push(r.url());
  });
  await p.goto(new URL('desk', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.evaluate(() => window.localStorage.setItem('app.mode', 'advanced'));
  await p.reload({ waitUntil: 'networkidle' });
  const t = p.getByTestId('desk-ticket');
  await t.waitFor({ timeout: 90000 }).catch(() => {});
  if (!(await t.count())) {
    console.log(`===== ${label}: desk-ticket not shown`);
    return ctx.close();
  }
  await t
    .getByTestId('desk-ticket-mode')
    .getByRole('radio', { name: /Signed without gas/ })
    .check();
  const blocker = t.getByTestId('desk-ticket-blocker');
  console.log(`===== ${label}: ticket in signed mode (${await t.getAttribute('data-market')})\n${await text(t)}`);
  console.log(
    `balance line shown = ${await t.getByTestId('desk-ticket-balance').count()}, fill choice shown = ${await t.getByTestId('desk-ticket-fill').count()}`,
  );
  await t.getByTestId('desk-ticket-amount').fill('0.001');
  await t.getByTestId('desk-ticket-collateral').fill('1');
  await t.getByTestId('desk-ticket-rate').fill('5');
  await t.getByTestId('desk-ticket-expiry').getByRole('radio', { name: 'Until taken or cancelled' }).check();
  console.log(`----- blocker for a never-lapsing order: ${(await blocker.count()) ? await blocker.innerText() : 'none'}`);
  await t.getByTestId('desk-ticket-expiry').getByRole('radio', { name: '7 days' }).check();
  await p.waitForTimeout(1500);
  console.log(`----- blocker at 7 days: ${(await blocker.count()) ? await blocker.innerText() : 'none'}`);
  console.log('scrollWidth/innerWidth', await width(p));
  await p.screenshot({ path: `${OUT}/live-desk-sign-ticket-${label}.png`, fullPage: true });
  const review = t.getByTestId('desk-ticket-review');
  if (await review.isDisabled()) {
    console.log(`errors: ${JSON.stringify(errs)}`);
    return ctx.close();
  }
  await review.click();
  const signReview = t.getByTestId('desk-sign-review');
  await signReview
    .locator('.receipt')
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  if (!(await signReview.count())) {
    console.log(`----- review not open (Terms step?)\n${await text(t)}`);
  } else {
    console.log(`----- signed-order review\n${await text(signReview)}`);
    console.log('scrollWidth/innerWidth', await width(p));
    await p.screenshot({ path: `${OUT}/live-desk-sign-review-${label}.png`, fullPage: true });
    const consent = signReview.getByTestId('desk-sign-consent');
    if (await consent.count()) {
      await consent.check();
      await signReview.getByTestId('desk-sign-submit').click();
      await p.waitForTimeout(3000);
      const notice = signReview.getByRole('alert').filter({ hasText: 'Nothing was signed' });
      console.log(`----- after the wallet refuses: ${(await notice.count()) ? await notice.innerText() : 'no not-signed notice'}`);
    } else console.log('----- no consent offered (a blocker stands)');
  }
  console.log(`offer-book POSTs = ${posts.length}`);
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
