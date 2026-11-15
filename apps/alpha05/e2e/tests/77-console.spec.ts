/**
 * The Protocol Console (RW-76, RW-77): a public, read-only page, reached by
 * direct link with no wallet. Its settings come from the index's snapshot
 * only while that may be shown; otherwise the page reads the fixture chain
 * at one block and says why, and a chain answer older than the snapshot is
 * stated as unknown. The global pause is read live. How each value is
 * written is held by the catalogue's unit test; the source rule by
 * `source.test.ts`.
 */
import { scenario } from '../lib/chain';
import { setConfigSnapshot, setIndexPosture } from '../lib/stub';
import { CHAIN_ID, expect, test } from '../lib/wallet';

const nowSec = () => Math.floor(Date.now() / 1000);

test('with no snapshot the Console reads the chain, names every switch and states the pause', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/console');
  await expect(page.getByRole('heading', { level: 1, name: 'Protocol console' })).toBeVisible();
  const source = page.getByTestId('console-source');
  await expect(source).toHaveAttribute('data-source', 'chain');
  await expect(source).toHaveAttribute('data-why', 'none');
  await expect(page.getByText('The index holds no snapshot for Base Sepolia, so the settings were read from the chain.')).toBeVisible();
  await expect(source.getByText(/^Read from the chain at block \d+/)).toBeVisible();
  // The fixture's settings bundle is labelled: this build's ABI describes
  // the code that answered.
  await expect(page.getByTestId('console-code-changed')).toHaveCount(0);
  const settings = page.getByTestId('console-settings');
  await expect(settings.locator('dt[data-setting="treasuryFeeBps"]')).toHaveText('Treasury share of interest');
  await expect(settings.locator('dd[data-setting="treasuryFeeBps"]')).toHaveText(/^\d+(\.\d+)?%$/);
  await expect(settings.locator('dd[data-setting="maxOfferDurationDays"]')).toHaveText(/^[\d,]+ days$/);

  const switches = page.getByTestId('console-switches');
  await expect(switches.locator('[data-switch="partialFill"]')).toHaveAttribute('data-state', /^(on|off)$/);
  await expect(switches.locator('[data-switch="keepersPaused"]')).toHaveAttribute('data-state', /^(paused|running)$/);
  for (const dark of ['fullTariff', 'serviceCapacity', 'keeperReward', 'discountPriceSource', 'cutoverArming', 'horizon']) {
    await expect(switches.locator(`[data-switch="${dark}"]`)).toHaveAttribute('data-state', 'notRead');
  }
  await expect(page.getByTestId('console-pause')).toHaveAttribute('data-pause', 'none');
  await expect(page.getByTestId('console-subset')).toContainText('Not shown yet');

  // Nothing runs off the side of the page, on a phone or a desktop.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a fresh labelled snapshot is shown as the snapshot, with its block', async ({ launchWallet }) => {
  const head = Number(await scenario().pub.getBlockNumber());
  await setConfigSnapshot({
    chainId: CHAIN_ID,
    available: true,
    values: { treasuryFeeBps: '123', partialFillEnabled: false, keepersPaused: true, autoPauseAvailableAt: '0', autoPauseDurationSeconds: '1800' },
    unreported: ['minOfferValueNumeraire'],
    sourceBlock: head,
    updatedAt: nowSec() - 60,
  });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/console');
  const source = page.getByTestId('console-source');
  await expect(source).toHaveAttribute('data-source', 'snapshot');
  await expect(source).toHaveAttribute('data-block', String(head));
  await expect(source.getByText(`From the index’s snapshot of block ${head}`)).toBeVisible();
  await expect(page.locator('dd[data-setting="treasuryFeeBps"]')).toHaveText('1.23%');
  await expect(page.locator('[data-switch="partialFill"]')).toHaveAttribute('data-state', 'off');
  await expect(page.locator('[data-switch="keepersPaused"]')).toHaveAttribute('data-state', 'paused');
  await expect(page.getByTestId('console-unanswered')).toContainText('Smallest offer value');
  await expect(page.getByTestId('console-next-pause')).toHaveText(
    'An automatic pause could start at any time; none has frozen the protocol yet. An automatic pause lasts 30 min.',
  );
});

test('a snapshot behind a governance change, or an unreachable index, sends the page to the chain with the reason', async ({ launchWallet }) => {
  const head = Number(await scenario().pub.getBlockNumber());
  await setConfigSnapshot({
    chainId: CHAIN_ID,
    available: true,
    values: { treasuryFeeBps: '123' },
    sourceBlock: head - 1,
    updatedAt: 0,
    stale: true,
    staleAtBlock: head,
  });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/console');
  const source = page.getByTestId('console-source');
  await expect(source).toHaveAttribute('data-source', 'chain');
  await expect(source).toHaveAttribute('data-why', 'behind');
  await expect(page.locator('dd[data-setting="treasuryFeeBps"]')).not.toHaveText('1.23%');

  await setIndexPosture('down');
  await page.reload();
  await expect(page.getByTestId('console-source')).toHaveAttribute('data-why', 'unreachable');
  await expect(page.getByText('The index could not be used (it refused the request), so the settings were read from the chain instead.')).toBeVisible();
});

test('a chain answer older than the snapshot is stated as unknown, with no value written', async ({ launchWallet }) => {
  const head = Number(await scenario().pub.getBlockNumber());
  await setConfigSnapshot({
    chainId: CHAIN_ID,
    available: true,
    values: { treasuryFeeBps: '123' },
    sourceBlock: head + 1_000,
    updatedAt: nowSec() - 3 * 86_400,
  });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/console');
  const source = page.getByTestId('console-source');
  await expect(source).toHaveAttribute('data-source', 'unknown');
  await expect(source).toHaveAttribute('data-why', 'old');
  await expect(source.getByText(new RegExp(`older than the snapshot's block ${head + 1_000}, so it could miss a change`))).toBeVisible();
  await expect(page.getByTestId('console-settings')).toHaveCount(0);
  await expect(page.locator('[data-switch="partialFill"]')).toHaveAttribute('data-state', 'unknown');
});

test('the global pause is stated from a live read, with what it stops and what stays open', async ({ launchWallet }) => {
  const sc = scenario();
  await sc.diamondWrite('admin', 'pause');
  try {
    const { page } = await launchWallet('visitor', { preAuthorized: false });
    await page.goto('/console');
    await expect(page.getByTestId('console-pause')).toHaveAttribute('data-pause', 'manual');
    await expect(page.getByText(/^Paused by governance at block \d+, with no set end\.$/)).toBeVisible();
    // Withdrawals are not closed for good: the escape route is stated, read
    // at the same block (scheduled, or none before launch).
    await expect(page.getByTestId('console-escape')).toContainText(/escape route/);
    await expect(page.getByText('Full repayment, partial repayment and adding collateral stay open', { exact: false })).toBeVisible();
  } finally {
    await sc.diamondWrite('admin', 'unpause');
  }
});
