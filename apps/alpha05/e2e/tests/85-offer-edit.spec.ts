/**
 * Changing an open offer in place (#3659, RB-OFFER-EDIT). The
 * why-match panel's rate gap opens the offer's change filled in with the rate
 * that closes it; the review states each figure before and after, that the
 * term stays, and that nothing moves; the finish card checks the protocol's
 * record of the new figures. Raising a lending offer's amount pulls the
 * difference from the wallet through an exact approval into the vault, and
 * lowering it frees the difference in the vault as the lender's own funds
 * (the wallet is untouched), each measured from the transaction's own logs
 * and the protocol's record of the release. Only the creator is offered the change. Runs on the
 * desktop and the phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther } from 'viem';
import { postBorrowRequest, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openOwn(page: Page, id: bigint): Promise<void> {
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
}

test('the why-match rate gap opens the change filled in, and the new rate is the protocol’s record', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  // The lender asks 7%; the request pays 4.5% to 5.5%: the rates do not meet.
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 700, days: 14 });
  await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 450, rateMaxBps: 550, days: 14 });

  const { page, flags } = await launchWallet('lender');
  await openOwn(page, ask);
  const why = page.getByTestId('why-match');
  await expect(why.getByTestId('why-match-verdict')).toHaveAttribute('data-why', 'gap', { timeout: 60_000 });
  const link = why.getByTestId('why-match-change-rate');
  await expect(link).toHaveText('Change my lowest rate to 5.5%');
  await fitsWidth(page);
  await link.click();

  const form = page.getByTestId('offer-edit-form');
  await expect(form).toContainText('What to change');
  await expect(form.getByTestId('offer-edit-rateMin')).toHaveValue('5.5');
  await expect(form.getByTestId('offer-edit-rateMax')).toHaveValue('7');
  await expect(form).toContainText('The term stays 14 days, and the repayment options stay as posted.');
  await fitsWidth(page);
  await form.getByTestId('offer-edit-review').click();

  const flow = page.getByTestId('offer-edit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Change offer #${ask}`, { timeout: 60_000 });
  await expect(receipt).toContainText('7% → 5.5% to 7%');
  await expect(receipt).toContainText('14 days, unchanged');
  await expect(receipt).toContainText('Nothing: only the terms change');
  await expect(receipt).toContainText('Once the change lands, the offer cannot be taken for');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Offer #${ask} changed`);
  expect(flags.sentTransactions).toBe(sent + 1);
  const after = await sc.read<{ interestRateBps: bigint; interestRateBpsMax: bigint }>('getOffer', [ask]);
  expect(after.interestRateBps).toBe(550n);
  expect(after.interestRateBpsMax).toBe(700n);
});

test('raising a lending offer’s amount pulls the difference through an exact approval, and lowering it returns it', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 10 });
  const lender = sc.address('lender');
  const { lendingAsset } = await sc.read<{ lendingAsset: Hex }>('getOffer', [ask]);
  await sc.write('lender', lendingAsset, WETH_ABI, 'deposit', [], parseEther('0.03'));

  const { page, flags } = await launchWallet('lender');
  await openOwn(page, ask);
  await page.getByTestId('offer-page-edit').click();
  const form = page.getByTestId('offer-edit-form');
  await expect(form.getByTestId('offer-edit-amountMax')).toHaveValue('0.05', { timeout: 30_000 });
  await form.getByTestId('offer-edit-amountMax').fill('0.08');
  await form.getByTestId('offer-edit-review').click();

  const flow = page.getByTestId('offer-edit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('From your wallet into your vault', { timeout: 60_000 });
  await expect(receipt).toContainText('0.03 WETH');
  await expect(receipt).toContainText('Approve exactly the 0.03 WETH it takes');
  await expect(receipt).toContainText('What you add stays in your vault, locked to this offer');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await fitsWidth(page);

  let sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('0.03 WETH moved from your wallet into your vault');
  expect(flags.sentTransactions).toBe(sent + 2);
  expect((await sc.read<{ amountMax: bigint }>('getOffer', [ask])).amountMax).toBe(parseEther('0.08'));
  expect(await sc.pub.readContract({ address: lendingAsset, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);
  await finish.getByRole('button', { name: 'Close' }).click();

  // Lowering it frees the difference in the vault, as the lender's own
  // funds; only the lender's own withdrawal reaches the wallet.
  await page.getByTestId('offer-page-edit').click({ timeout: 60_000 });
  await expect(form.getByTestId('offer-edit-amountMax')).toHaveValue('0.08', { timeout: 30_000 });
  await form.getByTestId('offer-edit-amountMax').fill('0.04');
  await form.getByTestId('offer-edit-amountMin').fill('0.04');
  await form.getByTestId('offer-edit-review').click();
  await expect(receipt).toContainText('Released from the offer', { timeout: 60_000 });
  await expect(receipt).toContainText('0.04 WETH');
  await expect(receipt).toContainText('Your vault, as your own funds, free to withdraw');
  await expect(receipt).toContainText('Wallet prompts: 1');
  const before = await sc.pub.readContract({ address: lendingAsset, abi: erc20Abi, functionName: 'balanceOf', args: [lender] });
  sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Returned to your vault, free to withdraw: 0.04 WETH');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: lendingAsset, abi: erc20Abi, functionName: 'balanceOf', args: [lender] })).toBe(before);
  await fitsWidth(page);
});

test('the form refuses a range that is out of order, and only the creator is offered the change', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.03', collateralTliq: '150', rateBps: 500, days: 10 });

  const other = await launchWallet('borrower');
  await openOwn(other.page, ask);
  await expect(other.page.getByTestId('offer-page-edit')).toHaveCount(0);
  await other.ctx.close();

  const { page, flags } = await launchWallet('lender');
  await openOwn(page, ask);
  await page.getByTestId('offer-page-edit').click();
  const form = page.getByTestId('offer-edit-form');
  await expect(form.getByTestId('offer-edit-rateMin')).toHaveValue('5', { timeout: 30_000 });
  await form.getByTestId('offer-edit-review').click();
  await expect(form.getByTestId('offer-edit-problem-unchanged')).toHaveText('Nothing is changed yet.');
  await form.getByTestId('offer-edit-rateMin').fill('9');
  await expect(form.getByTestId('offer-edit-problem-rate-range')).toHaveText('The highest rate cannot be below the lowest.');
  await fitsWidth(page);
  await form.getByTestId('offer-edit-cancel').click();
  await expect(page.getByTestId('offer-page-edit')).toBeVisible();
  expect(flags.sentTransactions).toBe(0);
});
