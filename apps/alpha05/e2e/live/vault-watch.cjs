// Watch-only live review of the Vault page (ACC-20, ACC-21, ACC-24,
// RB-VAULT) (live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be sent. Opens Vault as
// <address> and prints the page: the vault address (or that there is none,
// with Create my vault, whose review it opens and leaves unsigned), and each
// asset row with the protocol's figures, uncounted notes and how it was
// found, then the same with small and empty rows shown. Checks that nothing
// scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/vault-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('vault', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const main = p.locator('main.vault');
  await main
    .locator('[data-testid="vault-address-value"], [data-testid="vault-none"], [data-testid="vault-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(4000);
  console.log(`===== Vault ${label}\n${(await main.count()) ? await text(main) : 'no Vault page'}`);
  const toggle = p.getByTestId('vault-toggle-hidden');
  if (await toggle.count()) {
    await toggle.click();
    await p.waitForTimeout(1000);
    const rows = p.locator('[data-vault-row]');
    console.log(`----- with small and empty rows (${await rows.count()} rows)`);
    for (let n = 0; n < (await rows.count()); n++) console.log(`${await rows.nth(n).getAttribute('data-vault-row')}\n${await text(rows.nth(n))}`);
  }
  const create = p.getByTestId('vault-create');
  if (await create.count()) {
    await create.click();
    const receipt = p.getByTestId('vault-create-panel').locator('.receipt');
    await receipt.waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(3000);
    console.log(`----- create review (unsigned)\n${(await receipt.count()) ? await text(receipt) : 'no receipt shown'}`);
  }
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-vault-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
