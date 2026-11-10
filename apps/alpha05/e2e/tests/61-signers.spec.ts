/**
 * Secondary signers on the Protection page (#3415; ACC-41, RB-ADDRESS-GUARD),
 * against the suite's chain. A protected wallet asks a saved wallet (one that
 * proved control by signing) to be its signer; the accept link opened in
 * another wallet is refused, and in the asked wallet it accepts from that
 * wallet's own key. After the delay by the chain's clock the wallet is made
 * a signer, a co-sign is required, the signer's removal is asked, and once
 * its wait is over the removal is carried out, which also stops the co-sign
 * because no signer is left. A wallet without protected mode is told signers
 * do not apply; once on, a co-sign is not offered without a signer, and a
 * request made outside the app is shown with its link and cancelled. The
 * suite reverts the chain after every test. Runs on the desktop and the phone.
 */
import type { Page } from '@playwright/test';
import type { LaunchWallet } from '@vaipakam/e2e-wallet';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor, type Role } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Launch = LaunchWallet<Role>;

const DAY = 24 * 60 * 60;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Check a signer change's receipt, sign it, and wait for the measured outcome. */
async function sign(page: Page, receiptText: string[], outcomeText: string): Promise<void> {
  const flow = page.getByTestId('signer-panel');
  const receipt = flow.locator('.receipt');
  for (const t of receiptText) await expect(receipt).toContainText(t, { timeout: 60_000 });
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(outcomeText);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(flow).toHaveCount(0);
}

/** Save `other` in the reader's book as a wallet, proved by its own signature. */
async function saveProvenWallet(page: Page, launchWallet: Launch, label: string, other: Hex): Promise<void> {
  const book = page.getByTestId('address-book');
  const add = book.getByTestId('address-book-add');
  await add.locator('#book-label').fill(label);
  await add.locator('#book-address').fill(other);
  const entry = add.getByTestId('address-book-entry-input');
  await expect(entry).toHaveAttribute('data-candidate', 'new', { timeout: 60_000 });
  await entry.getByTestId('address-book-entry-input-checked').check();
  await add.getByTestId('address-book-save').click();
  const link = await book.getByTestId('address-book-pending').getByTestId('address-book-link').inputValue();
  const second = await launchWallet('visitor');
  await second.page.goto(link);
  await connectWallet(second.page);
  const answer = second.page.getByTestId('prove-control');
  await answer.getByTestId('prove-sign').click({ timeout: 60_000 });
  const code = await answer.getByTestId('prove-code').inputValue({ timeout: 60_000 });
  await second.page.close();
  await book.getByTestId('address-book-proof').fill(code);
  await book.getByTestId('address-book-check').click();
  await expect(book.getByTestId('address-book-entry')).toHaveAttribute('data-kind', 'wallet', { timeout: 60_000 });
}

test('a saved wallet is asked, accepts from its own key, becomes a signer, co-signs, and is removed', async ({ launchWallet }) => {
  test.setTimeout(420_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  const other = accountFor('visitor').address as Hex;
  await sc.diamondWrite('lender', 'enableProtectedMode', [2 * DAY, false]);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/protection');
  await connectWallet(page);
  const signers = page.getByTestId('signers');
  await expect(signers.getByTestId('signers-none')).toBeVisible({ timeout: 60_000 });
  await expect(signers).toContainText('Save a wallet above and have it sign to prove it');
  await expect(signers.getByTestId('signers-cosign-on')).toHaveCount(0);
  await expect(signers).toContainText('Add a signer first');

  await saveProvenWallet(page, launchWallet, 'Hardware wallet', other);
  const sent = flags.sentTransactions;

  // Ask it to be a signer.
  await signers.getByTestId('signer-pick').selectOption({ index: 1 });
  await signers.getByTestId('signer-add').click();
  await sign(
    page,
    [
      'Ask a wallet to be a signer',
      other,
      'Hardware wallet',
      '2 days after this is recorded',
      'must also accept from its own key',
      'cannot move anything out of the vault',
    ],
    'asked: can become a signer from',
  );
  const nominee = signers.getByTestId('signer-pending');
  await expect(nominee).toHaveAttribute('data-accepted', 'false', { timeout: 60_000 });
  await expect(nominee).toHaveAttribute('data-state', 'waiting');
  await expect(nominee.getByTestId('signer-apply')).toHaveCount(0);
  const link = await nominee.getByTestId('signer-accept-link').inputValue();
  expect(link).toContain(`/protection?signer=${me}`);
  await fitsWidth(page);

  // Opened in a wallet that was not asked, nothing can be accepted.
  await page.goto(link);
  await connectWallet(page);
  const panel = page.getByTestId('signer-accept-panel');
  await expect(panel.getByTestId('signer-accept-account')).toHaveText(me, { timeout: 60_000 });
  await expect(panel).toContainText('has not asked', { timeout: 60_000 });
  await expect(panel.getByTestId('signer-accept')).toHaveCount(0);

  // The asked wallet accepts from its own key.
  const second = await launchWallet('visitor');
  await second.page.goto(link);
  await connectWallet(second.page);
  const accept = second.page.getByTestId('signer-accept-panel');
  await expect(accept).toContainText('cannot move anything out of the vault', { timeout: 60_000 });
  await accept.getByTestId('signer-accept').click();
  await sign(second.page, ['Accept the signer role', me, 'Nothing moves'], 'You accepted the signer role');
  await expect(accept.getByTestId('signer-accept-done')).toContainText('You have accepted', { timeout: 60_000 });
  await second.page.close();
  expect(flags.sentTransactions).toBe(sent + 1);

  // Once the wait is over by the chain's clock, it is made a signer.
  await anvilRpc('evm_increaseTime', [2 * DAY + 60]);
  await anvilRpc('evm_mine');
  await page.goto('/protection');
  await connectWallet(page);
  await expect(nominee).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(nominee).toHaveAttribute('data-accepted', 'true');
  await nominee.getByTestId('signer-apply').click();
  await sign(page, ['Make a wallet a signer', 'From now on this wallet is a signer'], 'is now a signer');
  expect((await sc.read<readonly Hex[]>('getProtectedSigners', [me])).map((a) => a.toLowerCase())).toEqual([other.toLowerCase()]);
  const row = signers.getByTestId('signer-row');
  await expect(row).toHaveAttribute('data-address', other.toLowerCase(), { timeout: 60_000 });
  await expect(signers).toContainText('1 of at most 5 signers');

  // Require a co-sign: immediate.
  await signers.getByTestId('signers-cosign-on').click();
  await sign(page, ['Require a co-sign on payouts', 'needs a signer’s co-sign'], 'Payouts now need a co-sign');
  await expect(signers.getByTestId('signers-cosign')).toHaveAttribute('data-on', 'true', { timeout: 60_000 });

  // Ask to remove it; it leaves only after the delay.
  await row.getByTestId('signer-remove').click();
  await sign(page, ['Remove a signer', 'Leaves from', 'the signer being removed cannot', 'also stops requiring a co-sign'], 'Removal of');
  await expect(row).toHaveAttribute('data-removing', 'true', { timeout: 60_000 });
  await expect(row.getByTestId('signer-apply-remove')).toHaveCount(0);
  await anvilRpc('evm_increaseTime', [2 * DAY + 60]);
  await anvilRpc('evm_mine');
  await page.reload();
  await connectWallet(page);
  await row.getByTestId('signer-apply-remove').click({ timeout: 60_000 });
  await sign(page, ['Carry out a signer removal', 'stops being a signer now'], 'Payouts no longer need a co-sign');
  expect(await sc.read<readonly Hex[]>('getProtectedSigners', [me])).toHaveLength(0);
  await expect(signers.getByTestId('signers-none')).toBeVisible({ timeout: 60_000 });
  await expect(signers.getByTestId('signers-cosign')).toHaveAttribute('data-on', 'false');
  expect(flags.sentTransactions).toBe(sent + 5);
  await fitsWidth(page);
});

test('without protected mode signers do not apply; a waiting request shows its link and is cancelled', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const other = accountFor('visitor').address as Hex;

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/protection');
  await connectWallet(page);
  const signers = page.getByTestId('signers');
  await expect(signers.getByTestId('signers-mode-off')).toContainText('Protected mode is off', { timeout: 60_000 });
  await expect(signers.getByTestId('signer-add')).toHaveCount(0);

  await sc.diamondWrite('borrower', 'enableProtectedMode', [2 * DAY, false]);
  await sc.diamondWrite('borrower', 'addSigner', [me, other]);
  await page.reload();
  await connectWallet(page);
  const nominee = signers.getByTestId('signer-pending');
  await expect(nominee).toHaveAttribute('data-address', other.toLowerCase(), { timeout: 60_000 });
  await expect(nominee).toContainText('Not in this browser’s saved addresses');
  await expect(nominee).toContainText('It has not accepted yet');
  expect(await nominee.getByTestId('signer-accept-link').inputValue()).toContain(`/protection?signer=${me}`);
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await nominee.getByTestId('signer-cancel').click();
  await sign(page, ['Cancel a signer request', other, 'the wallet does not become a signer'], 'cancelled');
  expect(flags.sentTransactions).toBe(sent + 1);
  await expect(signers.getByTestId('signer-pending')).toHaveCount(0, { timeout: 60_000 });
  const [nominees] = await sc.read<readonly [readonly Hex[], readonly bigint[], readonly boolean[]]>('getPendingSignerAdditions', [me]);
  expect(nominees).toHaveLength(0);
});
