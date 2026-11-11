// Watch-only live review of the rate desk (OFF-73, ACC-07, RB-DESK-LADDER,
// RB-ORIENTATION) (live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be sent. First, without
// connecting, it opens the desk and prints its prompt and how many market
// or offer reads the page made (none). Then, as <address> in Basic mode, it
// prints the orientation card; in Advanced mode, the completeness note, the
// market list and the ladder the desk opens, then the next market's ladder
// when there is one. Under each ladder (OFF-75, RB-DESK-TAPE) it prints the
// wallet's own offers, the market's recent loans and the agreed-rate chart
// (its period count, the first period's figures on hover, and the table).
// Then (OFF-76, RB-DESK-HISTORY) the wallet's live loans in that market and
// its desk history from the index, and (OFF-74, RB-DESK-TICKET) the order
// ticket, with its first blocker before and after an amount is typed.
// Checks that nothing scrolls sideways and saves full-page screenshots per
// device.
// Usage: node e2e/live/desk-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
const width = (p) => p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);

async function visitor(b, opts, label) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const reads = [];
  p.on('request', (r) => {
    if (r.url().includes('/offers/markets') || r.url().includes('/offers/active')) reads.push(r.url());
  });
  await p.goto(new URL('desk', BASE).href, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  console.log(`===== visitor ${label}\n${await text(p.locator('main'))}`);
  console.log(`visitor ${label}: market or offer reads before connecting = ${reads.length}`);
  await ctx.close();
}

async function ladder(p, label, step) {
  const l = p.getByTestId('desk-ladder');
  await l
    .locator('[data-testid="desk-middle"], [data-testid="desk-ladder-failed"], [data-testid="desk-bad-market"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  console.log(`----- ladder ${step} (${await l.getAttribute('data-market').catch(() => '')})\n${(await l.count()) ? await text(l) : 'no ladder'}`);
  await activity(p);
  console.log('scrollWidth/innerWidth', await width(p));
  await p.screenshot({ path: `${OUT}/live-desk-${step}-${label}.png`, fullPage: true });
}

async function activity(p) {
  for (const id of ['desk-orders', 'desk-tape']) {
    const sec = p.getByTestId(id);
    console.log(`----- ${id}\n${(await sec.count()) ? await text(sec) : 'not shown'}`);
  }
  const chart = p.getByTestId('desk-chart');
  if (!(await chart.count())) return console.log('----- desk-chart\nnot shown');
  await chart
    .locator('[data-testid="desk-rate-chart"], [data-testid="desk-chart-none"], [data-testid="desk-chart-failed"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  const periods = chart.getByTestId('desk-chart-period');
  console.log(
    `----- desk-chart (${await chart.getAttribute('data-period')}): periods drawn = ${await periods.count()}, runs = ${await chart.getByTestId('desk-chart-run').count()}`,
  );
  console.log(await text(chart));
  if (await periods.count()) {
    await periods.first().hover();
    const tip = chart.getByTestId('desk-chart-tip');
    console.log(`----- first period on hover\n${(await tip.count()) ? await text(tip) : 'no tip'}`);
    await chart.getByTestId('desk-chart-table').locator('summary').click();
    console.log(`----- table rows = ${await chart.getByTestId('desk-candle-row').count()}`);
  }
  for (const id of ['desk-loans', 'desk-history']) {
    const sec = p.getByTestId(id);
    if (id === 'desk-history') {
      await sec
        .locator('[data-testid="desk-history-row"], [data-testid="desk-history-none"], [data-testid="desk-history-failed"]')
        .first()
        .waitFor({ timeout: 60000 })
        .catch(() => {});
    }
    console.log(`----- ${id}\n${(await sec.count()) ? await text(sec) : 'not shown'}`);
  }
  await ticket(p);
}

// The order ticket (OFF-74, RB-DESK-TICKET): its text, then the first
// blocker before and after an amount is typed. Nothing is reviewed or sent.
async function ticket(p) {
  const t = p.getByTestId('desk-ticket');
  if (!(await t.count())) return console.log('----- desk-ticket not shown');
  const blocker = t.getByTestId('desk-ticket-blocker');
  await blocker
    .filter({ hasNotText: 'Reading' })
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  console.log(`----- desk-ticket (${await t.getAttribute('data-market')})\n${await text(t)}`);
  await t.getByTestId('desk-ticket-amount').fill('0.001');
  console.log(`----- blocker after an amount: ${(await blocker.count()) ? await blocker.innerText() : 'none'}`);
  await t.getByTestId('desk-ticket-amount').fill('');
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('desk', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.evaluate(() => window.localStorage.setItem('app.mode', 'basic'));
  await p.reload({ waitUntil: 'networkidle' });
  const card = p.getByTestId('orientation-card');
  await card.waitFor({ timeout: 30000 }).catch(() => {});
  console.log(`===== Basic ${label}: orientation card\n${(await card.count()) ? await text(card) : 'no card shown'}`);
  await p.evaluate(() => window.localStorage.setItem('app.mode', 'advanced'));
  await p.reload({ waitUntil: 'networkidle' });
  const markets = p.getByTestId('desk-markets');
  await markets
    .locator('[data-testid="desk-market-rows"], [data-testid="desk-markets-failed"], [data-testid="desk-markets-none"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  console.log(`===== Advanced ${label}: card shown = ${await card.count()}`);
  const note = p.getByTestId('desk-completeness');
  console.log(`----- completeness\n${(await note.count()) ? await text(note) : 'no note'}`);
  console.log(`----- markets\n${(await markets.count()) ? await text(markets) : 'no market list'}`);
  await ladder(p, label, 'first');
  const next = p.getByTestId('desk-market-open').first();
  if (await next.count()) {
    await next.click();
    await ladder(p, label, 'next');
  } else console.log('----- no other market to open');
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await visitor(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await visitor(b, { ...devices['Pixel 7'] }, 'phone');
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
