/** Risk access (#671/#728 port) — the self-sovereign risk-level page,
 *  driven end-to-end on the fork against the real RiskAccessFacet.
 *
 *  Asserts the load-bearing behaviours: (1) the page is reachable from
 *  Settings and renders the wallet's true on-chain state (fresh vaults
 *  sit at the safest level); (2) the enforcement note is HONEST on the
 *  retail deploy (gate off ⇒ "not enforced yet", never implying the
 *  choice is being applied); (3) raising the level submits a real
 *  `setVaultRiskTier` write and the page re-renders the raised choice
 *  (effective or cooling, per the chain's cooldown config); (4)
 *  lowering is immediate; (5) strict mode: ENABLE is honestly withheld
 *  (this app can't collect the per-deal acknowledgement it demands —
 *  Codex #1517 r1), while DISABLE — the recovery lever for a vault
 *  that enabled it elsewhere — works via a real write.
 *
 *  Both tests mutate the shared serial fork's borrower and CI retries
 *  once, so each restores Blue-chip + strict-OFF via direct chain
 *  writes in `finally` (Codex #1517 r4) — a mid-test timeout must not
 *  poison the retry's starting expectations or later specs.
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';
import { DIAMOND, DIAMOND_ABI_VIEM, forkChain, pub, walletFor } from '../lib/chain';
import type { Account } from 'viem';

async function riskWrite(
  account: Account,
  functionName: 'setVaultRiskTier' | 'setRiskStrictMode',
  arg: number | boolean,
): Promise<void> {
  const wallet = walletFor(account);
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args: [arg],
    chain: forkChain,
    account,
  });
  await pub.waitForTransactionReceipt({ hash });
}

/** Restore the wallet's risk state to the suite baseline (Blue-chip,
 *  strict OFF) — only writing what actually differs, so a clean run
 *  costs two reads and no transactions. */
async function resetRiskState(account: Account): Promise<void> {
  const read = (functionName: string) =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName,
      args: [account.address],
    });
  const [rawTier, strict] = await Promise.all([
    read('getVaultRiskTier') as Promise<number | bigint>,
    read('getRiskStrictMode') as Promise<boolean>,
  ]);
  if (Number(rawTier) !== 0) await riskWrite(account, 'setVaultRiskTier', 0);
  if (strict) await riskWrite(account, 'setRiskStrictMode', false);
}

test('risk level renders true chain state, raises with consent, lowers immediately', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('borrower');
  // Normalize FIRST too: a poisoned state from an earlier aborted run
  // must not fail the baseline expectations below.
  await resetRiskState(account);
  try {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await connectWallet(page);

    // Reachable from Settings' "More" list.
    await page.getByRole('link', { name: /risk access/i }).click();
    await expect(page).toHaveURL(/\/risk-access$/);

    const blueChip = page.getByRole('radio', { name: /blue-chip only/i });
    const broadLiquid = page.getByRole('radio', { name: /broad liquid/i });

    // Fresh vault ⇒ safest level selected and active.
    await expect(blueChip).toHaveAttribute('aria-checked', 'true', {
      timeout: 30_000,
    });
    // Retail deploy: the gate master switch is off — the page must say
    // the choice isn't enforced yet, not imply it is.
    await expect(page.getByText(/not enforced on this network yet/i)).toBeVisible();

    // Raise to Broad liquid — a real on-chain write.
    await broadLiquid.click();
    // Wording never claims current use (Codex #1547 r4) — the level is
    // SAVED, active now or after a configured cooldown.
    await expect(page.getByText(/riskier level saved/i)).toBeVisible({ timeout: 60_000 });
    await expect(broadLiquid).toHaveAttribute('aria-checked', 'true');

    // Lower back — immediate, and the safest level reads active (✓).
    await blueChip.click();
    await expect(page.getByText(/level updated/i)).toBeVisible({ timeout: 60_000 });
    await expect(blueChip).toHaveAttribute('aria-checked', 'true');
    await expect(blueChip).toContainText('✓');
  } finally {
    await resetRiskState(account);
  }
});

test('strict mode: enable is honestly withheld, disable works against real chain state', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('borrower');
  await resetRiskState(account);
  try {
    await page.goto('/risk-access', { waitUntil: 'domcontentloaded' });
    await connectWallet(page);

    // OFF state: the app deliberately does NOT offer enabling (it has no
    // surface to collect the per-deal mid-tier acknowledgement strict
    // mode demands — enabling here would lock the user out of their own
    // mid-tier accepts once enforcement is on). The honest note renders
    // instead of a switch.
    await expect(
      page.getByText(/turning it on isn’t offered here yet/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('switch')).toHaveCount(0);

    // Seed strict mode ON directly on-chain (as a vault that enabled it
    // from the reference app would arrive here), then assert the page
    // renders the ON state and the DISABLE path — the recovery lever —
    // works through a real write.
    await riskWrite(account, 'setRiskStrictMode', true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const toggle = page.getByRole('switch', { name: /strict mode is on/i });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    // The unambiguous OFF observable: the switch leaves the page (the
    // withheld-enable posture has no switch). Asserting the "off" copy
    // by text was flaky — the status paragraph AND the disable-linger
    // banner can both say "Strict mode is off." at once.
    await expect(page.getByRole('switch')).toHaveCount(0, {
      timeout: 60_000,
    });
    // Back to the withheld-enable posture.
    await expect(
      page.getByText(/turning it on isn’t offered here yet/i),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await resetRiskState(account);
  }
});
