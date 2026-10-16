/**
 * In-app notification center (#1213 / E-11), frontend — the bell + unread
 * badge + dropdown panel, with CLIENT-side read-state.
 *
 * The e2e indexer stub serves a deterministic 5-row feed for any wallet
 * (see indexer-stub.mjs) — two event rows, one CRON calendar row
 * (maturity_7d, #1213 PR 2), one keeper HF-band row (hf_alert,
 * #1213 PR 2b), and one RL-3 reward final-notice row (#1956). Read/unread is a per-wallet last-seen cursor
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

  // Five unread rows in the fixture, never seen → badge reads "5".
  const badge = page.getByTestId('notif-badge');
  await expect(badge).toHaveText('5');

  // Open the panel → all rows render: newest is the keeper HF-band row
  // (#1213 PR 2b), then the calendar reminder with its outcome-worded
  // copy (#1213 PR 2).
  await bell.click();
  const rows = page.getByTestId('notif-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('health dipped below 1.2');
  await expect(rows.nth(1)).toContainText('week from its due date');

  // Opening marks everything loaded as read → the badge clears.
  await expect(badge).toHaveCount(0);

  // Clicking a row deep-links to the position and closes the panel
  // (the newest row is the HF alert for loan 3).
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
  await expect(page.getByTestId('notif-badge')).toHaveText('5');
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

test('a reward final-notice row (RL-3) names the reward, not a loan, and opens the Claim Center', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const bell = page.getByTestId('notif-bell');
  await expect(bell).toBeVisible({ timeout: 15_000 });
  await bell.click();
  const rows = page.getByTestId('notif-row');
  await expect(rows).toHaveCount(5);
  // The oldest row: the free pre-expiry notice the claim horizon's
  // safeguard requires — it says where to act and which reward it means.
  const reward = rows.last();
  await expect(reward).toContainText('final notice period');
  await expect(reward).toContainText('Reward #9');
  await expect(reward).not.toContainText('Loan #');
  await reward.click();
  await expect(page).toHaveURL(/\/claims$/);
  await expect(page.getByTestId('notif-row')).toHaveCount(0);
});

