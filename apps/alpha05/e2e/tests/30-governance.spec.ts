/**
 * Queued governance changes (#3237, RB-GOVERNANCE-QUEUE): a public page,
 * reached from the footer with no wallet. The fixture chain is deployed
 * without a governance timelock (DeployDiamond deploys none), so on it the
 * page must SAY it cannot list queued changes, never show an empty queue.
 * How a proved change, an unproved one and a failed read are worded is held
 * by the page's unit test; the reader's proof by `@vaipakam/lib`'s.
 */
import { expect, test } from '../lib/wallet';

test('the footer reaches the governance page, which states the chain records no timelock', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');
  await page.locator('footer').getByRole('link', { name: 'Queued governance changes' }).click();
  await expect(page).toHaveURL(/\/governance$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Queued governance changes' })).toBeVisible();
  await expect(page.getByText('waits in the governance timelock before it can run')).toBeVisible();
  await expect(page.getByText('No governance timelock is recorded for Base Sepolia, so this page cannot list queued changes there.')).toBeVisible();
  await expect(page.getByTestId('governance-empty')).toHaveCount(0);

  // Nothing runs off the side of the page, on a phone or a desktop.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
