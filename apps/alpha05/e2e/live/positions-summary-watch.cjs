// Watch-only live review of the summary over a wallet's live loans on
// Positions (#3320; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): for the watched address it reads
// whether the card is shown (two or more live loans), each side's head line,
// the next date and its loan link, and every tier-A line (undated, in grace,
// past grace, fallback, partial). Then it narrows to each side and reads the
// card again. The wallet refuses every signature, so nothing can be sent. The
// figures are checked against the chain by the CI-Anvil spec
// (57-positions-summary.spec.ts); this checks the deployed build against Base
// Sepolia.
// Usage: node e2e/live/positions-summary-watch.cjs <address>  (screenshots go
// to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/positions');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function readCard(p, tag) {
  const card = p.getByTestId('positions-summary');
  if ((await card.count()) === 0) {
    console.log(`--- ${tag}: no summary (fewer than two live loans on this side)`);
    return;
  }
  for (const line of await card.locator('p').allInnerTexts()) console.log(`--- ${tag}: ${line.replace(/\n/g, ' ')}`);
  const links = await card.locator('a[href^="/positions/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  console.log(`--- ${tag} links: ${links.join(' ') || '(none)'}`);
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(10000);
  console.log(`===== ${label}`);
  await readCard(p, 'all');
  await p.screenshot({ path: `${OUT}/live-positions-summary-${label}.png`, fullPage: true });
  const group = p.getByRole('group', { name: 'Which positions to show' });
  if ((await group.count()) > 0) {
    for (const side of ['Lent', 'Borrowed']) {
      await group.getByRole('button', { name: side }).click();
      await p.waitForTimeout(500);
      await readCard(p, side.toLowerCase());
    }
    await group.getByRole('button', { name: 'All' }).click();
  }
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
