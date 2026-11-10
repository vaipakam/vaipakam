/**
 * The world rail's stamp (RB-RAILS, matrix ACC-65 posture): every world
 * figure carries the block and age of the index it came from; a stale
 * index is a tier-A notice, an unreadable one says figures are
 * unavailable rather than empty, an index describing another protocol
 * contract than this build is UNKNOWN, and the push rail's own state is
 * named (here: refused by the stand-in, so "unavailable, polling").
 */
import { mine } from '../lib/anvil';
import { setIndexPosture } from '../lib/stub';
import { expect, test } from '../lib/wallet';

test('a live index is stamped with its block and age, and push is named unavailable while refused', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const stamp = page.locator('.stamp-row .stamp');
  await expect(stamp).toContainText(/Index at block \d+, \d+ (s|min) ago\./);
  await expect(stamp).toContainText('Push unavailable, polling.');
  const before = Number(/block (\d+)/.exec((await stamp.textContent()) ?? '')?.[1]);
  await mine(3);
  await page.locator('.stamp-row').getByRole('button', { name: 'Refresh' }).click();
  await expect(stamp).toContainText(`Index at block ${before + 3},`);
});

test('an index that has not advanced for half an hour is a tier-A stale notice', async ({ launchWallet }) => {
  await setIndexPosture('stale');
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const notice = page.locator('.stamp-row').getByText('The index has not advanced for', { exact: false });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('world figures may be behind the chain.');
  await expect(notice).toContainText(/Index at block \d+/);
});

test('an index that has stopped scanning says so at once, with its last block', async ({ launchWallet }) => {
  // The cursor is current: only the indexer's own schema gate says the
  // scans have stopped, and the stamp must not wait for the age to tell.
  await setIndexPosture('schema-pending');
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const notice = page.locator('.stamp-row').getByText('World figures will fall behind the chain:', { exact: false });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('the index has stopped scanning until its database is updated (1 change waiting)');
  await expect(notice).toContainText(/Index at block \d+/);
});

test('an unreadable index says world figures are unavailable, not empty', async ({ launchWallet }) => {
  await setIndexPosture('down');
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const notice = page.locator('.stamp-row').getByText('The index could not be read', { exact: false });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('World figures are unavailable, not empty.');
  // Recovery is a refresh away: the stamp returns once the index answers.
  await setIndexPosture('live');
  await page.locator('.stamp-row').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.stamp-row .stamp')).toContainText(/Index at block \d+/);
});

test('an index describing another protocol contract than this build is unknown, never current', async ({ launchWallet }) => {
  await setIndexPosture('other-diamond');
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const stamp = page.locator('.stamp-row .stamp');
  await expect(stamp).toContainText('Index position unknown: The index describes a different protocol contract than this build.');
  await expect(stamp).not.toContainText('Index at block');
});
