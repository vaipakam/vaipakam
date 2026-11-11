/**
 * The Vault page's safety card (matrix ACC-36 Basic face, ACC-37, ACC-43),
 * through the protocol's public entry points on the fixture chain. A wallet
 * without protected mode turns it on in Basic mode: the card offers the
 * shortest delay the protocol allows, the review says what waits and that
 * nothing owed to others is delayed, and the finish card states the delay
 * the protocol recorded. A protected wallet with one queued payout locks its
 * account (the review counts the payout it cancels), asks to unlock, and once
 * the delay has passed on chain applies the due unlock. Runs on the desktop
 * and the phone project, with wallets that have no history; the chain is
 * reverted after each test.
 */
import { parseAbi, parseEther } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { enableProtection, protectionMode } from '../lib/protection';

type Hex = `0x${string}`;

const DAY = 24 * 60 * 60;
const HOLDER_LOCK = parseAbi(['function isLocked(address holder) view returns (bool)']);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('protected mode is turned on in Basic mode with the shortest delay, and the finish card states it', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const card = page.getByTestId('vault-safety');
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'off', { timeout: 60_000 });
  await card.getByTestId('vault-safety-turn-on').click();
  await expect(card.getByTestId('vault-safety-basic-choice')).toContainText('The delay is 2 days, the shortest allowed');
  await fitsWidth(page);
  await card.getByTestId('vault-safety-review').click();

  const flow = card.getByTestId('vault-safety-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Turn on protected mode', { timeout: 60_000 });
  await expect(receipt).toContainText('Every payout from your vault to this wallet');
  await expect(receipt).toContainText('It never delays what you owe others');
  // #3379 B2: a wallet with no vault creates it, the vault turns the mode
  // on, and the Diamond applies it: three prompts.
  await expect(receipt).toContainText('Wallet prompts: 3');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Protected mode is on: payouts to your wallet wait 2 days.');
  expect(flags.sentTransactions).toBe(sent + 3);
  const mode = await protectionMode(sc, me);
  expect(mode.enabled).toBe(true);
  expect(Number(mode.delaySeconds)).toBe(2 * DAY);
  // Basic mode leaves position NFT protection off: no holder lock at the
  // standalone PositionNFT (#3205), and the card says so.
  const core = await sc.read<Hex>('positionNFT', []);
  expect(await sc.pub.readContract({ address: core, abi: HOLDER_LOCK, functionName: 'isLocked', args: [me] })).toBe(false);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'on', { timeout: 60_000 });
  await expect(card.getByTestId('vault-safety-lock')).toBeVisible();
  await expect(card.getByTestId('vault-safety-nfts')).toHaveText('Off');
  await fitsWidth(page);
});

test('a lock cancels the queued payout, and the unlock is asked, waits the delay, then is applied', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  const amount = parseEther('0.01');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], amount);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, amount]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, amount]);
  await enableProtection(sc, 'lender', 2 * DAY);
  await sc.diamondWrite('lender', 'withdrawFromVault', [me, 0, WETH, 0n, amount, me]);
  expect(await sc.read<readonly bigint[]>('getPendingPayoutIds', [me])).toHaveLength(1);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const card = page.getByTestId('vault-safety');
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'on', { timeout: 60_000 });
  await expect(card.getByTestId('vault-safety-queued')).toHaveText('1');
  await card.getByTestId('vault-safety-lock').click();

  const flow = card.getByTestId('vault-safety-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Lock your account', { timeout: 60_000 });
  await expect(receipt).toContainText('Queued payouts it cancels');
  await expect(receipt).toContainText('Repaying, adding collateral and payments to you keep working');
  await fitsWidth(page);
  let sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Your account is locked.');
  await expect(finish).toContainText('Queued payouts cancelled: 1.');
  // #3379 B2: the vault's lock, then the Diamond applying it.
  expect(flags.sentTransactions).toBe(sent + 2);
  expect(await sc.read<readonly bigint[]>('getPendingPayoutIds', [me])).toHaveLength(0);
  expect((await protectionMode(sc, me)).locked).toBe(true);
  await finish.getByRole('button', { name: 'Close' }).click();

  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'locked', { timeout: 60_000 });
  await card.getByTestId('vault-safety-unlock').click();
  await expect(receipt).toContainText('Ask to unlock your account', { timeout: 60_000 });
  await expect(receipt).toContainText('2 days after this is confirmed');
  sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Unlock requested: it takes effect from');
  expect(flags.sentTransactions).toBe(sent + 1);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByTestId('vault-safety-pending-unlock')).toContainText('Unlock: takes effect from', { timeout: 60_000 });
  await expect(card.getByTestId('vault-safety-finalize')).toHaveCount(0);

  await anvilRpc('evm_increaseTime', [2 * DAY + 60]);
  await anvilRpc('evm_mine');
  await card.getByTestId('vault-safety-finalize').click({ timeout: 60_000 });
  await expect(receipt).toContainText('Apply the changes that are due', { timeout: 60_000 });
  await expect(receipt).toContainText('It applies every change that is due');
  sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Unlock');
  // #3379 B2: the vault applies the unlock, then the Diamond applies it.
  expect(flags.sentTransactions).toBe(sent + 2);
  expect((await protectionMode(sc, me)).locked).toBe(false);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'on', { timeout: 60_000 });
  await fitsWidth(page);
});
