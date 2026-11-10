/**
 * Rewards (matrix RW-01..RW-10): one page for
 * the wallet's rewards and its VPFI. On the fixture, which sets no VPFI
 * token, the page shows the rewards and the fee-discount consent and says
 * VPFI is not set up, with no deposit or withdrawal offered. With a VPFI
 * token set (a mintable test token stands in for it), the page reads the
 * wallet's VPFI, says nothing can be withdrawn before a vault exists, and
 * deposits it: the receipt states that deposited VPFI counts toward the
 * fee-discount tier and that the wallet's consent is off; the outcome is
 * measured and the counted figure is read again. A withdrawal of all of it
 * says the holding time restarts and that the consent stays as it is, and
 * the chain agrees that nothing stays counted. Away from VPFI's home network
 * (the admin's flag turned off), the page and the deposit receipt say vault
 * VPFI there sets no tier, and the tier table is not shown there. On the
 * home network the tier card states the protocol's own effective tier and
 * names the holding rule that holds it down, from the protocol's own
 * explanation: with 200 counted and the consent on, a holding just begun is
 * held at tier 0 until the minimum holding period ends; four days on tier 1
 * applies (and with the consent off, the card says tier 1 would apply with
 * it on); a same-day dip to tier 0 then holds it at tier 0 by the
 * look-back. Advanced shows each rule's figure and the rules' settings. The
 * table states each tier's VPFI band with the protocol's boundaries,
 * its discount and both fees with it, from the live settings. Where the
 * wallet has already approved Permit2 for VPFI (and only then), the deposit
 * offers to sign instead of approve: one signature and one transaction, the
 * receipt saying what the signature allows and for how long, and nothing
 * approved to the protocol. Runs on the desktop and the phone project; the
 * chain is reverted after each test.
 */
import { erc20Abi, maxUint256, parseEther, type Hex } from 'viem';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const ZERO: Hex = '0x0000000000000000000000000000000000000000';
const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('with no VPFI token set, the page shows rewards and the consent, and offers no VPFI deposit or withdrawal', async ({ launchWallet }) => {
  test.setTimeout(120_000);
  const sc = scenario();
  expect(await sc.read<Hex>('getVPFIToken'), 'the fixture starts with no VPFI token').toBe(ZERO);
  const { page } = await launchWallet('lender', { preAuthorized: false });
  await page.goto('/rewards');
  await expect(page.getByRole('heading', { level: 1, name: 'Rewards' })).toBeVisible();
  await expect(page.getByTestId('rewards-connect')).toBeVisible();
  await connectWallet(page);
  await expect(page.getByTestId('rewards-widget')).toBeVisible({ timeout: 60_000 });
  // The page itself is Rewards: the widget does not link to it.
  await expect(page.getByTestId('rewards-widget').getByRole('link', { name: 'More on Rewards' })).toHaveCount(0);
  const vpfi = page.getByTestId('rewards-vpfi');
  await expect(vpfi).toHaveAttribute('data-vpfi', 'unavailable', { timeout: 60_000 });
  await expect(vpfi).toContainText('VPFI is not set up on this network');
  await expect(page.getByTestId('rewards-vpfi-deposit')).toHaveCount(0);
  await expect(page.getByTestId('rewards-vpfi-withdraw')).toHaveCount(0);
  await expect(page.getByTestId('rewards-tier')).toHaveCount(0);
  await expect(page.getByTestId('consent-toggle')).toBeVisible();
  await fitsWidth(page);
});

test('VPFI is deposited into the vault and counted for the tier, then all of it withdrawn, measured from the chain', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  // A mintable test token stands in for VPFI on the fixture chain.
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  // The fixture deploy leaves the home-network flag unset: the admin sets it,
  // as the home network's deploy does.
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
  expect(await sc.read<boolean>('isCanonicalVpfiChain'), 'this network is VPFI’s home network').toBe(true);
  await sc.write('borrower', token, TOKEN_ABI, 'mint', [me, parseEther('10')]);
  const symbol = await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' });

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/rewards');
  await connectWallet(page);
  const vpfi = page.getByTestId('rewards-vpfi');
  await expect(vpfi).toHaveAttribute('data-vpfi', 'available', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-wallet')).toHaveText(`10 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`0 ${symbol}`);
  await expect(vpfi).toContainText('You have no vault yet; your first deposit creates it.');
  await expect(vpfi).toContainText('VPFI in your vault is not collateral.');
  await expect(page.getByTestId('rewards-vpfi-withdraw-closed')).toContainText('you have no vault on this network yet');
  await expect(page.getByTestId('rewards-vpfi-withdraw')).toBeDisabled();
  await fitsWidth(page);

  // Deposit: the receipt states the tier's side.
  await page.getByTestId('rewards-vpfi-deposit').click();
  await expect(page.getByTestId('vault-deposit-asset')).toHaveCount(0);
  await page.getByTestId('vault-deposit-amount').fill('4');
  await page.getByTestId('vault-deposit-review').click();
  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Deposited VPFI counts toward your fee-discount tier', { timeout: 60_000 });
  await expect(receipt).toContainText('Your fee-discount consent is off');
  await expect(receipt).toContainText('Your vault, created with this deposit');
  await fitsWidth(page);
  let sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Counted in your vault: 4 ${symbol}`);
  expect(flags.sentTransactions).toBe(sent + 2);
  expect(await sc.read<bigint>('getTrackedVPFIBalance', [me])).toBe(parseEther('4'));
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`4 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-free')).toHaveText(`4 ${symbol}`);

  // Withdraw all of it: the holding time restarts, the consent stays.
  await page.getByTestId('rewards-vpfi-withdraw').click();
  await page.getByTestId('vault-withdraw-amount').fill('4');
  await page.getByTestId('vault-withdraw-review').click();
  const out = page.getByTestId('vault-withdraw-panel');
  const outReceipt = out.locator('.receipt');
  await expect(outReceipt).toContainText('This takes your counted VPFI to zero', { timeout: 60_000 });
  await expect(outReceipt).toContainText('Your fee-discount consent stays as it is.');
  await expect(outReceipt).toContainText('This wallet, at once');
  await fitsWidth(page);
  sent = flags.sentTransactions;
  await out.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = out.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Reached your wallet: 4 ${symbol}`);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<bigint>('getTrackedVPFIBalance', [me])).toBe(0n);
  expect(await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(parseEther('10'));
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`0 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-withdraw-closed')).toContainText('no VPFI is counted in your vault');
  await fitsWidth(page);
});

test('away from VPFI’s home network, the page and the deposit receipt say vault VPFI there sets no tier', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  // The admin's own flag says this network is not VPFI's home network.
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [false]);
  await sc.write('borrower', token, TOKEN_ABI, 'mint', [me, parseEther('10')]);

  const { page } = await launchWallet('freshBorrower');
  await page.goto('/rewards');
  await connectWallet(page);
  const vpfi = page.getByTestId('rewards-vpfi');
  await expect(vpfi).toHaveAttribute('data-vpfi', 'available', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-away')).toContainText('On this network VPFI in your vault does not set your fee-discount tier', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-tier-now')).toHaveAttribute('data-state', 'consent-off', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-tier-table-away')).toContainText('Tiers are set on VPFI’s home network');
  await expect(page.getByTestId('rewards-tier-table')).toHaveCount(0);
  await page.getByTestId('rewards-vpfi-deposit').click();
  await page.getByTestId('vault-deposit-amount').fill('4');
  await page.getByTestId('vault-deposit-review').click();
  const receipt = page.getByTestId('vault-deposit-panel').locator('.receipt');
  await expect(receipt).toContainText('On this network deposited VPFI does not count toward your fee-discount tier', { timeout: 60_000 });
  await expect(receipt).not.toContainText('Deposited VPFI counts toward your fee-discount tier');
  await fitsWidth(page);
});

test('the tier card states the tier the protocol applies, names the holding rule that holds it down, and the table each tier’s fees from the live settings', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
  // The fixture keeps the protocol's default tier settings, holding rules
  // and fees; the table and the rules below are stated from them.
  expect(await sc.read<readonly bigint[]>('getVpfiTierThresholds')).toEqual([parseEther('100'), parseEther('1000'), parseEther('5000'), parseEther('20000')]);
  expect(await sc.read<readonly bigint[]>('getVpfiTierDiscountBps')).toEqual([1000n, 1500n, 2000n, 2400n]);
  expect(await sc.read<readonly bigint[]>('getFeesConfig')).toEqual([200n, 20n]);
  expect(await sc.read<Record<string, number>>('getTwaConfig')).toMatchObject({ minStakedDays: 3, windowDays: 30, recentDays: 7, recentWeight: 3, lookbackCapDays: 30 });
  await sc.write('borrower', token, TOKEN_ABI, 'mint', [me, parseEther('200')]);
  const symbol = await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' });

  const { page } = await launchWallet('freshBorrower', { advanced: true });
  await page.goto('/rewards');
  await connectWallet(page);
  const now = page.getByTestId('rewards-tier-now');
  await expect(now).toHaveAttribute('data-state', 'consent-off', { timeout: 60_000 });
  await expect(now).toContainText('Your fee discount is off, so no tier applies to your fees.');
  await expect(page.getByTestId('rewards-tier-would')).toHaveCount(0);
  const rows = page.getByTestId('rewards-tier-row');
  await expect(rows).toHaveCount(5, { timeout: 60_000 });
  await expect(rows.nth(0)).toContainText(`Below 100 ${symbol}`);
  await expect(rows.nth(0)).toContainText('0.2%');
  await expect(rows.nth(1)).toContainText(`100 ${symbol} up to, not including, 1,000 ${symbol}`);
  await expect(rows.nth(1)).toContainText('0.18%');
  await expect(rows.nth(3)).toContainText(`5,000 ${symbol} up to and including 20,000 ${symbol}`);
  await expect(rows.nth(4)).toContainText(`Above 20,000 ${symbol}`);
  await expect(rows.nth(4)).toContainText('24%');
  await expect(rows.nth(4)).toContainText('0.152%');
  await expect(rows.nth(4)).toContainText('1.52%');
  await fitsWidth(page);

  // Consent on and 200 counted: the counted VPFI alone gives tier 1, but a
  // holding only just begun is held at tier 0 until its minimum period ends.
  await sc.diamondWrite('borrower', 'setVPFIDiscountConsent', [true]);
  await sc.write('borrower', token, erc20Abi, 'approve', [sc.diamond, parseEther('200')]);
  await sc.diamondWrite('borrower', 'depositVPFIToVault', [parseEther('200')]);
  expect(await sc.read<readonly [number, number]>('getEffectiveDiscount', [me])).toEqual([0, 0]);
  await expect(now).toHaveAttribute('data-state', 'held-down', { timeout: 60_000 });
  await expect(now).toHaveAttribute('data-tier', '0');
  const held = page.getByTestId('rewards-tier-held');
  await expect(held).toHaveAttribute('data-held', 'too-young');
  await expect(held).toContainText('Your counted VPFI reaches tier 1, but your current holding began');
  await expect(held).toContainText('no tier applies until it has lasted the minimum holding period without falling to zero, on');
  await expect(now).toContainText('Tier 0 applies now');
  const facts = page.getByTestId('rewards-tier-rules');
  await expect(facts).toContainText(`200 ${symbol}, tier 1`);
  await expect(facts).toContainText('Held without falling to zero since');
  await expect(facts).toContainText('A tier applies only once the current holding has lasted 3 days.');
  await expect(facts).toContainText('Over the last 30 days of the current holding; the last 7 days count 3 times.');
  await expect(facts).toContainText('Over the current holding, looking back at most 30 days.');
  await expect(facts).toContainText('Tier 0, 0% off, with your fee discount on');
  await fitsWidth(page);

  // Four days on, every rule allows tier 1, and it applies.
  await increaseTime(4 * 86_400);
  await mine();
  expect(await sc.read<readonly [number, number]>('getEffectiveDiscount', [me])).toEqual([1, 1000]);
  await page.reload();
  await connectWallet(page);
  await expect(now).toHaveAttribute('data-state', 'applies', { timeout: 60_000 });
  await expect(now).toContainText('Tier 1 applies now: 10% off your fees.');
  await expect(facts).toContainText('Tier 1, 10% off, with your fee discount on');

  // With the consent off, no tier applies, and the card says what would.
  await sc.diamondWrite('borrower', 'setVPFIDiscountConsent', [false]);
  await expect(now).toHaveAttribute('data-state', 'consent-off', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-tier-would')).toHaveText('With it on, tier 1 would apply now: 10% off your fees.');
  await sc.diamondWrite('borrower', 'setVPFIDiscountConsent', [true]);

  // A dip to 50 and back the same day: the average stays in tier 1, but the
  // look-back over the holding holds the tier at the lowest one held.
  await sc.diamondWrite('borrower', 'withdrawVPFIFromVault', [parseEther('150')]);
  await sc.write('borrower', token, erc20Abi, 'approve', [sc.diamond, parseEther('150')]);
  await sc.diamondWrite('borrower', 'depositVPFIToVault', [parseEther('150')]);
  expect(await sc.read<{ heldBy: number }>('explainTier', [me])).toMatchObject({ heldBy: 4, rawTier: 1, lookbackTier: 0 });
  await expect(now).toHaveAttribute('data-state', 'held-down', { timeout: 60_000 });
  await expect(held).toHaveAttribute('data-held', 'lookback-dip');
  await expect(held).toHaveText(
    'Your counted VPFI reaches tier 1, but during the look-back over your current holding it fell to tier 0, and a tier never exceeds the lowest one held then, so tier 0 applies.',
  );
  await expect(facts).toContainText('Tier 0');
  await fitsWidth(page);
});

test('where the wallet has already approved Permit2 for VPFI, the deposit can be signed instead of approved: one signature, one transaction, no approval to the protocol', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
  await sc.write('borrower', token, TOKEN_ABI, 'mint', [me, parseEther('10')]);
  const symbol = await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' });

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/rewards');
  await connectWallet(page);
  await expect(page.getByTestId('rewards-vpfi')).toHaveAttribute('data-vpfi', 'available', { timeout: 60_000 });

  // Without the wallet's own approval for Permit2, signing is not offered:
  // the app never asks for that open-ended approval.
  await page.getByTestId('rewards-vpfi-deposit').click();
  await page.getByTestId('vault-deposit-amount').fill('4');
  await page.getByTestId('vault-deposit-review').click();
  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Deposited VPFI counts toward your fee-discount tier', { timeout: 60_000 });
  await expect(flow.getByTestId('vpfi-permit-route')).toHaveCount(0);
  await flow.getByTestId('vault-deposit-change').click();

  // The standing approval for Permit2 a wallet acquires elsewhere, set here
  // directly: the review now offers signing.
  await sc.write('borrower', token, erc20Abi, 'approve', [PERMIT2, maxUint256]);
  await page.getByTestId('vault-deposit-review').click();
  const route = flow.getByTestId('vpfi-permit-route');
  await expect(route).toBeVisible({ timeout: 60_000 });
  await expect(flow.getByTestId('vpfi-permit-approve')).toBeChecked();
  await flow.getByTestId('vpfi-permit-sign').check();
  await expect(receipt).toContainText(`You sign a one-time transfer of exactly 4 ${symbol}, valid for 30 min`, { timeout: 60_000 });
  await expect(receipt).toContainText('only in a transaction this wallet sends');
  await expect(receipt).toContainText('Your wallet’s own approval for Permit2 over VPFI is left as it is.');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Counted in your vault: 4 ${symbol}`);
  await expect(finish).toContainText(`Left your wallet for your vault: 4 ${symbol}`);
  expect(flags.permit2SignatureRequests).toBe(1);
  expect(flags.typedDataRequests.PermitTransferFrom).toBe(1);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<bigint>('getTrackedVPFIBalance', [me])).toBe(parseEther('4'));
  // Nothing was approved to the protocol on the way.
  expect(await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, sc.diamond] })).toBe(0n);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`4 ${symbol}`, { timeout: 60_000 });
  await fitsWidth(page);
});
