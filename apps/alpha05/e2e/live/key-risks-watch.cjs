// Watch-only live review of the key risks (#3661, RB-KEY-RISKS; live tier,
// run after each deploy). With no wallet, on a desktop window and a phone:
// opens Home, follows the footer's "Key risks" link, prints the short list
// and the further points, checks nothing scrolls sideways and saves a
// full-page screenshot per device. Nothing can be sent. The Terms prompt
// and a review's "If things go wrong" line need a wallet that signs, so
// they are covered by 82-key-risks.spec.ts on the CI chain.
// Usage: node e2e/live/key-risks-watch.cjs
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
  await p.locator('footer').getByRole('link', { name: 'Key risks' }).click();
  await p.getByTestId('risks-page').waitFor({ timeout: 30000 });
  console.log(`===== ${label}: ${p.url()}`);
  console.log(`key: ${await text(p.getByTestId('risks-key'))}`);
  console.log(`more: ${await text(p.getByTestId('risks-more'))}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-key-risks-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['iPhone 13'] }, 'phone');
  await b.close();
})();
