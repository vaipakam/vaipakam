// Watch-only live review of the Rewards page (#3180; RW-01..RW-10;
// RB-REWARDS-VPFI, RB-REWARDS-TIER, RB-REWARDS-SIGN; live tier, run after
// each deploy),
// through the shared watch-only wallet (watch-wallet.cjs). The deployed build
// opens Rewards for the watched wallet's network and prints the rewards
// widget, the VPFI panel (whether VPFI is set up there, and the wallet's
// VPFI in its wallet, counted, free, held and uncounted) and the consent. The
// watch wallet cannot sign, so nothing is deposited or withdrawn, and the
// signed deposit (RW-03) is never offered; all three are covered by the
// CI-Anvil spec (54-rewards.spec.ts).
// Usage: node e2e/live/rewards-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed
// origin; $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}rewards`, { waitUntil: 'networkidle' });
  await p.getByRole('heading', { level: 1, name: 'Rewards' }).waitFor({ timeout: 60000 });
  await connect(p);
  const vpfi = p.getByTestId('rewards-vpfi');
  await vpfi.waitFor({ timeout: 90000 });
  await p
    .waitForFunction(() => document.querySelector('[data-testid="rewards-vpfi"]')?.getAttribute('data-vpfi'), null, { timeout: 90000 })
    .catch(() => console.log('(VPFI was still being read after 90 s)'));
  console.log(`===== ${label} (${p.url()})`);
  const widget = p.getByTestId('rewards-widget');
  if (await widget.count()) console.log(`--- rewards: ${(await widget.innerText()).replace(/\n+/g, ' · ')}`);
  console.log(`--- vpfi [${await vpfi.getAttribute('data-vpfi')}]: ${(await vpfi.innerText()).replace(/\n+/g, ' · ')}`);
  const consent = p.getByTestId('consent-toggle');
  if (await consent.count()) console.log(`--- consent: ${(await consent.innerText()).replace(/\n+/g, ' · ')}`);
  await p.screenshot({ path: `${OUT}/live-rewards-${label}.png`, fullPage: true });
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  if (!ADDR) throw new Error('usage: node e2e/live/rewards-watch.cjs <address>');
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
