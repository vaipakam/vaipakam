// Watch-only live review of Recover (ACC-25, ACC-26, ACC-27; live tier, run
// after each deploy). Connects the shared watch-only wallet (watch-wallet.cjs)
// as <address> on $LIVE_CHAIN_ID, opens /recover prefilled with <asset> (and
// <tokenId> for an NFT), as the Vault page's link does, and prints the
// protocol's figure for what sits uncounted, what stops adopting, a barred
// vault's notice (or a lifted bar's), which actions are offered and the pause line. When
// disowning is offered it opens the disown review and prints its receipt,
// then closes it: the watched wallet cannot sign, so nothing is sent. Checks
// nothing scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/recover-watch.cjs <address> <asset> [tokenId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, ASSET, ID] = process.argv.slice(2);
if (!ADDR || !ASSET) {
  console.error('usage: node e2e/live/recover-watch.cjs <address> <asset> [tokenId]');
  process.exit(2);
}
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText({ timeout: 3000 })).replace(/\n+/g, '\n');
const or = (p, fallback) => p.catch(() => fallback);
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  const url = new URL('recover', BASE);
  url.searchParams.set('asset', ASSET);
  if (ID !== undefined) url.searchParams.set('id', ID);
  await p.goto(url.href, { waitUntil: 'networkidle' });
  await connect(p);
  const figure = p.getByTestId('recover-figure');
  await figure.waitFor({ timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(2000);
  console.log(`===== Recover ${label}`);
  console.log(
    `subject: ${await or(text(p.getByTestId('recover-subject').locator('h2')), '(no subject)')} standard: ${await or(p.getByTestId('recover-subject').getAttribute('data-standard', { timeout: 3000 }), '?')}`,
  );
  console.log(`figure: ${await or(figure.getAttribute('data-state', { timeout: 3000 }), '?')} :: ${await or(text(figure), '(none)')}`);
  console.log(
    `standard unread: ${await p.getByTestId('recover-standard-failed').count()} need id: ${await p.getByTestId('recover-need-id').count()} failed: ${await or(text(p.getByTestId('recover-failed')), '(no)')}`,
  );
  console.log(`barred: ${await or(text(p.getByTestId('recover-barred')), '(no)')}`);
  console.log(`ban lifted: ${await or(text(p.getByTestId('recover-ban-lifted')), '(no)')}`);
  console.log(`adopt stop: ${await or(text(p.getByTestId('recover-adopt-stop')), '(none)')}`);
  const adopt = p.getByTestId('recover-adopt-open');
  const disown = p.getByTestId('recover-disown-open');
  console.log(`offered: adopt=${await adopt.count()} disown=${await disown.count()}`);
  console.log(`pause/escape: ${await or(text(p.getByTestId('vault-escape')), '(no notice)')}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-recover-${label}.png`, fullPage: true });
  if ((await disown.count()) > 0 && (await disown.isEnabled())) {
    await disown.click();
    const receipt = p.getByTestId('recover-disown-panel').locator('.receipt');
    await receipt.waitFor({ timeout: 60000 }).catch(() => {});
    console.log(`disown review:\n${await or(text(receipt), '(no receipt)')}`);
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/live-recover-disown-${label}.png`, fullPage: true });
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
