/**
 * Settings › Risk access (#3180; ACC-33, RB-RISK-SETTINGS), against the
 * suite's chain. The level that counts is stated in words, and whether this
 * network enforces it; Basic points to Advanced for changes. In Advanced a
 * raise on a network that does not enforce levels says it is only saved; with
 * the check on and a waiting period set, a raise states when it counts and is
 * never offered again while it waits, lowering is at once, and strict mode
 * switched off says until when it still applies. Each test runs inside a
 * snapshot it reverts. Runs on the desktop and the phone.
 */
import type { Hex } from 'viem';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function inSnapshot(body: () => Promise<void>): Promise<void> {
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await body();
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
    await anvilRpc('evm_mine');
  }
}

/** Open a change, check its receipt, sign it, and wait for the measured outcome. */
async function sign(page: Page, receiptText: string[], outcomeText: string): Promise<void> {
  const flow = page.getByTestId('settings-risk-flow');
  const receipt = flow.locator('.receipt');
  for (const t of receiptText) await expect(receipt).toContainText(t, { timeout: 60_000 });
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(outcomeText);
  await finish.getByTestId('settings-risk-done').click();
  await expect(flow).toHaveCount(0);
}

test('a network that does not enforce levels: the level is stated, Basic points to Advanced, and a raise is only saved', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  await inSnapshot(async () => {
    const { page, flags } = await launchWallet('freshBorrower');
    await page.goto('/settings');
    await connectWallet(page);
    const risk = page.getByTestId('settings-risk');
    const state = risk.getByTestId('settings-risk-state');
    await expect(state).toHaveAttribute('data-gate', 'off', { timeout: 30_000 });
    await expect(state).toContainText('the level that counts for this wallet is “Blue-chip assets only”');
    await expect(state).toContainText('does not enforce risk levels right now');
    await expect(state).toContainText('Strict mode is off.');
    await expect(risk).toContainText('switch to Advanced mode');
    await expect(risk.getByTestId('settings-risk-levels')).toHaveCount(0);

    await page.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
    const levels = risk.getByTestId('settings-risk-levels');
    await expect(levels.locator('li[data-level="0"]')).toHaveAttribute('data-choice', 'current');
    await expect(levels.locator('li[data-level="2"]')).toContainText('on default the lender receives the collateral as it is');
    const sent = flags.sentTransactions;
    await risk.getByTestId('settings-risk-choose-1').click();
    await sign(page, ['Raise your risk level', 'Liquid assets', 'saved and counts only if the check is switched on', 'None: this only records a setting'], 'In effect now');
    expect(flags.sentTransactions).toBe(sent + 1);
    await expect(state).toContainText('is “Liquid assets”', { timeout: 30_000 });
    await expect(levels.locator('li[data-level="1"]')).toHaveAttribute('data-choice', 'current');
    await fitsWidth(page);
  });
});

test('with the check on and a waiting period: a raise waits and is not offered twice, lowering is at once, strict mode lingers', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  await inSnapshot(async () => {
    await sc.diamondWrite('admin', 'setRiskAccessGateEnabled', [true]);
    await sc.diamondWrite('admin', 'setRiskAccessUnlockCooldown', [3600n]);
    const { page } = await launchWallet('freshBorrower');
    await page.goto('/settings');
    await page.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
    await connectWallet(page);
    const risk = page.getByTestId('settings-risk');
    const state = risk.getByTestId('settings-risk-state');
    await expect(state).toHaveAttribute('data-gate', 'on', { timeout: 30_000 });
    await expect(state).toContainText('enforces this level');

    // A raise names when it counts, then waits and is never offered again.
    await risk.getByTestId('settings-risk-choose-2').click();
    await sign(page, ['About 1 h after it is recorded', 'Any asset, including illiquid ones'], 'Takes effect at');
    await expect(state).toContainText('You chose “Any asset, including illiquid ones”. It takes effect at', { timeout: 30_000 });
    await expect(state).toContainText('is “Blue-chip assets only”');
    const levels = risk.getByTestId('settings-risk-levels');
    await expect(levels.locator('li[data-level="2"]')).toHaveAttribute('data-choice', 'waiting');
    await expect(levels.locator('li[data-level="2"]')).toContainText('Chosen; takes effect at');
    await expect(risk.getByTestId('settings-risk-choose-2')).toHaveCount(0);

    // Lowering to the level that counts is at once and replaces the waiting choice.
    await risk.getByTestId('settings-risk-choose-0').click();
    await sign(page, ['Lower your risk level', 'As soon as the transaction is confirmed', 'which was still waiting', 'Loans you already have are not affected'], 'In effect now');
    await expect(levels.locator('li[data-level="0"]')).toHaveAttribute('data-choice', 'current', { timeout: 30_000 });
    await expect(levels.locator('li[data-level="2"]')).toHaveAttribute('data-choice', 'raise');

    // Strict mode: on at once; off keeps it applying for the period.
    await risk.getByTestId('settings-risk-strict-toggle').click();
    await sign(page, ['Turn strict mode on', 'needs your acknowledgement before you create or take an offer'], 'Strict mode on');
    await expect(state).toHaveAttribute('data-strict', 'on', { timeout: 30_000 });
    await expect(risk).toContainText('Turning it off removes a check');
    await risk.getByTestId('settings-risk-strict-toggle').click();
    await sign(page, ['Turn strict mode off', 'Strict mode keeps applying for about 1 h after it is recorded'], 'Still applies until');
    await expect(state).toHaveAttribute('data-strict', 'lingering', { timeout: 30_000 });
    await expect(state).toContainText('Strict mode is switched off, but still applies until');
    await expect(risk).toContainText('Turning it on again ends that period at once.');
    await fitsWidth(page);
  });
});
