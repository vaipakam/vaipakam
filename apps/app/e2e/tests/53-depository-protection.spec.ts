/** Depository vault and protected account mode, driven from the app.
 *
 *  The contract side (the per-token ledger, the payout queue, the lock) is
 *  pinned by the Foundry suites. What nothing drove was the app: the vault
 *  page's deposit-and-withdraw card and the vault protection page. This
 *  spec drives one account through the whole loop and takes every verdict
 *  from the chain, not from a banner:
 *
 *    1. a deposit through the card raises the account's free holding by
 *       exactly the typed amount;
 *    2. turning protection on from the page enables it with the chosen
 *       delay;
 *    3. a withdrawal through the card is QUEUED, not paid: the wallet's
 *       balance does not move and the free figure falls by the earmark;
 *    4. the protection page lists that payout under the request code the
 *       contract derives for it, and cancelling it there frees the amount
 *       again;
 *    5. the emergency lock locks the account.
 *
 *  It runs on `vaultOwner`, a role no loan scenario uses, because an
 *  account with protection on delays every payout to its wallet.
 */
import { parseUnits } from 'viem';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
import { test, expect } from '../lib/wallet-fixture';
import { TLIQ } from '../lib/desk';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI } from '../lib/chain';

const read = <T,>(functionName: string, args: readonly unknown[]) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName, args: args as unknown[] }) as Promise<T>;

// What the card offers: the depository holding, bounded by liens and queued
// payouts — the same figure the contract's withdraw is bounded by.
const freeOf = (who: `0x${string}`) => read<bigint>('withdrawableNow', [who, 0, TLIQ, 0n]);

test('deposit, protect, queue, cancel, list a pending address and lock — all from the app', async ({ launchWallet }) => {
  const owner = await launchWallet('vaultOwner');
  const { page, account } = owner;
  const me = account.address;

  // ── 1. Deposit through the card ──────────────────────────────────────
  const freeBefore = await freeOf(me);
  await page.goto('/vault', { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/contract address/i).fill(TLIQ);
  await page.getByLabel(/^amount$/i).fill('10');
  await page.getByRole('button', { name: /^deposit$/i }).click();
  await expect(page.getByText(/deposited\. it can take a moment/i)).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => freeOf(me), { timeout: 60_000 }).toBe(freeBefore + parseUnits('10', 18));
  await expect(page.getByText(/yours to withdraw now/i)).toBeVisible({ timeout: 60_000 });
  // The contract lists the deposited asset, so the vault page finds it
  // after a reload even when no loan or offer names it.
  const [listed] = await read<readonly [readonly string[], bigint]>('getDepositoryAssets', [me, 0n, 50n]);
  expect(listed.map((a) => a.toLowerCase()), 'the deposit is listed').toContain(TLIQ.toLowerCase());

  // ── 2. Turn protection on ────────────────────────────────────────────
  await page.goto('/vault/protection', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /protection is off/i })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel(/payout delay/i).selectOption({ label: '3 days' });
  await page.getByRole('button', { name: /turn on protection/i }).click();
  await expect
    .poll(async () => (await read<{ enabled: boolean }>('getProtectedAccount', [me])).enabled, { timeout: 120_000 })
    .toBe(true);
  const record = await read<{ delaySeconds: number | bigint }>('getProtectedAccount', [me]);
  expect(Number(record.delaySeconds), 'the chosen delay is the one enabled').toBe(3 * 86_400);

  // ── 3. A withdrawal is queued, not paid ──────────────────────────────
  const walletBefore = (await pub.readContract({
    address: TLIQ,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [me],
  })) as bigint;
  const freeProtected = await freeOf(me);
  await page.goto('/vault', { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/contract address/i).fill(TLIQ);
  await page.getByLabel(/^amount$/i).fill('4');
  // The button says it queues BEFORE the user signs.
  await expect(page.getByText(/protection is on, so a withdrawal waits 3 days/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /queue withdrawal to my wallet/i }).click();
  await expect(page.getByText(/withdrawal queued/i)).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => freeOf(me), { timeout: 60_000 }).toBe(freeProtected - parseUnits('4', 18));
  const walletAfter = (await pub.readContract({
    address: TLIQ,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [me],
  })) as bigint;
  expect(walletAfter, 'a queued withdrawal must not pay the wallet yet').toBe(walletBefore);

  const ids = await read<bigint[]>('getPendingPayoutIds', [me]);
  expect(ids.length, 'exactly one payout is queued').toBe(1);
  const code = formatRequestCode(await read<number>('requestCode', [ids[0]]));
  expect(code).not.toBeNull();

  // ── 4. The page lists it under its code; cancel it there ─────────────
  await page.goto('/vault/protection', { waitUntil: 'domcontentloaded' });
  const row = page.locator('.item-row', { hasText: `Request code ${code}` });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(/waits until/i);
  await row.getByRole('button', { name: /^cancel$/i }).click();
  await expect.poll(() => freeOf(me), { timeout: 120_000 }).toBe(freeProtected);
  const cancelled = await read<{ state: number | bigint }>('getPendingPayout', [ids[0]]);
  expect(Number(cancelled.state), 'the row is Cancelled, not Released').toBe(3);

  // ── 4b. A pending payout address is listed with its deadline ─────────
  const destination = '0x00000000000000000000000000000000000d0d01';
  const allowlist = page.locator('section', { has: page.getByRole('heading', { name: /payout addresses/i }) });
  await allowlist.getByLabel(/0x… address/i).fill(destination);
  await allowlist.getByRole('button', { name: /^add address$/i }).click();
  await expect
    .poll(async () => (await read<readonly [readonly string[], readonly bigint[]]>('getPendingAllowlistAdditions', [me]))[0].length, {
      timeout: 120_000,
    })
    .toBe(1);
  const pendingRow = allowlist.getByTestId('pending-addition');
  await expect(pendingRow).toContainText(/waiting until/i, { timeout: 60_000 });
  await pendingRow.getByRole('button', { name: /^cancel$/i }).click();
  await expect
    .poll(async () => (await read<readonly [readonly string[], readonly bigint[]]>('getPendingAllowlistAdditions', [me]))[0].length, {
      timeout: 120_000,
    })
    .toBe(0);

  // ── 5. Emergency lock ────────────────────────────────────────────────
  await page.getByRole('button', { name: /lock my vault now/i }).click();
  await expect
    .poll(async () => (await read<{ locked: boolean }>('getProtectedAccount', [me])).locked, { timeout: 120_000 })
    .toBe(true);
  await expect(page.getByText(/your vault is locked/i)).toBeVisible({ timeout: 60_000 });
});
