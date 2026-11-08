// Watch-only live review of frozen proceeds (LN-53, RB-FROZEN) on Claims and
// the loan page (live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be sent. Opens Claims as
// <address> and prints the wallet's standing with the sanctions screen (the
// frozen notice and its state, or that none is shown) and the loan payouts
// section. When <loanId> is given, it opens that loan's page too and prints
// the notice, what a running loan reserved for the lender position, and the
// payout section. Checks nothing scrolls sideways and saves full-page
// screenshots per device.
// Usage: node e2e/live/frozen-watch.cjs <address> [loanId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, LOAN] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function standing(p) {
  const notice = p.getByTestId('frozen-notice');
  if ((await notice.count()) === 0) return 'no frozen notice (nothing frozen, or the standing is still being read)';
  return `notice state=${await notice.getAttribute('data-state')}\n${await text(notice)}`;
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const loans = p.getByRole('region', { name: 'Loan payouts' });
  await loans
    .locator('[data-testid="claims-loan-rows"], [data-testid="claims-empty"], [data-testid="claims-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  console.log(`===== Claims ${label}\n${await standing(p)}\n----- Loan payouts\n${await text(loans)}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-frozen-claims-${label}.png`, fullPage: true });
  if (LOAN) {
    await p.goto(new URL(`positions/${LOAN}`, BASE).href, { waitUntil: 'networkidle' });
    await p.getByTestId('position-status').waitFor({ timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(3000);
    const held = p.getByTestId('position-held-for-lender');
    const surplus = p.getByTestId('position-surplus-open');
    const payout = p.getByRole('region', { name: 'Your payout' });
    console.log(`===== Loan #${LOAN} ${label}\n${await standing(p)}`);
    console.log(`reserved for the lender: ${(await held.count()) ? await text(held) : 'none shown'}`);
    console.log(`surplus note: ${(await surplus.count()) ? await text(surplus) : 'none shown'}`);
    console.log(`payout section: ${(await payout.count()) ? await text(payout) : 'none (no side held, or nothing to collect)'}`);
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/live-frozen-loan-${label}.png`, fullPage: true });
  }
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
