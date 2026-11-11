// Watch-only live review of the rate desk's match band (OFF-63,
// RB-DESK-MATCH) (live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be signed or sent. As
// <address> in Advanced mode it opens the desk's markets in turn (up to
// three) and, for each, prints whether the ladder's sides overlap and the
// match band: its state (the switch off or unread, nothing to match, a
// confirmed pair with its terms, share and capacity lines, or the best
// pair's refusal) and its buttons. It never opens a review. Checks that
// nothing scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/desk-match-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
const width = (p) => p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

async function band(p, label, step) {
  const s = p.getByTestId('desk-match');
  await s.waitFor({ timeout: 60000 }).catch(() => {});
  if (!(await s.count())) return console.log(`----- ${step}: match band not shown`);
  // Wait for a settled state rather than the reading line.
  for (let i = 0; i < 30; i++) {
    const st = await s.getAttribute('data-state');
    if (st !== 'reading' && st !== 'no-identity') break;
    await p.waitForTimeout(1000);
  }
  const crossed = await p.getByTestId('desk-crossed').count();
  console.log(
    `----- ${step} (${await p.getByTestId('desk-ladder').getAttribute('data-market')}): crossed = ${crossed > 0}, state = ${await s.getAttribute('data-state')}, buttons = ${await s.getByRole('button').count()}`,
  );
  console.log(await text(s));
  console.log('scrollWidth/innerWidth', await width(p));
  await p.screenshot({ path: `${OUT}/live-desk-match-${step}-${label}.png`, fullPage: true });
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('desk', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.evaluate(() => window.localStorage.setItem('app.mode', 'advanced'));
  await p.reload({ waitUntil: 'networkidle' });
  console.log(`===== ${label}`);
  await band(p, label, 'first');
  const markets = p.getByTestId('desk-market-open');
  for (let i = 0; i < Math.min(2, await markets.count()); i++) {
    await p.getByTestId('desk-market-open').first().click();
    await p.waitForTimeout(1500);
    await band(p, label, `market-${i + 2}`);
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
