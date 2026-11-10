/**
 * Alerts (#3180, ACC-54, RB-INBOX): the wallet's free inbox from the index,
 * and the header's count of new alerts. A loan is opened and repaid (the
 * suite reverts it after the test), so the lender's inbox carries a
 * "started" and a "repaid" row
 * read from the chain's own logs; the stand-in adds the kinds the fixture
 * cannot reach (a health band, a reward deadline, a kind the app has no
 * words for, and a row it cannot read). Opening the page records what it
 * showed as seen; rows added after that are counted on the bell and marked
 * New on the next visit, and an unreadable row is counted, never dropped.
 * An index that is down is said so, never shown as an empty inbox.
 */
import { NOTIF_EVENT_KIND_RECONCILED } from '@vaipakam/lib/notificationProvenance';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { addNotifications, resetNotifications, setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.afterEach(async () => {
  await setIndexPosture('live');
  await resetNotifications();
});

test('the inbox lists the wallet’s alerts, counts the new ones on the bell, and states what it cannot read', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 800, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  const id = loanId.toString();

  const { page } = await launchWallet('lender');
  await page.goto('/alerts');
  await connectWallet(page);

  // The chain's own rows for this loan, each opening the loan.
  const list = page.getByTestId('alerts-rows');
  await expect(list.locator('[data-alert="loan_repaid"]').filter({ hasText: `Loan #${id} was repaid and closed.` })).toHaveCount(1, { timeout: 30_000 });
  await expect(list.locator('[data-alert="loan_matched"]').filter({ hasText: `Loan #${id} started.` })).toHaveCount(1);
  await expect(
    list
      .locator('[data-alert="loan_repaid"]')
      .filter({ hasText: `Loan #${id}` })
      .getByRole('link', { name: `Open loan #${id}` }),
  ).toHaveAttribute('href', `/positions/${id}`);
  await expect(page.getByTestId('alert-channels')).toContainText('Telegram, push and warnings');
  await fitsWidth(page);

  // Opening the page recorded what it showed: the bell counts nothing new.
  const bell = page.getByTestId('inbox-bell');
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute('data-unread', '0');
  await expect(bell).toHaveAttribute('data-failed', 'false');

  // New alerts arrive while the wallet is elsewhere: the bell shows the
  // index's count of rows written since, the one this app cannot read included.
  await addNotifications(sc.address('lender'), [
    { kind: 'hf_critical', loanId: Number(loanId) },
    { kind: 'reward_final_notice', loanId: null, data: { entryId: 4 } },
    { kind: 'offer_matched', loanId: null },
    { kind: 'loan_ended', loanId: Number(loanId), eventKind: NOTIF_EVENT_KIND_RECONCILED },
    { kind: 'loan_repaid', loanId: Number(loanId), createdAt: null },
  ]);
  await page.goto('/');
  await connectWallet(page);
  await expect(bell).toHaveAttribute('data-unread', '5', { timeout: 30_000 });
  await expect(bell).toHaveAccessibleName('Alerts, 5 new');
  await fitsWidth(page);

  // The next visit marks them New, states the unreadable row, and clears the bell.
  await bell.click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByTestId('alerts-fresh')).toHaveText('5 new since this page was last opened here.', { timeout: 30_000 });
  await expect(page.getByTestId('alerts-unreadable')).toHaveText('1 alerts could not be read and are not shown.');
  const critical = list.locator('[data-alert="hf_critical"]');
  await expect(critical).toContainText(`Loan #${id}’s health dipped below 1.05, close to the 1.0 liquidation line.`);
  await expect(critical).toHaveAttribute('data-fresh', 'true');
  await expect(list.locator('[data-alert="reward_final_notice"]')).toContainText('Reward entry #4 entered its last notice period');
  await expect(list.locator('[data-alert="reward_final_notice"]').getByRole('link', { name: 'Open Claims' })).toHaveAttribute('href', '/claims');
  await expect(list.locator('[data-alert="offer_matched"]')).toContainText('An alert this app has no words for yet (offer_matched).');
  // An outcome the index's own check found says when it was found, not when it happened.
  const ended = list.locator('[data-alert="loan_ended"]');
  await expect(ended).toContainText(`Loan #${id} ended; the index could not tell how.`);
  await expect(ended).toContainText('Found by a check at');
  await expect(ended).toContainText('when it happened is not known.');
  await expect(list.locator('[data-alert="loan_repaid"]').filter({ hasText: `Loan #${id}` })).toHaveAttribute('data-fresh', 'false');
  await expect(bell).toHaveAttribute('data-unread', '0');
  // Cleared by a fresh count from the index, not by a failed one.
  await expect(bell).toHaveAttribute('data-failed', 'false');
  await expect(bell).toHaveAccessibleName('Alerts');
  await fitsWidth(page);

  // A row opens its loan.
  await list
    .locator('[data-alert="loan_repaid"]')
    .filter({ hasText: `Loan #${id}` })
    .getByRole('link', { name: `Open loan #${id}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/positions/${id}$`));

  // The index down: said so, and never an empty inbox.
  await setIndexPosture('down');
  await page.goto('/alerts');
  await connectWallet(page);
  await expect(page.getByTestId('alerts-failed')).toContainText('Alerts could not be read', { timeout: 30_000 });
  await expect(page.getByTestId('alerts-failed')).toContainText('this is not an empty inbox');
  await expect(page.getByTestId('alerts-empty')).toHaveCount(0);
  await expect(bell).toHaveAccessibleName('Alerts could not be read');
});

test('Alerts asks for a wallet before it reads anything', async ({ page }) => {
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
  await expect(page.getByText('Connect a wallet to see its alerts.')).toBeVisible();
  await expect(page.getByTestId('inbox-bell')).toHaveCount(0);
});
