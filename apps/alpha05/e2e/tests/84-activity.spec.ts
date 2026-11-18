/**
 * Activity (#3677, ACC activity feed): the wallet's whole history from the
 * index's wallet filter. A loan is opened and repaid (the suite reverts it
 * after the test), so the lender's page carries the chain's own events for it,
 * one line per transaction with the rest folded under it, each naming its
 * loan, its sender and its transaction. The stand-in adds what the fixture
 * cannot reach: an event with an amount the index recorded, an event not
 * final yet, a loan whose ending a check found, a kind the app has no words
 * for and a row it cannot read. An index still reading older history says so,
 * and an index that is down is never shown as an empty history. Runs on the
 * desktop and the phone project.
 */
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setIndexPosture, setWalletActivity } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the wallet’s history lists its loan’s events per transaction, with what the index recorded and what it did not', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 800, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  const id = loanId.toString();
  const lender = sc.address('lender').toLowerCase();
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const row = (over: Record<string, unknown>) => ({
    chainId: 84532,
    txHash: `0x${'e'.repeat(64)}`,
    loanId: null,
    offerId: null,
    actor: lender,
    args: {},
    blockAt: 1_800_000_000,
    asset: null,
    assetType: null,
    amount: null,
    amountMax: null,
    tokenId: null,
    quantity: null,
    ...over,
  });
  await setWalletActivity(lender, {
    events: [
      row({ blockNumber: 1, logIndex: 3, kind: 'LoanReserveFunded', loanId: Number(loanId), asset: token, assetType: 0, amount: '1500000000000000000' }),
      row({ blockNumber: 1, logIndex: 2, kind: 'SomethingNew', txHash: `0x${'d'.repeat(64)}` }),
      row({ blockNumber: 1, logIndex: 0, kind: 'CollateralAdded', txHash: `0x${'b'.repeat(64)}`, asset: token, assetType: 2, tokenId: '5' }),
      row({ blockNumber: 1, logIndex: 1, kind: 'Transfer', amount: 'not a number', txHash: `0x${'c'.repeat(64)}` }),
    ],
    pending: {
      events: [row({ blockNumber: 999_999, logIndex: 0, kind: 'OfferCreated', offerId: 42, blockAt: null, txHash: `0x${'f'.repeat(64)}` })],
      complete: true,
      readAt: Math.floor(Date.now() / 1000),
      finalThrough: 1,
      throughBlock: 999_999,
      latestBlock: 999_999,
    },
    repairs: [{ chainId: 84532, loanId: 77, observedStatus: 'repaid', observedBlock: 1, observedAt: null, feedLogIndex: 1_000_077, provenance: 'reconciliation' }],
    walletComplete: false,
  });

  const { page } = await launchWallet('lender');
  await page.goto('/positions');
  await connectWallet(page);
  await page.getByTestId('positions-activity-link').click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();

  // The chain's own events for the loan, one line per transaction.
  const rows = page.getByTestId('activity-rows');
  const started = rows.locator('[data-kind="LoanInitiated"]');
  await expect(started).toHaveCount(1, { timeout: 30_000 });
  await expect(started).toContainText('A loan started.');
  await expect(started.getByRole('link', { name: `Loan #${id}` })).toHaveAttribute('href', `/positions/${id}`);
  await expect(started.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', /\/tx\/0x[0-9a-f]{64}$/);
  // Its bookkeeping companions fold under it rather than taking lines of their own.
  await expect(started.locator('details summary')).toContainText(/and \d+ more in this transaction/);
  await expect(rows.locator('> li[data-kind="LoanInitiatedDetails"]')).toHaveCount(0);
  const repaid = rows.locator('[data-kind="LoanRepaid"]');
  await expect(repaid).toContainText('A loan was repaid.');
  // The repayment is filed under its repayer, the borrower, not this wallet.
  await expect(repaid).toContainText(/Recorded for 0x/);
  await expect(repaid).toContainText('No amount recorded.');

  // An amount the index recorded is shown with its token; one it did not is said.
  const funded = rows.locator('[data-kind="LoanReserveFunded"]');
  await expect(funded).toContainText('Funds were set aside in a loan reserve.');
  await expect(funded).toContainText('1.5');
  await expect(funded).toContainText('Recorded for you');
  await expect(rows.locator('[data-kind="SomethingNew"]')).toContainText('An event this app has no words for yet (SomethingNew).');
  // A multi-copy token whose quantity the index did not record says so.
  await expect(rows.locator('[data-kind="CollateralAdded"]')).toContainText('number of copies not recorded');
  await expect(page.getByTestId('activity-unreadable')).toHaveText('1 rows could not be read and are not shown.');

  // A check found loan #77's ending: it says what was and was not seen.
  const repair = page.getByTestId('activity-repair-77');
  await expect(repair).toContainText('Loan #77 had ended (repaid) by block 1, found by a check.');
  await expect(repair).toContainText('When and how it ended was not seen.');

  // An event in the newest blocks is marked not final, with no time yet.
  const pending = page.getByTestId('activity-pending');
  await expect(pending).toContainText('Not final yet');
  await expect(pending.locator('[data-kind="OfferCreated"]')).toContainText('An offer was posted.');
  await expect(pending.locator('[data-kind="OfferCreated"]')).toContainText('time not read yet');
  await expect(pending.getByRole('link', { name: 'Offer #42' })).toHaveAttribute('href', '/offers/42');

  // The index is still reading older history: the page says so and claims no end.
  await expect(page.getByTestId('activity-incomplete')).toContainText('older activity may be missing');
  await expect(page.getByTestId('activity-end')).toHaveCount(0);
  await fitsWidth(page);
});

test('a history the index has finished ends by saying so, and one it cannot read is never shown as empty', async ({ launchWallet }) => {
  const sc = scenario();
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 800, days: 30 });
  const { page } = await launchWallet('borrower');
  await page.goto('/alerts');
  await connectWallet(page);
  await page.getByTestId('alerts-activity-link').click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByTestId('activity-rows').locator('[data-kind="LoanInitiated"]')).toContainText('A loan started.', { timeout: 30_000 });
  await expect(page.getByTestId('activity-end')).toContainText('That is all the activity the index holds');
  await expect(page.getByTestId('activity-incomplete')).toHaveCount(0);
  await fitsWidth(page);

  // Loan endings the index could not read: the page says some may be missing and claims no end.
  await setWalletActivity(sc.address('borrower').toLowerCase(), { repairs: null });
  await page.reload();
  await connectWallet(page);
  await expect(page.getByTestId('activity-repairs-unknown')).toContainText('some loan endings may be missing', { timeout: 30_000 });
  await expect(page.getByTestId('activity-end')).toHaveCount(0);

  await setIndexPosture('down');
  await page.reload();
  await connectWallet(page);
  await expect(page.getByTestId('activity-failed')).toContainText('this is not an empty history', { timeout: 30_000 });
  await expect(page.getByTestId('activity-empty')).toHaveCount(0);
});
