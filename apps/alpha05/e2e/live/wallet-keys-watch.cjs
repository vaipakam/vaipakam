// Watch-only live review of the self-custody wallet notice (#3671,
// RB-WALLET-KEYS; live tier, run after each deploy). With no wallet, on a
// desktop window and a phone: prints Home's notice, opens the wallet picker
// and prints its notice, closes the picker and checks the connect button
// still reads "Connect wallet" and can be pressed (on the deployed build the
// phone connection prepares its link as the picker opens, which left the
// button stuck before #3671), then follows the footer link to the
// key-safety page and prints it. Nothing is connected or sent.
// Usage: node e2e/live/wallet-keys-watch.cjs
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, ' | ');
async function session(b, opts, label) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  console.log(`===== ${label}: ${p.url()}`);
  console.log(`home: ${await text(p.getByTestId('home-wallet-needed'))}`);
  const connect = p.locator('.wallet button').first();
  await connect.click();
  const picker = p.getByTestId('picker-wallet-needed').filter({ visible: true });
  await picker.waitFor({ timeout: 15000 });
  console.log(`picker: ${await text(picker)}`);
  await p.screenshot({ path: `${OUT}/live-wallet-picker-${label}.png` });
  await p.waitForTimeout(2500);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(10000);
  console.log(`button after closing: "${await connect.innerText()}", enabled: ${await connect.isEnabled()}`);
  await p.locator('footer').getByRole('link', { name: 'Your wallet and its keys' }).click();
  await p.getByTestId('wallet-keys-page').waitFor({ timeout: 30000 });
  console.log(`page: ${await text(p.getByTestId('wallet-keys-page'))}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-wallet-keys-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['iPhone 13'] }, 'phone');
  await b.close();
})();
