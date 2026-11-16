// Watch-only live review of changing an open offer (#3659, RB-OFFER-EDIT)
// (live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Offers as <address>, finds
// every open offer with the "Why isn't it matching?" line, and on up to two
// of their pages opens the change, prints the form as it starts (the
// offer's own figures), lowers the lowest rate by a tenth of a percent where
// it can, opens the review and prints it: each figure before and after, what
// moves, the terms-age wait and the protocol's own dry-run verdict. Nothing
// is confirmed. Checks that nothing scrolls sideways and saves screenshots
// per device.
// Usage: node e2e/live/offer-edit-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('offers', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p
    .locator('[data-testid="offers-mine"], [data-testid="offers-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  const links = p.locator('[data-testid^="offer-why-"]');
  const ids = [];
  for (let i = 0; i < (await links.count()); i++) ids.push((await links.nth(i).getAttribute('data-testid')).replace('offer-why-', ''));
  console.log(`===== ${label}: ${ids.length} open offers`);
  for (const id of ids.slice(0, 2)) {
    await p.goto(new URL(`offers/${id}`, BASE).href, { waitUntil: 'networkidle' });
    await connect(p);
    const open = p.getByTestId('offer-page-edit');
    if (
      !(await open.waitFor({ timeout: 90000 }).then(
        () => true,
        () => false,
      ))
    ) {
      console.log(`----- offer #${id}: no change offered`);
      continue;
    }
    await open.click();
    const form = p.getByTestId('offer-edit-form');
    await form
      .getByTestId('offer-edit-rateMin')
      .waitFor({ timeout: 60000 })
      .catch(() => {});
    console.log(`----- offer #${id} form\n${await text(form)}`);
    const min = form.getByTestId('offer-edit-rateMin');
    const now = Number(await min.inputValue().catch(() => 'NaN'));
    if (Number.isFinite(now) && now >= 0.1) await min.fill((Math.round((now - 0.1) * 100) / 100).toString());
    await form.getByTestId('offer-edit-review').click();
    const receipt = p.getByTestId('offer-edit-panel').locator('.receipt');
    await receipt.waitFor({ timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(3000);
    console.log(`----- offer #${id} review\n${(await receipt.count()) ? await text(p.getByTestId('offer-edit-panel')) : 'no review'}`);
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/offer-edit-${label}-${id}.png`, fullPage: true });
    // Close without confirming, so the stored change does not carry over.
    const cancel = p
      .getByTestId('offer-edit-panel')
      .getByRole('button', { name: /Cancel|Close/ })
      .first();
    if (await cancel.count()) await cancel.click().catch(() => {});
  }
  console.log('errors:', errs);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
