/**
 * The wallet control (matrix ACC-01, ACC-03): connect, the identity every
 * figure belongs to (address and network, with its "Why?"), and the
 * unsupported-network state as a tier-A notice whose one remedy is a
 * switch to a served network, driven through the wallet.
 */
import { shortAddress } from '../../src/shared/ui/format';
import { connectWallet, expect, test } from '../lib/wallet';

test('connecting shows the address and network as the identity of every figure', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('lender');
  await page.goto('/');
  await connectWallet(page);
  const chip = page.getByTestId('wallet-chip');
  await expect(chip.locator('.wallet-address')).toHaveText(shortAddress(account.address));
  await expect(chip.locator('.wallet-chain')).toHaveText('Base Sepolia');
  const identity = page.locator('.posture p.why').filter({ hasText: `${shortAddress(account.address)} on Base Sepolia` });
  await expect(identity).toBeVisible();
  await identity.getByRole('button', { name: 'Why?' }).click();
  await expect(page.getByRole('dialog').getByText('never read from the index', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the connected wallet’s panel states the full address and network, copies and disconnects, and the page reads nothing on Ethereum mainnet', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('lender');
  // The app reads no mainnet name service: a connected session must reach
  // no host beyond its own origin, its Workers and the local chain (#3476).
  const outside: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (!['127.0.0.1', 'localhost'].includes(host) && !r.url().startsWith('data:')) outside.push(r.url());
  });
  await page.goto('/');
  await connectWallet(page);
  const chip = page.getByTestId('wallet-chip');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByTestId('wallet-panel');
  await expect(panel).toContainText(account.address);
  await expect(panel).toContainText('Network: Base Sepolia.');
  // The panel stays inside the window on a phone.
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(chip).toBeFocused();
  await chip.click();
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('.wallet').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  expect(outside.filter((u) => /merkle|ens|mainnet/i.test(u))).toEqual([]);
});

test('the capability line states what was read from the protocol contract', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  // Read through the stand-in proxy route to the fixture Diamond: a count of
  // routed functions, never a guess. The unreadable wording must not appear.
  await expect(page.locator('.posture').getByText(/^Chain 84532: \d+ routed functions read from the protocol contract\./)).toBeVisible({ timeout: 60_000 });
  const line = await page
    .locator('.posture')
    .getByText(/routed functions read/)
    .textContent();
  expect(Number(/: (\d+) routed/.exec(line ?? '')?.[1])).toBeGreaterThan(100);
  await expect(page.getByText('could not be read, so this build cannot tell', { exact: false })).toHaveCount(0);
});

test('a wallet on a network this app does not serve gets a tier-A notice and the switch remedy', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('borrower', { walletChainId: 31337 });
  await page.goto('/');
  await connectWallet(page);
  const notice = page.getByText('Your wallet is on a network this app does not serve', { exact: false });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Supported: Base Sepolia');
  // From 720px the header grows to hold the notice, and the navigation
  // column below follows it: the notice is neither cut off nor covered.
  if ((page.viewportSize()?.width ?? 0) >= 720) {
    const header = (await page.locator('header.topbar').boundingBox())!;
    const box = (await notice.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(header.y);
    expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height + 1);
    await expect.poll(async () => (await page.locator('.site-menu').boundingBox())!.y).toBeCloseTo(header.y + header.height, 0);
  }
  // Nothing of the visitor's is shown while unsupported: no identity line.
  await expect(page.locator('.posture').getByText(/ on Base Sepolia$/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to Base Sepolia' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId('wallet-chip').locator('.wallet-chain')).toHaveText('Base Sepolia');
  await expect(page.locator('.posture').getByText(`${shortAddress(account.address)} on Base Sepolia`)).toBeVisible();
});

test('an open wallet picker is not called connecting: nothing connects until a wallet is chosen', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.wallet').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(page.locator('.wallet').getByText('Connecting…')).toHaveCount(0);
});
