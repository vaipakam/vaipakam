/** #1030 — copy/legal honesty batch, on Anvil.
 *
 *  Two load-bearing wordings: the Help page must carry the platform
 *  disclaimer EXACTLY as the spec mandates it (§29 — paraphrases are
 *  what this batch fixed), and the mandatory consent label must link
 *  "Risk Disclosures" to the Help risk section and "Vaipakam Terms"
 *  to the marketing Terms — as real anchors, not dead phrases.
 *
 *  ENS display sugar (the third #1030 item) is NOT asserted here:
 *  fork wallets have no mainnet reverse names, so the honest CI
 *  observation is only the hex fallback every other spec already
 *  exercises — see the COVERAGE.md gap row.
 */
import { test, expect } from '../lib/wallet-fixture';
import { lenderOfferFormToReview } from '../lib/flows';

const MANDATED_DISCLAIMER =
  'Vaipakam is a decentralized, non-custodial protocol. No KYC is required. Users are responsible for their own regulatory compliance.';

test('help page carries the mandated disclaimer verbatim and the risk section', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/help', { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByText(MANDATED_DISCLAIMER, { exact: false }),
  ).toBeVisible();
  // The section the consent label's "Risk Disclosures" link targets.
  const risks = page.locator('#risks');
  await expect(risks).toBeVisible();
  await expect(risks).toContainText(/risk disclosures/i);
  await expect(risks.locator('li')).not.toHaveCount(0);
});

test('the consent label links to the risk section and the terms', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await lenderOfferFormToReview(page);
  // Both phrases are real anchors (new tab — the label sits inside an
  // in-flight form whose state a same-tab navigation would destroy).
  const risk = page.locator('a[href="/help#risks"]').first();
  await expect(risk).toBeVisible();
  await expect(risk).toHaveAttribute('target', '_blank');
  const terms = page.locator('a[href="https://vaipakam.com/terms"]').first();
  await expect(terms).toBeVisible();
  await expect(terms).toHaveAttribute('target', '_blank');
});
