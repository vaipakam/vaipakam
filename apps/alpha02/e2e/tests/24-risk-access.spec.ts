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
 *  lowering is immediate; (5) the strict-mode toggle round-trips.
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';

test('risk level renders true chain state, raises with consent, lowers immediately', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
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
  await expect(page.getByText(/level raised/i)).toBeVisible({ timeout: 60_000 });
  await expect(broadLiquid).toHaveAttribute('aria-checked', 'true');

  // Lower back — immediate, and the safest level reads active (✓).
  await blueChip.click();
  await expect(page.getByText(/level updated/i)).toBeVisible({ timeout: 60_000 });
  await expect(blueChip).toHaveAttribute('aria-checked', 'true');
  await expect(blueChip).toContainText('✓');
});

test('strict mode toggles on and off through real writes', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
  await page.goto('/risk-access', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  const toggle = page.getByRole('switch', { name: /strict mode/i });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  const wasOn = (await toggle.getAttribute('aria-checked')) === 'true';

  await toggle.click();
  await expect(
    page.getByText(wasOn ? /strict mode is off\./i : /strict mode is on\./i),
  ).toBeVisible({ timeout: 60_000 });
  await expect(toggle).toHaveAttribute('aria-checked', String(!wasOn));

  // Restore the starting state so the wallet's later specs (and
  // re-runs against a shared fork) see the same posture.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(wasOn), {
    timeout: 60_000,
  });
});
