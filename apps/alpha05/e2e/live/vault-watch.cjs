// Watch-only live review of the Vault page (ACC-20, ACC-21, ACC-22, ACC-23,
// ACC-24, RB-VAULT, RB-VAULT-DEPOSIT, RB-VAULT-WITHDRAW) (live tier, run
// after each deploy), through
// the shared watch-only wallet (watch-wallet.cjs): nothing can be sent.
// Opens Vault as <address> and prints the page: the vault address (or that
// there is none, with Create my vault, whose review it opens and leaves
// unsigned), each asset row with the protocol's figures, uncounted notes and
// how it was found, then the same with small and empty rows shown, then the
// Withdraw form and review for a small amount of the first asset with
// something free (left unsigned), then the Deposit form and review for a small amount of the first suggested asset
// (or the Terms prompt it asks for first), left unsigned. Checks that nothing
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
  // ACC-23: open Withdraw on the first asset with something free, type a
  // small amount and print the review, left unsigned.
  const withdrawOpen = p.locator('[data-testid^="vault-withdraw-open-"]').first();
  if (await withdrawOpen.count()) {
    await withdrawOpen.click();
    const form = p.getByTestId('vault-withdraw-form');
    await form.waitFor({ timeout: 30000 }).catch(() => {});
    const amount = form.getByTestId('vault-withdraw-amount');
    if (await amount.count()) await amount.fill('0.0001');
    await p.waitForTimeout(2000);
    console.log(`----- withdraw form\n${(await form.count()) ? await text(form) : 'no form shown'}`);
    if (await form.count()) {
      await form.getByTestId('vault-withdraw-review').click();
      const receipt = p.getByTestId('vault-withdraw-panel').locator('.receipt');
      await receipt.waitFor({ timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(3000);
      console.log(`----- withdraw review (unsigned)\n${(await receipt.count()) ? await text(p.getByTestId('vault-withdraw-panel')) : 'no receipt shown'}`);
    }
  } else console.log('----- withdraw: no asset with something free');
  // ACC-22: open Deposit, choose the first suggested asset, type a small
  // amount and print the review (or the Terms prompt), left unsigned.
  const depositOpen = p.getByTestId('vault-deposit-open');
  if (await depositOpen.count()) {
    await depositOpen.click();
    const terms = p.getByRole('dialog', { name: 'Terms of Service' });
    const form = p.getByTestId('vault-deposit-form');
    await Promise.race([terms.waitFor({ timeout: 30000 }), form.waitFor({ timeout: 30000 })]).catch(() => {});
    if (await terms.count()) console.log(`----- deposit asks for Terms first (unsigned)\n${await text(terms)}`);
    else if (await form.count()) {
      await form.getByTestId('vault-deposit-asset').selectOption({ index: 1 });
      const amount = form.getByTestId('vault-deposit-amount');
      await amount.waitFor({ timeout: 30000 }).catch(() => {});
      if (await amount.count()) await amount.fill('0.0001');
      else await form.getByTestId('vault-deposit-token-id').fill('1').catch(() => {});
      await p.waitForTimeout(2000);
      console.log(`----- deposit form\n${await text(form)}`);
      await form.getByTestId('vault-deposit-review').click();
      const receipt = p.getByTestId('vault-deposit-panel').locator('.receipt');
      await receipt.waitFor({ timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(3000);
      console.log(`----- deposit review (unsigned)\n${(await receipt.count()) ? await text(p.getByTestId('vault-deposit-panel')) : 'no receipt shown'}`);
    }
  } else if (await p.getByTestId('vault-deposit-paused').count()) console.log(`----- deposit closed\n${await text(p.getByTestId('vault-deposit-paused'))}`);
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
