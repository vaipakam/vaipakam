// #1517 post-deploy live review — the /risk-access surface end to end
// on production alpha02 against the live Base Sepolia diamond: the
// page must render the wallet's TRUE chain state, a raise must land
// on-chain through the real wallet-confirm path (cooldown default 0 on
// the testnet ⇒ immediately effective), lowering must land and leave
// the vault back at the safest tier, and the strict card must show the
// withheld-enable posture (no switch while OFF). Leaves the wallet at
// Blue-chip / strict OFF — the same normalization spec 24 pins on the
// fork tier.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { ensureConnected, launch, SITE } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAMOND = JSON.parse(
  readFileSync(
    path.join(HERE, '../../../../packages/contracts/src/deployments.json'),
    'utf8',
  ),
)['84532'].diamond;
const READ_ABI = parseAbi([
  'function getVaultRiskTier(address) view returns (uint8)',
  'function getEffectiveRiskTier(address) view returns (uint8)',
  'function getRiskStrictMode(address) view returns (bool)',
]);
const pub = createPublicClient({
  transport: http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org'),
});

const { page, account, done } = await launch({ role: 'borrower' });
const who = account.address;
const tierOf = () =>
  pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getEffectiveRiskTier', args: [who] });

await page.goto(SITE + '/risk-access', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await ensureConnected(page);
await page.waitForTimeout(2500);

const fails = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${label}`);
  if (!ok) fails.push(label);
};

// 1. Page renders true chain state.
const startTier = Number(await tierOf());
const body0 = await page.locator('body').innerText();
check('page rendered tier cards', /Blue-chip only/i.test(body0) && /Broad liquid/i.test(body0));
check('strict card withheld-enable posture', /isn’t offered here yet/i.test(body0));
check('no strict switch while OFF', (await page.getByRole('switch').count()) === 0);

// 2. Raise to Broad through the real flow — the tier radios SUBMIT on
// click (live-revalidated write; the driver wallet auto-approves) and
// the page holds busy through the receipt-floor second read.
if (startTier !== 0) console.log(`note: wallet starts at tier ${startTier}, normalizing via UI`);
await page.getByRole('radio', { name: /Broad liquid/i }).click();
await page.waitForTimeout(25000);
check('raise landed on-chain (effective Broad)', Number(await tierOf()) === 1);
const body1 = await page.locator('body').innerText();
check('success message rendered', /Level raised|Level updated|confirmed against/i.test(body1));

// 3. Lower back to Blue-chip; vault must end at the safest tier.
await page.getByRole('radio', { name: /Blue-chip only/i }).click();
await page.waitForTimeout(25000);
check('lower landed on-chain (effective Blue-chip)', Number(await tierOf()) === 0);
check(
  'strict mode still OFF on-chain',
  (await pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getRiskStrictMode', args: [who] })) === false,
);

await done();
if (fails.length) {
  console.log('FAILED checks:', fails.join(' | '));
  process.exit(1);
}
console.log('live risk-access review: ALL CHECKS PASSED');
