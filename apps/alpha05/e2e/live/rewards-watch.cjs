// Watch-only live review of the Rewards page (#3180; RW-01..RW-11, RW-13,
// RW-14, RW-28, RW-43, RW-44; RB-REWARDS-PROGRAMME, RB-REWARDS-WAIT, RB-REWARDS-VPFI,
// RB-REWARDS-TIER, RB-REWARDS-ELSEWHERE, RB-REWARDS-SIGN; live tier, run
// after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs). The deployed build opens Rewards for the watched
// wallet's network and prints whether the reward programme runs there (the
// sentence's kind, the pause line and, in Advanced, each fact), the rewards
// widget (with the claim's verdict and, when a claim waits or is refused,
// the reason's kind and each line of what a waiting day waits on), the VPFI panel (whether VPFI is set up there, and the wallet's
// VPFI in its wallet, counted, free, held and uncounted), the consent and the
// fee-discount tier card (its state and, when the holding rules hold the tier
// down, the rule it names), and the tier on other networks (its state, the
// record for sending and each network's standing). The
// watch wallet cannot sign, so nothing is deposited, withdrawn, updated or
// sent, and the signed deposit (RW-03) is never offered; those are covered
// by the CI-Anvil specs (54-rewards.spec.ts, 75-rewards-tier-elsewhere.spec.ts,
// 76-rewards-programme.spec.ts).
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
  const prog = p.getByTestId('rewards-programme');
  await p
    .waitForFunction(() => document.querySelector('[data-testid="rewards-programme-now"]')?.getAttribute('data-programme'), null, { timeout: 90000 })
    .catch(() => console.log('(the reward programme was still being read after 90 s)'));
  const now = p.getByTestId('rewards-programme-now');
  const kind = (await now.count()) ? await now.getAttribute('data-programme') : 'none';
  const pause = p.getByTestId('rewards-programme-pause');
  const role = p.getByTestId('rewards-programme-role');
  const marks = `${kind}${(await pause.count()) ? ` pause ${await pause.getAttribute('data-pause')}` : ''}${(await role.count()) ? ` role ${await role.getAttribute('data-role')}` : ''}`;
  if (await prog.count()) console.log(`--- programme [${marks}]: ${(await prog.innerText()).replace(/\n+/g, ' · ')}`);
  const widget = p.getByTestId('rewards-widget');
  if (await widget.count()) {
    const pending = widget.getByTestId('rewards-pending');
    const verdict = (await pending.count()) ? `${await pending.getAttribute('data-figure')}${(await pending.getAttribute('data-why')) ? ` ${await pending.getAttribute('data-why')}` : ''}` : 'reading';
    console.log(`--- rewards [${verdict}]: ${(await widget.innerText()).replace(/\n+/g, ' · ')}`);
    const wait = widget.getByTestId('rewards-wait');
    if (await wait.count()) {
      const lines = await wait.locator('[data-wait-line]').evaluateAll((els) => els.map((e) => e.getAttribute('data-wait-line')));
      console.log(`--- waits on [${await wait.getAttribute('data-wait')}]: ${lines.join(', ')}`);
    }
  }
  console.log(`--- vpfi [${await vpfi.getAttribute('data-vpfi')}]: ${(await vpfi.innerText()).replace(/\n+/g, ' · ')}`);
  const consent = p.getByTestId('consent-toggle');
  if (await consent.count()) console.log(`--- consent: ${(await consent.innerText()).replace(/\n+/g, ' · ')}`);
  const tier = p.getByTestId('rewards-tier-now');
  if (await tier.count()) {
    const held = p.getByTestId('rewards-tier-held');
    const rule = (await held.count()) ? ` held by ${await held.getAttribute('data-held')}` : '';
    console.log(
      `--- tier [${await tier.getAttribute('data-state')} ${await tier.getAttribute('data-tier')}${rule}]: ${(await tier.innerText()).replace(/\n+/g, ' · ')}`,
    );
  }
  const elsewhere = p.getByTestId('rewards-elsewhere');
  if (await elsewhere.count()) {
    await p
      .waitForFunction(
        () => !['checking', 'reading'].includes(document.querySelector('[data-testid="rewards-elsewhere"]')?.getAttribute('data-elsewhere') ?? ''),
        null,
        { timeout: 90000 },
      )
      .catch(() => console.log('(the tier on other networks was still being read after 90 s)'));
    const record = p.getByTestId('rewards-elsewhere-record');
    const rec = (await record.count()) ? ` record ${await record.getAttribute('data-record')}` : '';
    const lanes = await p
      .getByTestId('rewards-elsewhere-lane')
      .evaluateAll((ls) => ls.map((l) => `${l.getAttribute('data-chain')}:${l.getAttribute('data-standing')}`).join(' '));
    console.log(
      `--- elsewhere [${await elsewhere.getAttribute('data-elsewhere')}${rec}${lanes ? ` lanes ${lanes}` : ''}]: ${(await elsewhere.innerText()).replace(/\n+/g, ' · ')}`,
    );
  }
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
