/**
 * The Protection page (#3415 slice 1; ACC-41, RB-ADDRESS-GUARD), against the
 * suite's chain. A protected wallet saves another wallet only after that
 * wallet signs a proof (the link opens in the second wallet, the code comes
 * back by paste); a look-alike of the reader's own address is refused with
 * no override. The saved wallet is asked as a payout destination, waits the
 * delay by the chain's clock, is made active and is removed, each with its
 * review and a measured outcome. A wallet without protected mode is told
 * destinations do not apply; once on, a damaged proof code is refused, an
 * exchange deposit address is saved unverified only after its three risks are
 * acknowledged, and a request for it is cancelled. The suite reverts the
 * chain after every test. Runs on the desktop and the phone.
 */
import type { Locator, Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';
import { allowlistOf, enableProtection } from '../lib/protection';

type Hex = `0x${string}`;

const DAY = 24 * 60 * 60;
/** A checksummed address no wallet in the suite uses (the EIP-55 example). */
const EXCHANGE: Hex = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Check a destination change's receipt, sign it, and wait for the measured outcome. */
async function sign(page: Page, receiptText: string[], outcomeText: string): Promise<void> {
  const flow = page.getByTestId('destination-panel');
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

/** Fill the book's add form: name, address, and (for a new address) the full-address check. */
async function fillAdd(book: Locator, label: string, address: string): Promise<void> {
  const add = book.getByTestId('address-book-add');
  await add.locator('#book-label').fill(label);
  await add.locator('#book-address').fill(address);
  const entry = add.getByTestId('address-book-entry-input');
  await expect(entry).toHaveAttribute('data-candidate', 'new');
  await expect(entry.getByTestId('address-book-entry-input-full')).toHaveText(address);
  await entry.getByTestId('address-book-entry-input-checked').check();
}

test('a wallet joins the book by its signature, is asked, waits the delay, is made active and removed', async ({ launchWallet }) => {
  test.setTimeout(360_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  const other = accountFor('visitor').address;
  await enableProtection(sc, 'lender', 2 * DAY);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/protection');
  await connectWallet(page);
  const dests = page.getByTestId('destinations');
  await expect(dests.getByTestId('destinations-none')).toBeVisible({ timeout: 60_000 });
  await expect(dests).toContainText('Save an address above first');
  const book = page.getByTestId('address-book');
  await expect(book.getByTestId('address-book-empty')).toBeVisible();
  await expect(book).toContainText('kept in this browser only');

  // A look-alike of the reader's own wallet: same first and last three
  // digits, different middle. Refused, with no override.
  const low = me.toLowerCase();
  const middle = low.slice(5, -3) === '0'.repeat(34) ? '1'.repeat(34) : '0'.repeat(34);
  const lookalike = `${low.slice(0, 5)}${middle}${low.slice(-3)}`;
  const add = book.getByTestId('address-book-add');
  await add.locator('#book-label').fill('Cold wallet');
  await add.locator('#book-address').fill(lookalike);
  const entry = add.getByTestId('address-book-entry-input');
  await expect(entry).toHaveAttribute('data-candidate', 'lookalike');
  await expect(entry.getByTestId('address-book-entry-input-lookalike')).toContainText('starts and ends like your own wallet');
  await expect(entry.getByTestId('address-book-entry-input-checked')).toHaveCount(0);
  await expect(add.getByTestId('address-book-save')).toBeDisabled();
  await fitsWidth(page);

  // The other wallet: a first-time address, checked in full, then a proof request.
  await fillAdd(book, 'Cold wallet', other);
  await expect(add.getByTestId('address-book-save')).toHaveText('Ask this wallet to prove it');
  await add.getByTestId('address-book-save').click();
  const pending = book.getByTestId('address-book-pending');
  await expect(pending).toHaveAttribute('data-address', other.toLowerCase());
  await expect(pending).toContainText('Signing moves nothing and costs nothing');
  const link = await pending.getByTestId('address-book-link').inputValue();
  expect(link).toContain('/protection?prove=');
  await fitsWidth(page);

  // Opened in the wrong wallet, nothing can be signed.
  const sent = flags.sentTransactions;
  await page.goto(link);
  await connectWallet(page);
  const prove = page.getByTestId('prove-control');
  await expect(prove).toContainText('The wallet connected now is a different one', { timeout: 60_000 });
  await expect(prove.getByTestId('prove-sign')).toBeDisabled();

  // Opened in the wallet that holds the address, it signs and shows a code.
  const second = await launchWallet('visitor');
  await second.page.goto(link);
  await connectWallet(second.page);
  const answer = second.page.getByTestId('prove-control');
  await expect(answer.getByTestId('prove-destination')).toHaveText(other, { timeout: 60_000 });
  await answer.getByTestId('prove-sign').click();
  const code = await answer.getByTestId('prove-code').inputValue({ timeout: 60_000 });
  expect(code.length).toBeGreaterThan(40);
  await fitsWidth(second.page);
  expect(second.flags.sentTransactions).toBe(0);

  // Back in the first wallet, the pasted code saves a verified wallet.
  await page.goto('/protection');
  await connectWallet(page);
  await book.getByTestId('address-book-proof').fill(code);
  await book.getByTestId('address-book-check').click();
  const saved = book.getByTestId('address-book-entry');
  await expect(saved).toHaveCount(1, { timeout: 60_000 });
  await expect(saved).toHaveAttribute('data-kind', 'wallet');
  await expect(saved).toHaveAttribute('data-address', other.toLowerCase());
  await expect(saved).toContainText('Proved by its signature on');
  await expect(book.getByTestId('address-book-pending')).toHaveCount(0);
  expect(flags.sentTransactions).toBe(sent);

  // Ask for it as a destination.
  await dests.getByTestId('destination-pick').selectOption({ index: 1 });
  await dests.getByTestId('destination-add').click();
  await sign(page, ['Add a payout destination', other, 'Cold wallet', '2 days after this is recorded', 'Nothing changes now'], 'requested: usable from');
  expect(flags.sentTransactions).toBe(sent + 1);
  const row = dests.getByTestId('destination-pending');
  await expect(row).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 });
  await expect(row).toContainText('Usable from');
  await expect(dests.getByTestId('destination-apply')).toHaveCount(0);
  await expect(dests).toContainText('Every saved address is already a destination or waiting');

  // Once the wait is over by the chain's clock, it is made active.
  await anvilRpc('evm_increaseTime', [2 * DAY + 60]);
  await anvilRpc('evm_mine');
  await page.reload();
  await connectWallet(page);
  await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await expect(row).toContainText('Ready: apply it by');
  await row.getByTestId('destination-apply').click();
  await sign(page, ['Make a destination active', 'Apply it by', 'From now on a protected payout may go to this address'], 'is now a destination');
  expect((await allowlistOf(sc, me)).map((a) => a.toLowerCase())).toEqual([other.toLowerCase()]);
  const active = dests.getByTestId('destination-row');
  await expect(active).toHaveAttribute('data-address', other.toLowerCase(), { timeout: 60_000 });
  await expect(active).toContainText('Cold wallet');
  await expect(dests).toContainText('1 of at most 5 destinations');

  // Removal is immediate and states what it cancels.
  await active.getByTestId('destination-remove').click();
  await sign(page, ['Remove a payout destination', 'Payouts it cancels', 'stops being a destination at once'], 'removed');
  expect(await allowlistOf(sc, me)).toHaveLength(0);
  await expect(dests.getByTestId('destinations-none')).toBeVisible({ timeout: 60_000 });
  await fitsWidth(page);
});

test('without protected mode destinations do not apply; an exchange address is saved unverified, asked, then cancelled', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const other = accountFor('visitor').address;

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/protection');
  await connectWallet(page);
  const dests = page.getByTestId('destinations');
  await expect(dests.getByTestId('destinations-mode-off')).toContainText('Protected mode is off', { timeout: 60_000 });
  await expect(dests.getByTestId('destination-add')).toHaveCount(0);

  await enableProtection(sc, 'borrower', 2 * DAY);
  await page.reload();
  await connectWallet(page);
  await expect(dests.getByTestId('destinations-none')).toBeVisible({ timeout: 60_000 });

  // A damaged proof code is refused and saves nothing.
  const book = page.getByTestId('address-book');
  await fillAdd(book, 'Spare wallet', other);
  await book.getByTestId('address-book-save').click();
  const pending = book.getByTestId('address-book-pending');
  await pending.getByTestId('address-book-proof').fill('not-a-proof');
  await pending.getByTestId('address-book-check').click();
  await expect(pending.getByTestId('address-book-proof-note')).toHaveText('This is not a proof code. Paste the whole code the signing wallet showed.');
  await expect(book.getByTestId('address-book-entry')).toHaveCount(0);
  await pending.getByRole('button', { name: 'Drop this request' }).click();
  await expect(pending).toHaveCount(0);

  // An exchange deposit address joins unverified, under the exchange's name,
  // only once its three risks are acknowledged.
  await fillAdd(book, 'Trading account', EXCHANGE);
  const add = book.getByTestId('address-book-add');
  await add.getByTestId('address-book-kind-exchange').check();
  await expect(add).toContainText('anything sent to it is lost');
  await expect(add).toContainText('smart-contract wallet');
  await expect(add).toContainText('give your deposit address to someone else');
  const save = add.getByTestId('address-book-save');
  await expect(save).toHaveText('Save as unverified');
  await expect(save).toBeDisabled();
  await add.locator('#book-exchange').fill('Example Exchange');
  await expect(save).toBeDisabled();
  await add.getByTestId('address-book-exchange-ack').check();
  await fitsWidth(page);
  await save.click();
  const saved = book.getByTestId('address-book-entry');
  await expect(saved).toHaveAttribute('data-kind', 'exchange', { timeout: 30_000 });
  await expect(saved).toContainText('Example Exchange deposit address, unverified');

  // Asked as a destination, the review states the exchange's risks.
  const sent = flags.sentTransactions;
  await dests.getByTestId('destination-pick').selectOption({ index: 1 });
  await expect(dests).toContainText('This is the Example Exchange deposit address you saved unverified');
  await dests.getByTestId('destination-add').click();
  await sign(
    page,
    ['Add a payout destination', EXCHANGE, 'Trading account', 'This is the Example Exchange deposit address you saved unverified'],
    'requested: usable from',
  );
  const row = dests.getByTestId('destination-pending');
  await expect(row).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 });

  // Cancelled before it is applied.
  await row.getByTestId('destination-cancel').click();
  await sign(page, ['Cancel a destination request', 'The request ends now'], 'cancelled');
  expect(flags.sentTransactions).toBe(sent + 2);
  await expect(dests.getByTestId('destination-pending')).toHaveCount(0, { timeout: 60_000 });
  expect(await allowlistOf(sc, me)).toHaveLength(0);
  await fitsWidth(page);
});
