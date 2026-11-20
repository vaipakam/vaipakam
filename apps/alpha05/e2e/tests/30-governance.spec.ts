/**
 * Queued governance changes (#3237, RB-GOVERNANCE-QUEUE): a public page,
 * reached from the footer with no wallet. Global setup deploys a governance
 * timelock and queues two changes in it, in one block (#3306,
 * `lib/governance.ts`): a batch of two calls with a 400-day wait, and one
 * call with an 800-day wait that runs only after the batch. The page must
 * prove each against the id the timelock stores and say, in plain words,
 * what it would do and when it can run, and must never call the dependent
 * change runnable while the batch has not run.
 *
 * The browser's clock is pinned to the queuing block's time, so each wait is
 * stated exactly, and then moved past both waits: the batch can run, and the
 * dependent change still cannot. The chain itself is not moved, and its own
 * clock stays short of both waits whatever the specs before this one did. The
 * no-timelock notice, an unproved change and a failed read are held by the
 * page's unit test; the reader's proof by `@vaipakam/lib`'s.
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { FIXTURE_FILE } from '../lib/artifacts';
import { BATCH_DELAY, DEPENDENT_DELAY, type GovernanceFixture } from '../lib/governance';
import { expect, test } from '../lib/wallet';

function governance(): GovernanceFixture {
  return (JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as { governance: GovernanceFixture }).governance;
}

/** A moment as the page states it: the page's own formatting, in the
 *  browser's language, so the expectation cannot drift from the locale. */
function utc(page: Page, unixSeconds: number): Promise<string> {
  return page.evaluate(
    (s) => `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(s * 1000))} UTC`,
    unixSeconds,
  );
}

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the footer reaches the governance page, which lists the queued batch and the change that waits on it', async ({ launchWallet }) => {
  const g = governance();
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  // The moment both changes were queued: each wait is then stated in full.
  await page.clock.setFixedTime(new Date(g.queuedAt * 1000));
  await page.goto('/');
  await page.locator('footer').getByRole('link', { name: 'Queued governance changes' }).click();
  await expect(page).toHaveURL(/\/governance$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Queued governance changes' })).toBeVisible();
  await expect(page.getByText('waits in the governance timelock before it can run')).toBeVisible();

  await expect(page.getByTestId('governance-read-at')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('governance-waits')).toHaveText(
    'A change queued now waits at least 7 days. Each change below shows its own wait. Only lifting a pause, or an urgent fix the pause wallet approved by id, may wait 1 h instead.',
  );
  await expect(page.getByText('2 changes queued.')).toBeVisible();
  await expect(page.getByTestId('governance-empty')).toHaveCount(0);

  const ops = page.getByTestId('governance-op');
  await expect(ops).toHaveCount(2);
  const batch = ops.nth(0);
  const dependent = ops.nth(1);

  // Soonest first: the batch, proved, its two calls in order, in plain words.
  await expect(batch.getByRole('heading', { name: 'Change 1' })).toBeVisible();
  await expect(batch.getByText(`Operation id ${g.batchId}`)).toBeVisible();
  await expect(batch.getByText('2 calls, run together in this order.')).toBeVisible();
  const batchCalls = batch.getByTestId('governance-call');
  await expect(batchCalls).toHaveCount(2);
  await expect(batchCalls.nth(0)).toContainText('Sets the minimum wait for every later governance change to 2 h.');
  await expect(batchCalls.nth(1)).toContainText('Pauses the protocol contract.');
  await expect(batch.getByTestId('governance-op-after')).toHaveCount(0);
  await expect(batch.getByTestId('governance-op-when')).toHaveText(
    `Can run from ${await utc(page, g.queuedAt + BATCH_DELAY)}, in 400 days.`,
  );

  // The dependent change: one call, and it names the batch it waits on.
  await expect(dependent.getByRole('heading', { name: 'Change 2' })).toBeVisible();
  await expect(dependent.getByText(`Operation id ${g.dependentId}`)).toBeVisible();
  const dependentCalls = dependent.getByTestId('governance-call');
  await expect(dependentCalls).toHaveCount(1);
  await expect(dependentCalls.nth(0)).toContainText('Unpauses the protocol contract.');
  await expect(dependent.getByTestId('governance-op-after')).toHaveText(
    `It runs only after operation ${g.batchId} has run, and that operation has not run yet.`,
  );
  await expect(dependent.getByTestId('governance-op-when')).toHaveText(
    `Can run from ${await utc(page, g.queuedAt + DEPENDENT_DELAY)}, in 800 days.`,
  );
  await noOverflow(page);

  // Past both waits: the batch can run; the dependent change still cannot,
  // because the batch has not run. Only the browser's clock moves.
  await page.clock.setFixedTime(new Date((g.queuedAt + DEPENDENT_DELAY + 60) * 1000));
  await page.reload();
  await expect(ops).toHaveCount(2, { timeout: 60_000 });
  await expect(batch.getByTestId('governance-op-when')).toHaveText('Can run now.');
  await expect(dependent.getByTestId('governance-op-after')).toHaveText(
    `It runs only after operation ${g.batchId} has run, and that operation has not run yet.`,
  );
  await expect(dependent.getByTestId('governance-op-when')).toHaveText('');
  await expect(dependent.getByText('Can run now.')).toHaveCount(0);
  await noOverflow(page);
});
