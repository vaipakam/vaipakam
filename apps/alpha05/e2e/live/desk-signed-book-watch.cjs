// Watch-only live review of a market's signed orders on the rate desk
// (OFF-60, RB-DESK-BOOK-SIGNED, RB-DESK-FILL) (live tier, run after each
// deploy), through the shared watch-only wallet (watch-wallet.cjs): nothing
// can be signed or sent. As <address> in Advanced mode it opens the desk's
// markets in turn (up to three) and, for each, prints the completeness note
// and the signed orders section: each side's orders with their maker,
// lapse, standing on the chain and the maker's vault against a fill, or the
// section's empty or failed state. It counts the fill buttons and the
// offer-book reads, and opens the first enabled fill's review (or the Terms
// prompt before it) to print what it states; it never ticks consent or
// presses Confirm. Checks that nothing scrolls sideways and saves full-page
// screenshots per device.
// Usage: node e2e/live/desk-signed-book-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
const width = (p) => p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

async function section(p, label, step) {
  const s = p.getByTestId('desk-signed-book');
  await s.waitFor({ timeout: 60000 }).catch(() => {});
  if (!(await s.count())) return console.log(`----- ${step}: signed orders section not shown`);
  await s
    .locator('[data-testid="desk-signed-book-order"], [data-testid="desk-signed-book-none"], [data-testid="desk-signed-book-failed"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  const rows = s.getByTestId('desk-signed-book-order');
  const fills = s.getByTestId('desk-signed-book-fill');
  console.log(`----- ${step} (${await s.getAttribute('data-market')}): orders = ${await rows.count()}, fill buttons = ${await fills.count()}`);
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    console.log(`  [standing ${await r.getAttribute('data-standing')}, cover ${await r.getAttribute('data-cover')}]`);
  }
  console.log(await text(s));
  console.log('scrollWidth/innerWidth', await width(p));
  await p.screenshot({ path: `${OUT}/live-desk-signed-book-${step}-${label}.png`, fullPage: true });
  for (let i = 0; i < (await fills.count()); i++) {
    if (!(await fills.nth(i).isEnabled())) continue;
    await fills.nth(i).click();
    await p.waitForTimeout(8000);
    const review = s.locator('.accept-offer');
    const terms = p.locator('.terms-prompt');
    if (await review.count()) console.log(`  fill review:\n${await text(review.first())}`);
    else if (await terms.count()) console.log(`  Terms prompt before the review:\n${await text(terms.first())}`);
    else console.log('  the fill opened neither a review nor a Terms prompt');
    console.log('scrollWidth/innerWidth (review)', await width(p));
    await p.screenshot({ path: `${OUT}/live-desk-signed-fill-${step}-${label}.png`, fullPage: true });
    const close = (await review.count()) ? review.first().getByRole('button', { name: 'Close' }).first() : p.getByRole('button', { name: 'Close' }).first();
    if (await close.count()) await close.click().catch(() => {});
    break;
  }
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  const reads = [];
  p.on('request', (r) => {
    if (r.url().includes('/signed-offers')) reads.push(`${r.method()} ${new URL(r.url()).search.includes('signer=') ? 'signer-scoped' : 'market'}`);
  });
  await p.goto(new URL('desk', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.evaluate(() => window.localStorage.setItem('app.mode', 'advanced'));
  await p.reload({ waitUntil: 'networkidle' });
  console.log(`===== ${label}`);
  const note = p.getByTestId('desk-completeness');
  await note.waitFor({ timeout: 60000 }).catch(() => {});
  console.log(`completeness: ${(await note.count()) ? await note.innerText() : 'not shown'}`);
  await section(p, label, 'first');
  const markets = p.getByTestId('desk-market-open');
  for (let i = 0; i < Math.min(2, await markets.count()); i++) {
    await p.getByTestId('desk-market-open').first().click();
    await p.waitForTimeout(1500);
    await section(p, label, `market-${i + 2}`);
  }
  console.log(`offer-book reads: ${JSON.stringify(reads)}`);
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
