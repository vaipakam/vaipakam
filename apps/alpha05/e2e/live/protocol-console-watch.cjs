// Watch-only live review of the Protocol Console (RW-76, RW-77; live tier,
// run after each deploy). With no address it opens /console with no wallet,
// as a visitor sees it on the default network; with <address> it connects
// the shared watch-only wallet (watch-wallet.cjs) on $LIVE_CHAIN_ID, so the
// page describes that network. Nothing can be sent either way. Prints where
// the settings came from and why, the global pause line, each switch's
// state and the settings read, checks nothing scrolls sideways and saves
// full-page screenshots per device.
// Usage: node e2e/live/protocol-console-watch.cjs [address]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
async function session(b, opts, label) {
  let ctx;
  let p;
  let errs;
  if (ADDR) {
    ({ ctx, p, errs } = await watchedPage(b, opts, ADDR, false));
  } else {
    ctx = await b.newContext(opts);
    p = await ctx.newPage();
    errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
  }
  await p.goto(new URL('console', BASE).href, { waitUntil: 'networkidle' });
  if (ADDR) await connect(p);
  const source = p.getByTestId('console-source');
  await source.waitFor({ timeout: 90000 }).catch(() => {});
  await p
    .getByTestId('console-pause')
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  const attr = async (loc, name) => loc.getAttribute(name).catch(() => null);
  console.log(`===== Console ${label}`);
  console.log(`source: ${await attr(source, 'data-source')} why: ${await attr(source, 'data-why')} block: ${await attr(source, 'data-block')}`);
  console.log(await text(source).catch(() => '(no source line)'));
  console.log(`pause: ${await attr(p.getByTestId('console-pause'), 'data-pause')} :: ${await text(p.getByTestId('console-pause')).catch(() => '(none)')}`);
  console.log(`next: ${await text(p.getByTestId('console-next-pause')).catch(() => '(none)')}`);
  const switches = await p.locator('[data-switch]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-switch')}=${e.getAttribute('data-state')}`));
  console.log(`switches: ${switches.join(' ')}`);
  const rows = await p.locator('dd[data-setting]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-setting')}: ${e.textContent}`));
  console.log(`settings (${rows.length}):\n${rows.join('\n')}`);
  console.log(`unanswered: ${await text(p.getByTestId('console-unanswered')).catch(() => '(none)')}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-console-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
