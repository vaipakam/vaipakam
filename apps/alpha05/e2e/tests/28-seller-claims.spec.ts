/**
 * Interest owed from a position you sold (matrix LN-52; RB-SELLER-CLAIM),
 * against loans opened, sold and repaid through the protocol's public entry
 * points on the fixture chain. A lender who sells their position keeps the
 * interest they earned and were not yet paid as a claim on the loan; Claims
 * lists the loan (found in the index, or looked up by its number from the
 * chain alone when the index fails), states what is owed net of the fee and
 * what waits in the vault, offers no withdrawal while nothing has reached
 * it, and once something has, withdraws it through one flow whose finish
 * card reports what the transaction's own logs show. Runs on the desktop and
 * the phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther } from 'viem';
import { openLoan, postLenderOffer, repayInFull, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Ledger = readonly [bigint, bigint, bigint, readonly { seller: Hex; grossOwed: bigint }[]];

// See 26-loan-claims: a revert leaves the head at the snapshot's timestamp,
// so a block is mined at once.
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await setIndexPosture('live');
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Open a loan, let ten days of interest accrue, and have the lender sell
 *  the position into a matching buy offer from another wallet. Returns the
 *  loan and what the seller is owed, gross and net of the loan's fee. */
async function soldLoan(sc: ReturnType<typeof scenario>): Promise<{ loanId: bigint; gross: bigint; net: bigint }> {
  const terms = { principalWeth: '1', collateralTliq: '30000', rateBps: 1000, days: 30 };
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', ...terms });
  await anvilRpc('evm_increaseTime', [10 * 86_400]);
  await anvilRpc('evm_mine');
  const buyOfferId = await postLenderOffer(sc, { lender: 'other', ...terms });
  await sc.diamondWrite('lender', 'sellLoanViaBuyOffer', [loanId, buyOfferId]);
  const [, , , claims] = await sc.read<Ledger>('getInterestLedger', [loanId]);
  const mine = claims.find((c) => c.seller.toLowerCase() === sc.address('lender').toLowerCase());
  expect(mine).toBeDefined();
  const { treasuryFeeBpsAtInit } = await sc.read<{ treasuryFeeBpsAtInit: bigint }>('getLoanDetails', [loanId]);
  const fee = BigInt(treasuryFeeBpsAtInit) === 0n ? 100n : BigInt(treasuryFeeBpsAtInit);
  return { loanId, gross: mine!.grossOwed, net: (mine!.grossOwed * (10_000n - fee)) / 10_000n };
}

test('a sold position lists its interest from the index, offers nothing while the loan runs, and withdraws the ended loan’s split', async ({ launchWallet }) => {
  // Two steps each wait out one refresh interval (a minute).
  test.setTimeout(360_000);
  const sc = scenario();
  const { loanId, gross, net } = await soldLoan(sc);
  expect(gross).toBeGreaterThan(0n);
  const seller = sc.address('lender');

  const { page, flags } = await launchWallet('lender');
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Interest from positions you sold' });
  const row = section.locator(`[data-seller-row="${loanId}"]`);

  // Running: owed, stated net of the fee; nothing has reached the vault.
  await expect(row).toContainText('Owed to you, after the protocol’s 2% share of interest', { timeout: 60_000 });
  await expect(row).toContainText('Paid from later interest on this loan, oldest claim first.');
  await expect(row).toContainText('Nothing has reached your vault yet.');
  await expect(row.getByTestId(`seller-withdraw-${loanId}`)).toHaveCount(0);
  await fitsWidth(page);

  // The loan ends: the row offers the split of what the lender side recovered.
  // A payment by another wallet reaches the page on the next own-read
  // interval (a minute while visible, RB-REFRESH), so this waits past one.
  await repayInFull(sc, 'borrower', loanId);
  await expect(row).toContainText('From the ended loan’s recovery', { timeout: 90_000 });
  await expect(row).toContainText('This loan has ended');
  await row.getByTestId(`seller-withdraw-${loanId}`).click();

  const flow = row.getByTestId(`seller-claim-panel-${loanId}`);
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Withdraw the interest loan #${loanId} owes you`, { timeout: 60_000 });
  await expect(receipt).toContainText('Owed to you, after the protocol’s 2% share of interest');
  await expect(receipt).toContainText('From the ended loan’s recovery');
  await expect(receipt).not.toContainText('Stays unpaid when your claim closes');
  await expect(receipt).toContainText('Your wallet');
  await expect(receipt).toContainText('Every open seller claim on the loan closes');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [seller] });
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Your claim closed, paid in full');
  await expect(finish).toContainText(/arrived in your wallet/);
  expect(flags.sentTransactions).toBe(sent + 1);
  // The chain agrees: the net claim, to the wei, and nothing left open.
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [seller] })).toBe(before + net);
  const [, , , after] = await sc.read<Ledger>('getInterestLedger', [loanId]);
  expect(after.length).toBe(0);

  // Closing the card leaves nothing owed: the section says so.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.locator(`[data-seller-row="${loanId}"]`)).toHaveCount(0, { timeout: 60_000 });
  await expect(section.getByTestId('seller-empty')).toBeVisible({ timeout: 60_000 });

  // The index stops answering: the next poll fails, and the section says so
  // and withdraws its "nothing owed" rather than keep the last answer.
  await setIndexPosture('down');
  await expect(section.getByTestId('seller-failed')).toContainText('could not be listed again (the index refused the request)', { timeout: 150_000 });
  await expect(section.getByTestId('seller-empty')).toHaveCount(0);
});

test('when the index fails, a sold loan is looked up by its number and its interest withdrawn while the loan runs', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const { loanId, net } = await soldLoan(sc);
  const seller = sc.address('lender');
  await setIndexPosture('down');

  const { page, flags } = await launchWallet('lender');
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Interest from positions you sold' });
  // Never an empty list: the failure is said, and the lookup offered.
  await expect(section.getByTestId('seller-failed')).toContainText('could not be listed (the index refused the request)', { timeout: 60_000 });
  await expect(section.getByTestId('seller-empty')).toHaveCount(0);
  await section.getByTestId('seller-lookup').fill(String(loanId));
  const row = section.locator(`[data-seller-row="${loanId}"]`);
  await expect(row).toContainText('Nothing has reached your vault yet.', { timeout: 60_000 });

  // A part repayment pays the seller first, into their own vault.
  const half = parseEther('0.5');
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], parseEther('1'));
  await sc.write('borrower', WETH, TOKEN_ABI, 'approve', [sc.diamond, parseEther('1')]);
  await sc.diamondWrite('borrower', 'repayPartial', [loanId, half]);
  // Another wallet's payment: seen on the next own-read interval (see above).
  await expect(row).toContainText('Ready in your vault', { timeout: 90_000 });
  await fitsWidth(page);
  await row.getByTestId(`seller-withdraw-${loanId}`).click();

  const flow = row.getByTestId(`seller-claim-panel-${loanId}`);
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Withdraw the interest loan #${loanId} owes you`, { timeout: 60_000 });
  await expect(receipt).toContainText('Ready in your vault');
  await expect(receipt).not.toContainText('From the ended loan’s recovery');
  await expect(receipt).toContainText('Wallet prompts: 1');

  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [seller] });
  const held = await sc.read<bigint>('getSellerInterestHeld', [loanId, seller, WETH]);
  expect(held).toBeGreaterThan(0n);
  // Paid net of the fee; the per-second figure may differ by rounding only.
  expect(held > net ? held - net : net - held).toBeLessThanOrEqual(2n);
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/arrived in your wallet/);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [seller] })).toBe(before + held);

  // The finish card stays until closed, though the loan no longer owes this
  // wallet anything; then the lookup says so.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.getByTestId('seller-lookup-nothing')).toContainText(`Nothing is owed to you on loan #${loanId} as a past seller.`, { timeout: 60_000 });
  await expect(section.locator(`[data-seller-row="${loanId}"]`)).toHaveCount(0);
});
