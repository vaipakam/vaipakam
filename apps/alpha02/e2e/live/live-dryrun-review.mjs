// #1058 post-merge live review — the advisory pre-sign dry run on
// production alpha02: drive the lend post-offer flow to review, tick
// consent, confirm the footer renders a real verdict.
import fs from 'node:fs';
import { launch, SITE } from './driver.mjs';

// Faucet mock addresses (Base Sepolia). Override with FAUCET_JSON to
// point at a deployments artifact; defaults to the live testnet set.
const faucet = process.env.FAUCET_JSON
  ? JSON.parse(fs.readFileSync(process.env.FAUCET_JSON, 'utf8'))
  : { illiquidToken: '0x2affacdea8119e38d9754b2c2c15ec79af360807' };
const TILQ = faucet.illiquidToken;
const TILQ2 = '0x2A6c7149199991243aCbc04e1d59Aa052A6f00c3';

const { page, done } = await launch({ role: 'lender' });
await page.goto(SITE + '/lend', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('#lending-asset').selectOption('__custom__');
await page.locator('#lending-asset ~ input[placeholder="0x…"]').fill(TILQ);
await page.waitForTimeout(1500);
await page.locator('input[placeholder="0.0"]').fill('25');
await page.getByRole('button', { name: /see matching offers/i }).click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /post my own lending offer/i }).click();
await page.waitForTimeout(800);
await page.locator('input[placeholder="5"]').fill('9');
await page.locator('#collateral-asset').selectOption('__custom__').catch(() => {});
await page.locator('#collateral-asset ~ input[placeholder="0x…"]').fill(TILQ2);
await page.waitForTimeout(1500);
await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
await page.waitForTimeout(800);
await page.getByRole('button', { name: /continue to review/i }).click();
await page.waitForTimeout(3000);

// Tick every visible checkbox on the review (consent; both-illiquid
// acknowledgements if present) — the dry run only builds once the
// risk/terms consent is on.
for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
  await box.check().catch(() => {});
}
console.log('consent ticked, waiting for dry run…');
await page.waitForTimeout(8000);

const body = await page.locator('body').innerText();
const verdicts = {
  running: body.includes('free dry run of this transaction'),
  passed: body.includes('Dry run passed'),
  approval: body.includes('token approval will be requested first'),
  wouldFail: body.includes('dry run of this exact transaction just failed'),
  unavailable: body.includes('dry run isn’t available'),
};
console.log('verdict flags:', JSON.stringify(verdicts));
// Only the two truthful outcomes pass — wouldFail IS the #1059
// regression this driver exists to catch, and unavailable/running
// mean no verdict was actually delivered.
const any = verdicts.passed || verdicts.approval;
console.log(
  any
    ? 'PASS — truthful dry-run verdict rendered'
    : `FAIL — verdicts: ${JSON.stringify(verdicts)}`,
);
{
  const i = body.indexOf('just failed with');
  if (i !== -1) console.log('REVERT TEXT:', body.slice(Math.max(0, i - 80), i + 400));
}
await done();
process.exit(any ? 0 : 1);
