// Watch-only live review of Analytics (RW-74, RW-75; live tier, run after
// each deploy). Opens /analytics with no wallet, once per network the
// deployed build serves (the page's own picker, read from its options), on
// a desktop window and a phone. Nothing can be sent. Prints the read stamp,
// the deployment start, every figure group, the lifetime parts lines, the
// asset cards and the custody line, checks nothing scrolls sideways and
// saves full-page screenshots per network and device.
// Usage: node e2e/live/analytics-watch.cjs
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, ' | ');
async function networks(b) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(new URL('analytics', BASE).href, { waitUntil: 'networkidle' });
  const list = await p
    .getByTestId('analytics-network')
    .locator('option')
    .evaluateAll((els) => els.map((e) => [e.value, e.textContent]));
  await ctx.close();
  return list;
}
async function session(b, opts, label, [id, name]) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(new URL(`analytics?chain=${id}`, BASE).href, { waitUntil: 'networkidle' });
  await p
    .getByTestId('analytics-read-at')
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(1500);
  console.log(`===== Analytics ${name} (${id}) ${label}`);
  for (const t of [
    'analytics-read-at',
    'analytics-since',
    'analytics-activity',
    'analytics-locked',
    'analytics-lifetime',
    'analytics-fee-rates',
    'analytics-fees-collected',
    'analytics-custody',
    'analytics-held',
  ]) {
    console.log(`${t}: ${await text(p.getByTestId(t)).catch(() => '(none)')}`);
  }
  for (const l of await p.getByTestId('analytics-parts').all()) console.log(`parts: ${await text(l)}`);
  const cards = await p.getByTestId('analytics-asset').all();
  console.log(`assets (${cards.length}):`);
  for (const c of cards) console.log(`  ${await text(c)}`);
  console.log(`record differs: ${await text(p.getByTestId('analytics-record-differs')).catch(() => '(no)')}`);
  console.log(`vpfi record differs: ${await text(p.getByTestId('analytics-vpfi-record-differs')).catch(() => '(no)')}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-analytics-${id}-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  for (const n of await networks(b)) {
    await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop', n);
    await session(b, { ...devices['Pixel 7'] }, 'phone', n);
  }
  await b.close();
})();
