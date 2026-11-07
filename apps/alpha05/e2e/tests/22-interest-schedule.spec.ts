/**
 * Position, interest schedule (matrix LN-24): a running loan with a monthly
 * schedule states its period from the protocol's own settlement preview
 * (period end, grace end, the interest for the period, what is paid and
 * what is still owed) and whether the period can be settled now, with the
 * periodic-settlement switch and the protocol pause each stated by name,
 * the paused stretch's rule once a pause has moved the loan's dates, and
 * the chain time the period is placed against. Runs on the desktop and the
 * phone project, inside a snapshot the test reverts.
 */
import type { Locator, Page } from '@playwright/test';
import type { Hex } from 'viem';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';
import { anvilRpc, increaseTime } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const E18 = 10n ** 18n;
const DAY = 86_400;
/** The lowest finer-cadence threshold the protocol accepts (1,000 numeraire units). */
const THRESHOLD = 1_000n * E18;

/** The value beside a fact's label (exact label match). */
const fact = (section: Locator, label: string) =>
  section
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a monthly schedule states its period, what is owed, and the switch and the pause by name in every phase', async ({ launchWallet }) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);
    await sc.diamondWrite('admin', 'setMinPrincipalForFinerCadence', [THRESHOLD]);
    // A whole number of WETH worth half as much again as the threshold, so
    // a monthly schedule is admitted; collateral at the ratio the page's own
    // live-loan test uses.
    const perWeth = await sc.read<bigint>('getNumeraireValue', [WETH, E18, false]);
    const weth = (THRESHOLD * 3n) / 2n / perWeth + 1n;
    const { loanId } = await openLoan(sc, {
      lender: 'lender',
      borrower: 'borrower',
      principalWeth: weth.toString(),
      collateralTliq: (weth * 5000n).toString(),
      rateBps: 600,
      days: 90,
      cadence: 1,
    });

    const { page } = await launchWallet('borrower');
    await page.goto(`/positions/${loanId}`);
    await connectWallet(page);
    const card = page.getByTestId('position-schedule');
    const notes = page.getByTestId('schedule-notes');

    // Running: the period and what it owes, settlement opening at its grace end.
    await expect(fact(card, 'Schedule')).toHaveText('Due every month', { timeout: 60_000 });
    await expect(fact(card, 'This period ends')).toHaveText(/UTC/);
    await expect(fact(card, 'Its grace period ends')).toHaveText(/UTC/);
    await expect(fact(card, 'Interest for this period')).toHaveText(/ WETH$/);
    await expect(fact(card, 'Paid toward it')).toHaveText('0 WETH');
    const owed = await fact(card, 'Interest for this period').textContent();
    await expect(fact(card, 'Still owed for it')).toHaveText(owed ?? '');
    await expect(fact(card, 'Settling this period')).toHaveText(/^Opens .*UTC$/);
    await expect(notes).toHaveAttribute('data-state', 'running');
    await expect(notes).toContainText(/If .* WETH is still owed when the grace ends .*UTC, anyone may then sell collateral to cover it\./);
    await expect(notes).toContainText('The borrower can pay a period by partial repayment, which pays the interest accrued so far.');
    await expect(notes).toContainText('Whether the protocol’s keeper settles periods here is not known.');
    await expect(notes).toContainText(/Checked against chain time .*UTC\./);
    await fitsWidth(page);

    // Switched off: the switch's sentence replaces any warning of a sale.
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [false]);
    await page.reload();
    await expect(fact(card, 'Settling this period')).toHaveText('Switched off here', { timeout: 60_000 });
    await expect(notes).toContainText('Periodic interest settlement is switched off here: no period can be settled and no collateral is sold at a checkpoint.');
    await expect(notes).not.toContainText('sell collateral');
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);

    // Paused: named, no sale announced; the paused time moves the dates.
    await sc.diamondWrite('admin', 'pause');
    try {
      await page.reload();
      await expect(fact(card, 'Settling this period')).toHaveText('Stopped while the protocol is paused', { timeout: 60_000 });
      await expect(notes).toContainText('The protocol is paused: no period can be settled while it is');
      await expect(notes).not.toContainText('sell collateral');
      await increaseTime(3_600);
    } finally {
      await sc.diamondWrite('admin', 'unpause');
    }

    // Past the period and its grace: anyone may settle it now, and the
    // paused stretch's rule is stated.
    await increaseTime(32 * DAY);
    await page.reload();
    await expect(fact(card, 'Settling this period')).toHaveText('Open now to anyone', { timeout: 60_000 });
    await expect(notes).toHaveAttribute('data-state', 'due');
    await expect(notes).toContainText(/Anyone may now settle this period by selling collateral sized to cover .* WETH and the sale’s charges\./);
    await expect(notes).toContainText('After a pause, a payment covers one period, through its original end. Interest for the paused stretch stays owed.');
    await fitsWidth(page);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});
