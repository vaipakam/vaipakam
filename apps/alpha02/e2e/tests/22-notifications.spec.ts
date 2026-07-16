/**
 * In-app notification center (#1213 / E-11), frontend — the bell + unread
 * badge + dropdown panel, with CLIENT-side read-state.
 *
 * The e2e indexer stub serves a deterministic 3-row feed for any wallet
 * (see indexer-stub.mjs) — two event rows plus one CRON calendar row
 * (maturity_7d, #1213 PR 2). Read/unread is a per-wallet last-seen cursor
 * in localStorage, so this drives the whole flow with no server state:
 *   - connect → badge shows the unread count
 *   - open the panel → the rows render (incl. the calendar reminder's
 *     outcome copy), badge clears (marks read)
 *   - click a row → deep-links to /positions/:loanId, panel closes
 *   - the cleared state survives a reload (persisted cursor)
 */
import { test, expect, connectWallet } from '../lib/wallet-fixture';

test('bell shows unread count, panel lists rows, and a row deep-links to the position', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  // The bell renders once a wallet is connected.
  const bell = page.getByTestId('notif-bell');
  await expect(bell).toBeVisible({ timeout: 15_000 });

  // Three unread rows in the fixture, never seen → badge reads "3".
  const badge = page.getByTestId('notif-badge');
  await expect(badge).toHaveText('3');

  // Open the panel → all rows render, incl. the calendar reminder with
  // its outcome-worded copy (#1213 PR 2).
  await bell.click();
  const rows = page.getByTestId('notif-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('week from its due date');

  // Opening marks everything loaded as read → the badge clears.
  await expect(badge).toHaveCount(0);

  // Clicking a row deep-links to the position and closes the panel
  // (the newest row is the calendar reminder for loan 3).
  await rows.first().click();
  await expect(page).toHaveURL(/\/positions\/3$/);
  await expect(page.getByTestId('notif-row')).toHaveCount(0);
});

test('the read state persists across a reload (per-wallet last-seen cursor)', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  const bell = page.getByTestId('notif-bell');
  await expect(bell).toBeVisible({ timeout: 15_000 });
  // Mark read by opening the panel once.
  await expect(page.getByTestId('notif-badge')).toHaveText('3');
  await bell.click();
  await expect(page.getByTestId('notif-badge')).toHaveCount(0);
  // Close the panel.
  await page.keyboard.press('Escape');

  // Reload: the same wallet's last-seen cursor is persisted, so the
  // already-seen rows do NOT re-raise the badge.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await expect(page.getByTestId('notif-bell')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('notif-badge')).toHaveCount(0);
});
