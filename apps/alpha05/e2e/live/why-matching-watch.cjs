// Watch-only live review of "why isn't it matching?" (#3623, OFF-41, OFF-46,
// RB-WHY-MATCH) (live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be sent. Opens Offers as
// <address>, finds every open offer with the "Why isn't it matching?" line,
// opens up to three of their pages and prints each page's section: the
// verdict, the count of offers on the other side and the closest offers
// with their verdicts. Checks that nothing scrolls sideways and saves
// full-page screenshots per device.
// Usage: node e2e/live/why-matching-watch.cjs <address>
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
  console.log(`===== ${label}: ${ids.length} open offers with the line`);
  for (const id of ids.slice(0, 3)) {
    await p.goto(new URL(`offers/${id}`, BASE).href, { waitUntil: 'networkidle' });
    await connect(p);
    const why = p.getByTestId('why-match');
    await why.waitFor({ timeout: 90000 }).catch(() => {});
    await p
      .locator('[data-testid="why-match-verdict"], [data-testid="why-match-index-failed"], [data-testid="why-match-chain-failed"], [data-testid="why-match-not-listed"]')
      .first()
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    const closest = why.getByTestId('why-match-closest');
    if (await closest.count()) await closest.locator('summary').click();
    console.log(`----- offer #${id}\n${(await why.count()) ? await text(why) : 'no section'}`);
    console.log(
      'verdict kind:',
      await why
        .getByTestId('why-match-verdict')
        .getAttribute('data-why')
        .catch(() => null),
    );
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/why-matching-${label}-${id}.png`, fullPage: true });
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
