/**
 * The Vault page's safety card (matrix ACC-36 Basic face, ACC-37, ACC-43),
 * through the protocol's public entry points on the fixture chain. A wallet
 * without protected mode creates its vault, sets a recovery address that a
 * second wallet proves by its signature (#3246 part 2), then turns the mode
 * on in Basic mode: the card offers the
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
import { accountFor } from '../lib/wallets';

type Hex = `0x${string}`;

const DAY = 24 * 60 * 60;
const HOLDER_LOCK = parseAbi(['function isLocked(address holder) view returns (bool)']);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a recovery address another wallet proves comes first; then protected mode is turned on in Basic mode with the shortest delay', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  const recovery = accountFor('visitor').address;

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const card = page.getByTestId('vault-safety');
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'off', { timeout: 60_000 });
  // #3246 part 2: no recovery address yet, so switching on is not offered,
  // and the vault that keeps the address comes first.
  const section = card.getByTestId('vault-safety-recovery');
  await expect(section.getByTestId('vault-safety-recovery-state')).toHaveAttribute('data-state', 'none', { timeout: 60_000 });
  await expect(card.getByTestId('vault-safety-turn-on')).toHaveCount(0);
  await expect(section).toContainText('Create your vault on this page first');
  await fitsWidth(page);

  let sent = flags.sentTransactions;
  await page.getByTestId('vault-create').click();
  const create = page.getByTestId('vault-create-panel');
  await create.getByRole('button', { name: 'Confirm in wallet' }).click({ timeout: 60_000 });
  const created = create.locator('[data-phase="measured"]');
  await expect(created).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(flags.sentTransactions).toBe(sent + 1);
  await created.getByRole('button', { name: 'Close' }).click();

  // The owner names the address; its own wallet is refused.
  await section.getByTestId('vault-safety-recovery-choose').click({ timeout: 60_000 });
  const address = section.getByTestId('vault-safety-recovery-address');
  await address.fill(me);
  await expect(section).toContainText('This is your own wallet');
  await expect(section.getByTestId('vault-safety-recovery-link-make')).toBeDisabled();
  await address.fill(recovery);
  await section.getByTestId('vault-safety-recovery-link-make').click();
  const link = await section.getByTestId('vault-safety-recovery-link').inputValue();
  await fitsWidth(page);

  // The recovery wallet signs its proof from its own key: nothing is sent.
  const second = await launchWallet('visitor');
  await second.page.goto(link);
  await connectWallet(second.page);
  const sign = second.page.getByTestId('recovery-sign-panel');
  await expect(sign.getByTestId('recovery-sign-account')).toHaveText(me, { timeout: 60_000 });
  await expect(sign).toContainText('Signing moves nothing and costs nothing.');
  await sign.getByTestId('recovery-sign').click({ timeout: 60_000 });
  const answer = await sign.getByTestId('recovery-answer-link').inputValue({ timeout: 60_000 });
  expect(second.flags.sentTransactions).toBe(0);
  await second.page.close();

  // The owner opens the answer: the request is reviewed and sent.
  await page.goto(answer);
  await connectWallet(page);
  let flow = card.getByTestId('vault-safety-panel');
  let receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Set your recovery address', { timeout: 60_000 });
  await expect(receipt).toContainText(recovery);
  await expect(receipt).toContainText('4 days after this is confirmed');
  await expect(receipt).toContainText('a clawback moves its free funds to this address, and nowhere else');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);
  sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('asked as your recovery address');
  expect(flags.sentTransactions).toBe(sent + 1);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.getByTestId('vault-safety-recovery-pending')).toContainText(recovery, { timeout: 60_000 });
  // A waiting address can be cancelled from the same line (not done here: turning on needs it).
  await expect(section.getByTestId('vault-safety-recovery-cancel')).toBeVisible();

  await card.getByTestId('vault-safety-turn-on').click({ timeout: 60_000 });
  await expect(card.getByTestId('vault-safety-basic-choice')).toContainText('The delay is 2 days, the shortest allowed');
  await fitsWidth(page);
  await card.getByTestId('vault-safety-review').click();

  flow = card.getByTestId('vault-safety-panel');
  receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Turn on protected mode', { timeout: 60_000 });
  await expect(receipt).toContainText('Every payout from your vault to this wallet');
  await expect(receipt).toContainText('It never delays what you owe others');
  // The vault exists now; it turns the mode on and applies the platform side
  // in the same transaction (#3489 r16): one prompt.
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Protected mode is on: payouts to your wallet wait 2 days.');
  expect(flags.sentTransactions).toBe(sent + 1);
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
  // #3489 r9: one transaction, the vault's lock, which applies the platform
  // side (the queued payout cancelled) in the same transaction.
  expect(flags.sentTransactions).toBe(sent + 1);
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
  // #3489 r12: one transaction, the vault's finalizer, which applies the
  // unlock's platform side in the same transaction.
  expect(flags.sentTransactions).toBe(sent + 1);
  expect((await protectionMode(sc, me)).locked).toBe(false);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByTestId('vault-safety-state')).toHaveAttribute('data-state', 'on', { timeout: 60_000 });
  await fitsWidth(page);
});
