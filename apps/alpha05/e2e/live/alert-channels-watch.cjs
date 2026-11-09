// Watch-only live review of Alerts › Telegram, push and warnings (#3180
// Alerts slice 2, ACC-50 / ACC-52, RB-ALERT-CHANNELS; live tier, run after
// each deploy), through the shared watch-only wallet (watch-wallet.cjs). The
// deployed build asks the deployed alert service whether push can be sent,
// and shows what this throwaway browser has done (nothing): the Telegram,
// push, health-warning and reminder cards, on desktop and phone. Nothing is
// signed, and the driver counts every request to the alert service's write
// routes to prove none was sent. The signed flows are covered by the
// CI-Anvil spec (42-alert-channels.spec.ts).
// Usage: node e2e/live/alert-channels-watch.cjs <address>  (screenshots go
// to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin;
// $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';
const WRITES = /\/(link\/telegram|unlink\/telegram|telegram\/test|thresholds)$/;

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  const writes = [];
  let pushStatus = null;
  p.on('request', (r) => {
    if (WRITES.test(new URL(r.url()).pathname) && r.method() !== 'OPTIONS') writes.push(`${r.method()} ${r.url()}`);
  });
  p.on('response', async (r) => {
    if (new URL(r.url()).pathname === '/push/status') pushStatus = `${r.status()} ${await r.text().catch(() => '')}`;
  });
  await p.goto(`${ORIGIN}alerts`, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByTestId('alert-channels');
  await section.waitFor({ timeout: 60000 });
  await p.waitForFunction(() => !document.querySelector('[data-testid="alert-push"]')?.textContent?.includes('Asking the alert service'), null, { timeout: 30000 });
  console.log(`===== ${label}`);
  for (const id of ['alert-channels-off', 'alert-telegram', 'alert-push', 'alert-health', 'alert-due']) {
    const el = p.getByTestId(id);
    if (await el.count()) console.log(`--- ${id}: ${(await el.innerText()).replace(/\n+/g, ' · ')}`);
  }
  console.log('push status answer:', pushStatus);
  console.log('write requests sent:', JSON.stringify(writes));
  await section.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-alert-channels-${label}.png`, fullPage: true });
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
