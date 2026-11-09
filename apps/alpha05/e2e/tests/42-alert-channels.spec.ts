/**
 * Alerts › Telegram, push and warnings (#3180 Alerts slice 2, ACC-50 /
 * ACC-52; RB-ALERT-CHANNELS). The stand-in alert service answers as the
 * agent does and records every request; this spec checks each request's
 * signature against the shared message builders, so the wallet signed
 * exactly the words the service rebuilds. Telegram is linked with a code,
 * proven by a test alert and unlinked; push is offered only when the
 * service says it can send; health warnings are always on, with their lines
 * editable in Advanced; payment reminders switch off and on. A declined
 * signature sends nothing, a request already used is refused, and Terms in
 * force are asked for before a sign-up. Runs on the desktop and the phone.
 */
import { keccak256, toHex, verifyMessage, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { buildAlertSettingsMessage, buildTelegramLinkMessage, buildTelegramTestMessage, buildTelegramUnlinkMessage } from '@vaipakam/lib/alertsMessage';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { agentState, controlAgent, type AgentRequest } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** The signed request is the wallet's signature over the shared message. */
async function signedBy(req: AgentRequest, wallet: Hex, message: (w: Hex, chainId: number, issuedAt: number) => string): Promise<void> {
  const b = req.body as { wallet: Hex; chain_id: number; issuedAt: number; signature: Hex };
  expect(b.wallet.toLowerCase()).toBe(wallet.toLowerCase());
  expect(await verifyMessage({ address: wallet, message: message(b.wallet, b.chain_id, b.issuedAt), signature: b.signature })).toBe(true);
}

async function lastRequest(path: string): Promise<AgentRequest> {
  const { requests } = await agentState();
  const hit = requests.filter((r) => r.path === path).at(-1);
  if (!hit) throw new Error(`no request to ${path}`);
  return hit;
}

async function openChannels(page: Page): Promise<void> {
  await page.goto('/alerts');
  await connectWallet(page);
  await expect(page.getByTestId('alert-channels')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async () => {
  await controlAgent({ reset: true });
});

test('Telegram is linked with a code, proven by a test alert, and unlinked, each signed', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('lender');
  const me = account.address;
  await openChannels(page);
  const card = page.getByTestId('alert-telegram');
  await expect(card.getByTestId('alert-telegram-state')).toContainText('This browser has not linked Telegram for this wallet on Base Sepolia.');
  await expect(page.getByTestId('alert-channels')).toContainText('The alert service stores this wallet, this network, your alert settings');

  await card.getByTestId('alert-telegram-link').click();
  await expect(card.getByTestId('alert-telegram-code-value')).toHaveText('E2E00001', { timeout: 30_000 });
  await expect(card.getByTestId('alert-telegram-bot')).toHaveAttribute('href', 'https://t.me/vaipakam_e2e_bot?start=E2E00001');
  await signedBy(await lastRequest('/link/telegram'), me, buildTelegramLinkMessage);
  await fitsWidth(page);

  // Before the bot has the code, the test says so and proves nothing.
  await card.getByTestId('alert-telegram-test').click();
  await expect(page.getByTestId('alert-run')).toHaveAttribute('data-problem', 'not-linked', { timeout: 30_000 });
  await expect(page.getByTestId('alert-run')).toContainText('The bot has not received the link code yet');

  await controlAgent({ handshake: me });
  await card.getByTestId('alert-telegram-test').click();
  await expect(page.getByTestId('alert-run')).toContainText('A test alert was sent to the linked chat; check Telegram.', { timeout: 30_000 });
  await signedBy(await lastRequest('/telegram/test'), me, buildTelegramTestMessage);
  await expect(card.getByTestId('alert-telegram-state')).toContainText('Linked: a test alert from here reached the chat at');

  // What this browser did survives a reload; a second test within a minute waits.
  await page.reload();
  await expect(page.getByTestId('alert-telegram-state')).toContainText('Linked: a test alert from here reached the chat at', { timeout: 30_000 });
  await page.getByTestId('alert-telegram-test').click();
  await expect(page.getByTestId('alert-run')).toHaveAttribute('data-problem', 'cooldown', { timeout: 30_000 });

  await page.getByTestId('alert-telegram-unlink').click();
  await expect(page.getByTestId('alert-run')).toContainText('Telegram alerts are disconnected for this wallet on every network.', { timeout: 30_000 });
  await signedBy(await lastRequest('/unlink/telegram'), me, buildTelegramUnlinkMessage);
  await expect(page.getByTestId('alert-telegram-state')).toContainText('for this wallet on every network');
  expect((await agentState()).linked).not.toContain(me.toLowerCase());

  // Protected mode holds a chat; an unreadable protection check changes nothing.
  // An ordinary wallet's unlink that protected mode holds on another network:
  // that network is named here too, and nothing claims every network is off.
  await controlAgent({ next: { path: '/unlink/telegram', status: 200, body: { ok: true, scope: 'wallet', pending: [{ chain_id: 421614, effective_at: 1_800_000_000 }] } } });
  await page.getByTestId('alert-telegram-unlink').click();
  await expect(page.getByTestId('alert-run')).toContainText('Unlinked on every network except where protected mode keeps the chat receiving alerts', { timeout: 30_000 });
  await expect(page.getByTestId('alert-telegram-pending')).toContainText('Protected mode is on for Arbitrum Sepolia');
  await expect(page.getByTestId('alert-telegram-state')).toContainText('except those protected mode holds, named below');
  // A new link code cancels no hold, so the held network stays named.
  await page.getByTestId('alert-telegram-link').click();
  await expect(page.getByTestId('alert-telegram-code')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('alert-telegram-pending')).toContainText('Protected mode is on for Arbitrum Sepolia');
  await page.reload();
  await expect(page.getByTestId('alert-telegram-pending')).toContainText('Protected mode is on for Arbitrum Sepolia', { timeout: 30_000 });

  // The service names each held network as { chain_id, effective_at }.
  await controlAgent({ next: { path: '/unlink/telegram', status: 200, body: { ok: true, scope: 'chain', pending: [{ chain_id: 84532, effective_at: 1_800_000_000 }] } } });
  await page.getByTestId('alert-telegram-unlink').click();
  // A one-network answer replaces this network's hold and keeps the others.
  const heldHere = page.getByTestId('alert-telegram-pending').filter({ hasText: 'Base Sepolia' });
  await expect(heldHere).toContainText('Protected mode is on for Base Sepolia: that chat keeps every alert until Jan 15, 2027', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('alert-telegram-pending').filter({ hasText: 'Arbitrum Sepolia' })).toHaveCount(1);
  await controlAgent({ next: { path: '/unlink/telegram', status: 200, body: { ok: true, scope: 'chain', pending: [{ chain_id: 84532, effective_at: null }] } } });
  await page.getByTestId('alert-telegram-unlink').click();
  await expect(heldHere).toContainText('The protection delay starts only once the chat has been told', { timeout: 30_000 });
  await expect(page.getByTestId('alert-telegram-state')).toContainText('A smart-account wallet unlinks one network at a time.');
  await controlAgent({ next: { path: '/unlink/telegram', status: 503, body: { error: 'protection-unknown' } } });
  await page.getByTestId('alert-telegram-unlink').click();
  await expect(page.getByTestId('alert-run')).toHaveAttribute('data-problem', 'protection-unknown', { timeout: 30_000 });
  await fitsWidth(page);
});

test('push is offered only when the service can send; reminders and health lines save signed', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('borrower');
  const me = account.address;
  await openChannels(page);
  const push = page.getByTestId('alert-push');
  await expect(push.getByTestId('alert-push-available')).toContainText('Push alerts can be sent now, from the Vaipakam channel', { timeout: 30_000 });
  await expect(push.getByTestId('alert-push-channel')).toHaveAttribute('href', /\/channels\/0x00000000000000000000000000000000000e2e01$/);
  await push.getByTestId('alert-push-enable').click();
  await expect(push.getByTestId('alert-push-on')).toContainText('Switched on from this browser at', { timeout: 30_000 });
  const pushReq = await lastRequest('/thresholds');
  expect(pushReq.body).toMatchObject({ push_channel: 'subscribed' });
  expect(pushReq.body).not.toHaveProperty('warn_hf');
  expect(pushReq.body).not.toHaveProperty('notify_maturity_approaching');
  await signedBy(pushReq, me, (w, c, t) => buildAlertSettingsMessage(w, c, { pushAlerts: true }, t));

  // Payment reminders: off, then on, each save carrying only that switch.
  await expect(page.getByTestId('alert-due-state')).toContainText('on unless they were switched off elsewhere');
  await page.getByTestId('alert-due-toggle').click();
  await expect(page.getByTestId('alert-due-state')).toContainText('Switched off from this browser at', { timeout: 30_000 });
  const off = await lastRequest('/thresholds');
  expect(off.body).toMatchObject({ notify_maturity_approaching: false });
  expect(off.body).not.toHaveProperty('push_channel');
  await signedBy(off, me, (w, c, t) => buildAlertSettingsMessage(w, c, { dueDateReminders: false }, t));
  await page.getByTestId('alert-due-toggle').click();
  await expect(page.getByTestId('alert-due-state')).toContainText('Switched on from this browser at', { timeout: 30_000 });

  // Health warnings: fixed lines in Basic, editable in Advanced.
  await expect(page.getByTestId('alert-health-bands')).toContainText('below 1.5, 1.2 and 1.05; liquidation is at 1.0.');
  await expect(page.getByTestId('alert-bands-form')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('app.mode', 'advanced'));
  await page.reload();
  const form = page.getByTestId('alert-bands-form');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByTestId('alert-band-alert').fill('1.6');
  await expect(form.getByTestId('alert-bands-problem')).toContainText('The warning must be above the alert');
  await expect(form.getByTestId('alert-bands-save')).toBeDisabled();
  await form.getByTestId('alert-band-warn').fill('1.8');
  await form.getByTestId('alert-band-critical').fill('1.1');
  await form.getByTestId('alert-bands-save').click();
  await expect(page.getByTestId('alert-health-bands')).toContainText('below 1.8, 1.6 and 1.1', { timeout: 30_000 });
  const bands = await lastRequest('/thresholds');
  expect(bands.body).toMatchObject({ warn_hf: 1.8, alert_hf: 1.6, critical_hf: 1.1 });
  await signedBy(bands, me, (w, c, t) => buildAlertSettingsMessage(w, c, { bands: { warnHf: 1.8, alertHf: 1.6, criticalHf: 1.1 } }, t));
  expect((await agentState()).thresholds[me.toLowerCase()]).toMatchObject({ warn_hf: 1.8, notify_maturity_approaching: true, push_channel: 'subscribed' });
  await fitsWidth(page);
  await page.evaluate(() => localStorage.setItem('app.mode', 'basic'));
});

test('push that cannot send is not offered, and a service that cannot be asked is stated', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await controlAgent({ push: 'agent-only' });
  await openChannels(page);
  await expect(page.getByTestId('alert-push-scope')).toContainText('Push covers payment reminders only right now', { timeout: 30_000 });

  await controlAgent({ push: 'unavailable' });
  await page.reload();
  await expect(page.getByTestId('alert-push-unavailable')).toContainText('Push alerts can’t be switched on right now.', { timeout: 30_000 });
  // The service's reason is a setting of this deployment, and said as one.
  await expect(page.getByTestId('alert-push-unavailable')).toContainText('This deployment has not been given the key that signs push alerts. This is the sender of payment reminders.');
  await expect(page.getByTestId('alert-push')).toContainText('This is how this deployment is set up, not a passing outage.');
  await expect(page.getByTestId('alert-push-enable')).toHaveCount(0);

  await controlAgent({ push: 'down' });
  await page.reload();
  await expect(page.getByTestId('alert-push-unknown')).toContainText('Could not ask whether push alerts can be sent', { timeout: 30_000 });
  await expect(page.getByTestId('alert-push-enable')).toHaveCount(0);
  await fitsWidth(page);
});

test('a declined signature sends nothing, and a request already used is refused', async ({ launchWallet }) => {
  const { page, flags } = await launchWallet('visitor');
  await openChannels(page);
  flags.rejectMessages = true;
  await page.getByTestId('alert-due-toggle').click();
  await expect(page.getByTestId('alert-run')).toContainText('The signature was declined, so nothing was sent.', { timeout: 30_000 });
  expect(flags.messageRequests).toBe(1);
  expect((await agentState()).requests).toHaveLength(0);
  await expect(page.getByTestId('alert-due-state')).toContainText('on unless they were switched off elsewhere');

  flags.rejectMessages = false;
  await controlAgent({ next: { path: '/thresholds', status: 409, body: { error: 'request-already-used' } } });
  await page.getByTestId('alert-due-toggle').click();
  await expect(page.getByTestId('alert-run')).toContainText('That signed request was already used; sign again to repeat it.', { timeout: 30_000 });
  await expect(page.getByTestId('alert-due-state')).toContainText('on unless they were switched off elsewhere');
});

test('with Terms in force, linking Telegram asks for them first; switching off never does', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
    const { page, flags } = await launchWallet('freshLender');
    await openChannels(page);

    // Switching reminders off is not a sign-up: no Terms asked.
    await page.getByTestId('alert-due-toggle').click();
    await expect(page.getByTestId('alert-due-state')).toContainText('Switched off from this browser at', { timeout: 30_000 });
    expect(flags.sentTransactions).toBe(0);

    // Leaving the page mid-acceptance keeps the action the prompt was for:
    // back on Alerts it still asks for push, not for a Telegram link.
    await page.getByRole('link', { name: 'Vaipakam home' }).click();
    await page.getByTestId('inbox-bell').click();
    await page.getByTestId('alert-push-enable').click();
    const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
    await expect(dialog).toContainText('Switching on push alerts needs the Terms of Service', { timeout: 30_000 });
    await page.goBack();
    await expect(page.getByTestId('alert-channels')).toHaveCount(0);
    await page.goForward();
    await expect(dialog).toContainText('Switching on push alerts needs the Terms of Service', { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByTestId('alert-telegram-link').click();
    await expect(dialog).toContainText('Linking Telegram alerts needs the Terms of Service', { timeout: 30_000 });
    expect((await agentState()).requests.filter((r) => r.path === '/link/telegram')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Confirm in wallet' }).click();
    await expect(dialog.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Continue: Linking Telegram alerts' }).click();
    await expect(page.getByTestId('alert-telegram-code-value')).toHaveText('E2E00001', { timeout: 30_000 });
    await fitsWidth(page);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
    await anvilRpc('evm_mine');
  }
});
