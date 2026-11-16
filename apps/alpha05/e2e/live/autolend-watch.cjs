// Watch-only live review of setting up Auto-lend (#3624, RB-AUTOLEND) (live
// tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Lend as <address>, picks
// the first pair, prints the choice (open, closed and why, or already set
// up), and where the Auto-lend option is open fills the form with small
// figures, opens the review and prints it: the protocol's own dry-run
// verdict, every figure bound and every consequence. Nothing is confirmed.
// Then prints the Auto-lend cards on Positions and the manage steps each offers. Checks that nothing scrolls
// sideways and saves screenshots per device. A full setup is covered by the
// CI-Anvil spec (86-autolend.spec.ts).
// Usage: node e2e/live/autolend-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
const width = (p) => p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(new URL('lend', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const l = lendOpts[0];
  const c = collOpts.find((v) => v !== l);
  await lending.selectOption(l);
  await collateral.selectOption(c);
  console.log(`===== ${label}: pair ${l} / ${c}`);
  const choice = p.getByTestId('lend-choice');
  await choice.waitFor({ timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const option = await choice.getAttribute('data-autolend').catch(() => null);
  console.log(`--- choice (${option})\n${(await choice.count()) ? await text(choice) : 'no choice shown'}`);
  if (option === 'open') {
    await p.getByTestId('lend-choice-keep').check();
    await p.getByTestId('lend-offer-open').click();
    const form = p.getByTestId('autolend-form');
    await form.waitFor({ timeout: 60000 }).catch(() => {});
    await p.getByTestId('autolend-amount').fill('0.01');
    await p.getByTestId('autolend-rate').fill('5');
    await p.getByTestId('autolend-days').fill('30');
    console.log(`--- form\n${await text(form)}`);
    await p.getByTestId('autolend-review').click();
    const setup = p.getByTestId('autolend-setup');
    await setup
      .locator('.receipt')
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    await p.waitForTimeout(3000);
    console.log(`--- review\n${(await setup.count()) ? await text(setup) : 'no review'}`);
    console.log('scrollWidth/innerWidth', await width(p));
    await p.screenshot({ path: `${OUT}/autolend-${label}-review.png`, fullPage: true });
  }
  await p.goto(new URL('positions', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByTestId('autolend-section');
  await section.waitFor({ timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(4000);
  console.log(`--- positions\n${(await section.count()) ? await text(section) : 'no Auto-lend section'}`);
  // Each card's manage steps (add, take back, stop), as offered; nothing is opened.
  const manage = p.getByTestId('autolend-manage');
  for (let i = 0; i < (await manage.count()); i++) console.log(`--- manage ${i + 1}: ${await text(manage.nth(i))}`);
  console.log('scrollWidth/innerWidth', await width(p));
  await p.screenshot({ path: `${OUT}/autolend-${label}-positions.png`, fullPage: true });
  console.log('errors:', errs);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
