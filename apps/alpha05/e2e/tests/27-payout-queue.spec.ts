/**
 * The protected-account payout queue on Claims (matrix LN-54, LN-55, LN-56;
 * RB-PAYOUT-QUEUE), against queues built through the protocol's public entry
 * points on the fixture chain: protected mode switched on, WETH deposited
 * into the vault, then withdrawn, which queues each withdrawal for the
 * account's delay. Each row is listed in the order it comes due under the
 * request code the chain derives; the owner cancels one and releases another
 * once due, and a secondary signer finds the account through Advanced mode's
 * lookup, approves a payout the account requires approval for, and releases
 * it. Every finish card reports what the transaction's own logs show. Runs
 * on the desktop and the phone project; the chain is reverted after each
 * test, so no later spec meets a protected account.
 */
import { erc20Abi, parseEther, type Address } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
import type { Page } from '@playwright/test';
import { anvilRpc, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { VAULT_SIGNER } from '@vaipakam/lib/vaultProtectionAuth';
import { enableProtection, protect } from '../lib/protection';

type Hex = `0x${string}`;
type Pending = { state: number; cosigned: boolean; releaseAt: bigint; amount: bigint };

const DELAY = 2 * 24 * 60 * 60;
const AMOUNT = parseEther('0.01');

// The chain as each test found it. A revert leaves the head at the
// snapshot's timestamp while the next block mines at the wall clock, so a
// block is mined at once (see 26-loan-claims).
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Protected mode on for the lender, with `count` withdrawals queued. */
async function queueWithdrawals(sc: ReturnType<typeof scenario>, count: number, before?: () => Promise<void>): Promise<{ owner: Address; ids: bigint[]; codes: string[] }> {
  const owner = sc.address('lender');
  const total = AMOUNT * BigInt(count);
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], total);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, total]);
  await enableProtection(sc, 'lender', DELAY);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, total]);
  if (before) await before();
  for (let i = 0; i < count; i++) await sc.diamondWrite('lender', 'withdrawFromVault', [owner, 0, WETH, 0n, AMOUNT, owner]);
  const ids = [...(await sc.read<readonly bigint[]>('getPendingPayoutIds', [owner]))];
  expect(ids).toHaveLength(count);
  const codes = await Promise.all(ids.map(async (id) => formatRequestCode(await sc.read<number>('requestCode', [id]))!));
  return { owner, ids, codes };
}

test('the owner sees the queue in due order, cancels one payout and releases another once due', async ({ launchWallet }) => {
  const sc = scenario();
  const { owner, ids, codes } = await queueWithdrawals(sc, 2);
  const [first, second] = ids as [bigint, bigint];

  const { page, flags } = await launchWallet('lender');
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Payouts waiting in your queue' });
  await expect(section).toContainText('Each payout waits 2 days, then anyone may release it to its destination.', { timeout: 60_000 });
  await expect(section).toContainText(/keeper service/);
  const rowOf = (id: bigint) => section.locator(`[data-queue-row="${id}"]`);
  for (const [i, id] of ids.entries()) {
    await expect(section.getByTestId(`queue-code-${id}`)).toHaveText(codes[i]!);
    await expect(rowOf(id)).toContainText('0.01 WETH');
    await expect(rowOf(id)).toContainText('Your wallet');
    await expect(rowOf(id)).toContainText(/Releasable from .* UTC\./);
    // Not due: only cancelling is offered.
    await expect(rowOf(id).getByTestId(`queue-release-${id}`)).toHaveCount(0);
    await expect(rowOf(id).getByTestId(`queue-cosign-${id}`)).toHaveCount(0);
  }
  await fitsWidth(page);

  // Cancel the first.
  await rowOf(first).getByTestId(`queue-cancel-${first}`).click();
  const cancel = page.getByTestId(`queue-cancel-panel-${first}`);
  const receipt = cancel.locator('.receipt');
  await expect(receipt).toContainText(`Cancel payout ${codes[0]}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Request code');
  await expect(receipt).toContainText('Cancelling stops this payout: nothing is paid, and 0.01 WETH stays in the vault, free to withdraw again.');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);
  let sent = flags.sentTransactions;
  await cancel.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = cancel.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Payout cancelled: 0.01 WETH stays in the vault');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect((await sc.read<Pending>('getPendingPayout', [first])).state).toBe(3);
  // The card stays until closed, though the queue no longer lists the row.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(rowOf(first)).toHaveCount(0, { timeout: 60_000 });

  // Release the second once the delay has passed by the chain's clock.
  await increaseTime(DELAY + 60);
  await mine();
  await page.reload();
  await connectWallet(page);
  await expect(rowOf(second)).toContainText('Now', { timeout: 60_000 });
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  await rowOf(second).getByTestId(`queue-release-${second}`).click();
  const release = page.getByTestId(`queue-release-panel-${second}`);
  await expect(release.locator('.receipt')).toContainText(`Release payout ${codes[1]}`, { timeout: 60_000 });
  await expect(release.locator('.receipt')).toContainText('Releasing pays 0.01 WETH from the account’s vault to Your wallet.');
  sent = flags.sentTransactions;
  await release.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = release.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('0.01 WETH paid to Your wallet');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })).toBe(before + AMOUNT);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.getByTestId('queue-empty-own')).toContainText('Nothing is waiting in this queue.', { timeout: 60_000 });
});

test('a secondary signer looks the account up, approves a payout that needs approval, and releases it', async ({ launchWallet }) => {
  const sc = scenario();
  const signer = sc.address('borrower');
  const { owner, ids, codes } = await queueWithdrawals(sc, 1, async () => {
    // A signer nominated, accepted from its own key, active after the delay;
    // then every release needs a signer's approval.
    await protect(sc, 'lender', sc.address('lender'), 'signerChange', [VAULT_SIGNER.add, signer]);
    await protect(sc, 'borrower', sc.address('lender'), 'signerChange', [VAULT_SIGNER.accept, signer]);
    await increaseTime(DELAY + 60);
    await mine();
    await protect(sc, 'borrower', sc.address('lender'), 'finalizeSigner', [signer], false);
    await sc.diamondWrite('lender', 'setRequireCosign', [sc.address('lender'), true]);
  });
  const id = ids[0]!;
  await increaseTime(DELAY + 60);
  await mine();

  const { page, flags } = await launchWallet('borrower', { advanced: true });
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Payouts waiting in your queue' });
  await expect(section.getByTestId('queue-off-own')).toContainText('Protected mode is off for your account', { timeout: 60_000 });
  await section.getByTestId('queue-lookup').fill(owner);
  const account = section.locator(`[data-queue-account="${owner.toLowerCase()}"]`);
  const row = account.locator(`[data-queue-row="${id}"]`);
  await expect(account).toContainText('needs a secondary signer’s approval', { timeout: 60_000 });
  await expect(section.getByTestId(`queue-code-${id}`)).toHaveText(codes[0]!);
  await expect(row).toContainText('Not yet approved');
  await expect(row).toContainText(/The account’s wallet, 0x/);
  // Due, but not approved: the release is closed and says why.
  await expect(row.locator('[data-code="CosignRequired"]')).toContainText('requires a secondary signer to approve each release');
  await fitsWidth(page);

  await row.getByTestId(`queue-cosign-${id}`).click();
  const cosign = page.getByTestId(`queue-cosign-panel-${id}`);
  await expect(cosign.locator('.receipt')).toContainText(`Approve payout ${codes[0]} as signer`, { timeout: 60_000 });
  await expect(cosign.locator('.receipt')).toContainText('Approving lets this payout be released once its delay has passed. Nothing moves now.');
  let sent = flags.sentTransactions;
  await cosign.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = cosign.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Payout ${codes[0]} approved for release once due`);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect((await sc.read<Pending>('getPendingPayout', [id])).cosigned).toBe(true);
  // The finish card does not hang on the lookup field: cleared, the card
  // stays on screen under the account it acted on.
  await section.getByTestId('queue-lookup').fill('');
  await expect(section.locator('[data-role="held"]').getByTestId(`queue-cosign-panel-${id}`)).toContainText(`Payout ${codes[0]} approved for release once due`);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(section.locator('[data-role="held"]')).toHaveCount(0);
  await section.getByTestId('queue-lookup').fill(owner);

  // Approved and due: anyone may release it, and it pays the account's wallet.
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  await expect(row).toContainText('Approved', { timeout: 60_000 });
  await row.getByTestId(`queue-release-${id}`).click();
  const release = page.getByTestId(`queue-release-panel-${id}`);
  await expect(release.locator('.receipt')).toContainText('Account', { timeout: 60_000 });
  sent = flags.sentTransactions;
  await release.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = release.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/0\.01 WETH paid to The account’s wallet, 0x/);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })).toBe(before + AMOUNT);
});
