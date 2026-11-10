/**
 * Extension reserves (matrix LN-62; RB-RESERVE), against a loan opened and
 * repaid through the protocol's public entry points on the fixture chain.
 * The borrower sets aside the loan's token in their own vault for its
 * extensions; Claims lists the reserve (found in the index), says an
 * extension of the running loan draws on it first, and once the loan has
 * ended says nothing can draw on it any more. The whole reserve is then
 * taken back through one flow whose finish card reports what the
 * transaction's own logs show, and the list says nothing is left. Runs on
 * the desktop and the phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther } from 'viem';
import { openLoan, repayInFull, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Funding = readonly [Hex, bigint, bigint, bigint, bigint];

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a borrower’s extension reserve is listed, drawable while the loan runs, and taken back in full once it has ended', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const borrowerAddr = sc.address('borrower');
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 600, days: 30 });

  // The borrower sets 0.05 WETH aside for the loan's extensions.
  const reserve = parseEther('0.05');
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], reserve);
  await sc.write('borrower', WETH, erc20Abi, 'approve', [sc.diamond, reserve]);
  await sc.diamondWrite('borrower', 'fundExtendReserve', [loanId, reserve]);
  const [, reserved] = await sc.read<Funding>('getExtendFunding', [loanId, borrowerAddr]);
  expect(reserved).toBe(reserve);

  const { page, flags } = await launchWallet('borrower');
  await page.goto('/claims');
  await connectWallet(page);
  // Every kind of payout Claims lists is on the page: nothing points elsewhere.
  await expect(page.getByTestId('claims-not-yet')).toHaveCount(0);
  const section = page.getByRole('region', { name: 'Extension reserves' });
  const row = section.locator(`[data-reserve-row="${loanId}"]`);
  await expect(row.getByTestId(`reserve-amount-${loanId}`)).toContainText('0.05 WETH', { timeout: 60_000 });
  await expect(row.getByTestId(`reserve-draw-${loanId}`)).toHaveAttribute('data-drawable', 'true');
  await expect(row).toContainText('An extension of this loan draws on this reserve first');
  await expect(row.getByTestId(`reserve-withdraw-${loanId}`)).toBeVisible();
  await fitsWidth(page);

  // The loan is repaid: no extension can draw on the reserve; it stays the
  // borrower's to take back.
  await repayInFull(sc, 'borrower', loanId);
  await page.reload();
  await connectWallet(page);
  await expect(row.getByTestId(`reserve-draw-${loanId}`)).toHaveAttribute('data-drawable', 'false', { timeout: 60_000 });
  await expect(row).toContainText('No extension can draw on this reserve now.');
  await expect(row.getByTestId(`reserve-amount-${loanId}`)).toContainText('0.05 WETH');
  await row.getByTestId(`reserve-withdraw-${loanId}`).click();

  const flow = row.getByTestId(`reserve-panel-${loanId}`);
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Take back your extension reserve on loan #${loanId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Reserved in your vault for this loan’s extensions');
  await expect(receipt).not.toContainText('no longer has this reserve to draw on');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [borrowerAddr] });
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/arrived in your wallet/);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [borrowerAddr] })).toBe(before + reserve);
  const [, left] = await sc.read<Funding>('getExtendFunding', [loanId, borrowerAddr]);
  expect(left).toBe(0n);

  // The finish card stays until closed; then nothing is left to list.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.getByTestId('reserve-empty')).toContainText('You have no extension reserve left on any loan.', { timeout: 60_000 });
  await expect(section.locator(`[data-reserve-row="${loanId}"]`)).toHaveCount(0);
});
