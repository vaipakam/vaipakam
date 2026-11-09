/**
 * Frozen proceeds (matrix LN-53; RB-FROZEN), against a loan opened and
 * repaid through the protocol's public entry points on the fixture chain,
 * with a sanctions screen installed that flags the lender. The protocol
 * never stops a loan from closing for a flagged party: the borrower's
 * repayments complete, and the lender's share is parked, locked, until the
 * wallet is de-listed. The app says so where the money is: the loan's page
 * names what a running loan already reserved for the lender position, and
 * Claims states "Frozen, awaiting de-listing" with no claim offered. While
 * the screen cannot be read, a wallet confirmed flagged before stays frozen
 * (release is fail-closed), and the claim's dry run refusal is said in the
 * same words. Once de-listed, the payout collects in full.
 *
 * Runs on the desktop and the phone project. The screen is a contract
 * placed with `anvil_setCode` at a fixed address and set as the Diamond's
 * oracle by the fixture's admin; the chain is reverted after each test, so
 * neither the screen nor anything it froze reaches a later spec.
 */
import { erc20Abi, parseEther } from 'viem';
import { openLoan, repayInFull, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Claimable = readonly [Hex, bigint, boolean, number, bigint, bigint, bigint, boolean];

const ORACLE = '0x000000000000000000000000000000000000f1a6' as Hex;
/** `isSanctioned(address)` answers true for `flagged` alone: PUSH20 flagged,
 *  PUSH1 4, CALLDATALOAD, EQ, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN. */
const flagsOnly = (flagged: Hex): Hex => `0x73${flagged.slice(2).toLowerCase()}6004351460005260206000f3`;
/** Every call reverts: the screen cannot be read. */
const OUTAGE = '0x60006000fd' as Hex;
/** Every address reads clean. */
const CLEAN = '0x600060005260206000f3' as Hex;

let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a flagged lender’s payout waits frozen, through an outage, and collects once de-listed', async ({ launchWallet }) => {
  const sc = scenario();
  const lenderAddr = sc.address('lender');
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 600, days: 30 });

  // The screen flags the lender, and the protocol's registry records it as
  // confirmed (anyone may sync it from the screen).
  await anvilRpc('anvil_setCode', [ORACLE, flagsOnly(lenderAddr)]);
  await sc.diamondWrite('admin', 'setSanctionsOracle', [ORACLE]);
  await sc.diamondWrite('borrower', 'refreshSanctionsFlag', [lenderAddr]);
  expect(await sc.read<number>('sanctionsStatus', [lenderAddr])).toBe(1);

  // A part payment while the lender is flagged completes; the lender's share
  // is reserved for the position instead of paid.
  await sc.warp(3 * 86_400);
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], parseEther('0.2'));
  await sc.write('borrower', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.2')]);
  await sc.diamondWrite('borrower', 'repayPartial', [loanId, parseEther('0.1')]);
  const [, , , , , , held] = await sc.read<Claimable>('getClaimable', [loanId, true]);
  expect(held).toBeGreaterThan(0n);

  const { page } = await launchWallet('lender');

  // The loan's page: the wallet's standing, and what is reserved for it.
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const notice = page.getByTestId('frozen-notice');
  await expect(notice).toHaveAttribute('data-state', 'flagged', { timeout: 60_000 });
  await expect(notice).toContainText('Frozen, awaiting de-listing.');
  await expect(notice).toContainText('Nothing held for it is taken');
  const reserved = page.getByTestId('position-held-for-lender');
  await expect(reserved).toContainText(/WETH the loan already paid is held for the lender position/, { timeout: 60_000 });
  await expect(page.getByTestId('position-held-for-lender-unread')).toHaveCount(0);
  await fitsWidth(page);

  // The borrower repays the rest: the loan closes; the lender's payout is
  // frozen for it.
  await repayInFull(sc, 'borrower', loanId);
  const [, owed] = await sc.read<Claimable>('getClaimable', [loanId, true]);
  expect(owed).toBeGreaterThan(0n);

  await page.reload();
  await connectWallet(page);
  const refusal = page.getByTestId('loan-claim-refusal-lender');
  await expect(refusal).toHaveAttribute('data-code', 'SanctionedAddress', { timeout: 60_000 });
  await expect(refusal).toContainText('Frozen, awaiting de-listing: the sanctions screen flags this wallet');
  await expect(page.getByTestId('loan-claim-open-lender')).toHaveCount(0);

  // Claims says the same, with no claim offered.
  await page.goto('/claims');
  await expect(page.getByTestId('frozen-notice')).toHaveAttribute('data-state', 'flagged', { timeout: 60_000 });
  const card = page.locator(`[data-claim="lender:${loanId}"]`);
  await expect(card.locator('[data-code="SanctionedAddress"]')).toContainText('stays locked, not lost', { timeout: 60_000 });
  await expect(card.getByTestId(`claims-open-lender-${loanId}`)).toHaveCount(0);
  await fitsWidth(page);

  // The screen cannot be read: a wallet confirmed flagged before stays
  // frozen. The caller check lets the claim be asked, and the protocol's dry
  // run refuses the frozen payout until the screen answers again.
  await anvilRpc('anvil_setCode', [ORACLE, OUTAGE]);
  await page.reload();
  await connectWallet(page);
  await expect(page.getByTestId('frozen-notice')).toHaveAttribute('data-state', 'outage', { timeout: 60_000 });
  await expect(page.getByTestId('frozen-notice')).toContainText('a payment due to it in this time is parked the same way');
  await card.getByTestId(`claims-open-lender-${loanId}`).click({ timeout: 60_000 });
  const flow = card.getByTestId('loan-claim-panel-lender');
  await expect(flow).toContainText('Frozen until the sanctions screen can be read', { timeout: 60_000 });
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await fitsWidth(page);

  // De-listed: nothing is frozen, and the payout collects in full, the
  // reserved part with it.
  await anvilRpc('anvil_setCode', [ORACLE, CLEAN]);
  await sc.diamondWrite('borrower', 'refreshSanctionsFlag', [lenderAddr]);
  await page.reload();
  await connectWallet(page);
  const freed = page.locator(`[data-claim="lender:${loanId}"]`);
  // The claim flow opened during the outage may still be held open.
  const panel = freed.getByTestId('loan-claim-panel-lender');
  const open = freed.getByTestId(`claims-open-lender-${loanId}`);
  await expect(panel.or(open)).toBeVisible({ timeout: 60_000 });
  if (!(await panel.isVisible())) await open.click();
  await expect(page.getByTestId('frozen-notice')).toHaveCount(0);
  // The payout, the reserved part with it, is credited to the lender's own
  // vault, free to withdraw.
  const before = await sc.read<bigint>('withdrawableNow', [lenderAddr, 0, WETH, 0n]);
  await expect(panel.locator('.receipt')).toContainText(`Collect the lender payout of loan #${loanId}`, { timeout: 60_000 });
  await panel.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = panel.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('credited to your vault, free to withdraw');
  const after = await sc.read<bigint>('withdrawableNow', [lenderAddr, 0, WETH, 0n]);
  expect(after - before).toBe(owed + held);
});
