// #1517 post-deploy live review — the /risk-access surface end to end
// on production alpha02 against the live Base Sepolia diamond: the
// page must render the wallet's TRUE chain state (selection compared
// against the chain, not just labels present — Codex #1539 r1), a
// raise must land on-chain through the real wallet-confirm path
// (cooldown default 0 on the testnet ⇒ immediately effective),
// lowering must land and leave the vault back at the safest tier, and
// the strict card must show the withheld-enable posture (no switch
// while OFF). The driver NORMALIZES to Blue-chip before measuring the
// raise (safely rerunnable after an aborted run) and POLLS chain +
// UI to bounded timeouts instead of assuming settlement latency.
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
const TIER_LABELS = [/Blue-chip only/i, /Broad liquid/i, /Illiquid \/ custom/i];

const { page, account, done } = await launch({ role: 'borrower' });
const who = account.address;
const rawTierOf = () =>
  pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getVaultRiskTier', args: [who] });
const tierOf = () =>
  pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getEffectiveRiskTier', args: [who] });

/** Bounded poll — production settlement latency is not assumable
 *  (Codex #1539 r1): a valid write can take well past a fixed sleep
 *  to mine AND to surface through the page's post-receipt reread. */
async function pollUntil(label, fn, { timeoutMs = 150000, everyMs = 3000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) {
      console.log(`poll timed out: ${label}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const fails = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${label}`);
  if (!ok) fails.push(label);
};
/** The page's selected radio must NAME the chain's raw tier — the
 *  read-path assertion a label-presence check cannot make. Polled:
 *  right after a write the page's own reconciling reread (receipt
 *  floor + delayed second read) legitimately trails the chain by a
 *  few seconds, and a lagging public RPC stretches that further. */
async function assertSelectionMatchesChain(context) {
  const ok = await pollUntil(
    `${context}: selection matches chain`,
    async () => {
      const raw = Number(await rawTierOf());
      const selected = page.getByRole('radio', { checked: true });
      if ((await selected.count()) !== 1) return false;
      const name = (await selected.innerText()).split('\n')[0];
      return TIER_LABELS[raw].test(name);
    },
    { timeoutMs: 45000 },
  );
  check(`${context}: selected radio matches chain raw tier`, ok);
}

await page.goto(SITE + '/risk-access', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await ensureConnected(page);
await page.waitForTimeout(2500);

// 1. Read path: the rendered selection reflects the chain.
const body0 = await page.locator('body').innerText();
check('page rendered tier cards', /Blue-chip only/i.test(body0) && /Broad liquid/i.test(body0));
check('strict card withheld-enable posture', /isn’t offered here yet/i.test(body0));
check('no strict switch while OFF', (await page.getByRole('switch').count()) === 0);
await assertSelectionMatchesChain('pre-write');

// 2. Normalize to Blue-chip FIRST (rerunnable after an aborted run;
// also guarantees the next step is genuinely a raise).
if (Number(await rawTierOf()) !== 0) {
  console.log('note: wallet not at Blue-chip — normalizing via UI first');
  await page.getByRole('radio', { name: /Blue-chip only/i }).click();
  check(
    'normalization landed (effective Blue-chip)',
    await pollUntil('normalize to 0', async () => Number(await tierOf()) === 0),
  );
  await page.waitForTimeout(4000); // let the page's reread settle
}

// 3. Raise to Broad through the real flow — the tier radios SUBMIT on
// click (live-revalidated write; the driver wallet auto-approves).
await page.getByRole('radio', { name: /Broad liquid/i }).click();
check(
  'raise landed on-chain (effective Broad)',
  await pollUntil('raise to 1', async () => Number(await tierOf()) === 1),
);
check(
  'success message rendered',
  await pollUntil('success copy', async () => {
    const t = await page.locator('body').innerText();
    // Both wordings accepted across the copy-direction change.
    return /now using a riskier level|level raised|level updated|confirmed against/i.test(t);
  }, { timeoutMs: 60000 }),
);
await assertSelectionMatchesChain('post-raise');

// 4. Lower back to Blue-chip; vault must end at the safest tier.
await page.getByRole('radio', { name: /Blue-chip only/i }).click();
check(
  'lower landed on-chain (effective Blue-chip)',
  await pollUntil('lower to 0', async () => Number(await tierOf()) === 0),
);
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
