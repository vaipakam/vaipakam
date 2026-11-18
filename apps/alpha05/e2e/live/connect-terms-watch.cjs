// Watch-only live review of the Terms at Connect (#3734, RB-TERMS-CONNECT;
// live tier, run after each deploy). With no wallet, on a desktop window and
// a phone: opens Home, presses Connect and prints what the Terms step shows
// (or that the wallet list opened at once where no Terms are in force),
// checks the agree button stays off until the box is ticked, closes with
// "Not now", checks nothing scrolls sideways and saves a screenshot per
// device. Nothing is connected or sent. The paid acceptance, the hold, the
// close-out choice and the update notices need a wallet that signs, so they
// are covered by 87-connect-terms.spec.ts on the CI chain.
// Usage: node e2e/live/connect-terms-watch.cjs
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, ' | ');
async function session(b, opts, label) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: 'Connect wallet' }).first().click();
  const step = p.getByTestId('connect-terms');
  await p.waitForTimeout(3000);
  console.log(`===== ${label}`);
  if (!(await step.isVisible().catch(() => false))) {
    console.log('no Terms step: the wallet list opened at once (no Terms in force on this network)');
  } else {
    const lead = p.getByTestId('connect-terms-lead');
    await Promise.race([lead.waitFor({ timeout: 30000 }), p.getByRole('alert').first().waitFor({ timeout: 30000 })]).catch(() => {});
    console.log(`step: ${await text(step)}`);
    const agree = p.getByTestId('connect-terms-choose');
    if (await agree.isVisible().catch(() => false)) console.log(`agree enabled before tick: ${await agree.isEnabled()}`);
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/live-connect-terms-${label}.png`, fullPage: true });
    await step.getByRole('button', { name: 'Not now' }).click();
    console.log(`closed by Not now: ${(await step.count()) === 0}`);
  }
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['iPhone 13'] }, 'phone');
  await b.close();
})();
