/** #1058/#1059 — the advisory pre-sign dry-run footer, on Anvil.
 *
 *  Regression test for the #1059 classifier bug: with a healthy RPC
 *  and a buildable offer, the footer must render a TRUTHFUL verdict —
 *  "dry run passed" or the benign approval note — and never the
 *  cry-wolf would-fail (which is what shipped in #1058 when the
 *  allowance revert came back as an undecodable custom error), and
 *  never silently nothing. The deployed-RPC half of this feature is
 *  re-checked live by `e2e/live/live-dryrun-review.mjs`.
 */
import { test, expect } from '../lib/wallet-fixture';
import { consentAndWaitEnabled, lenderOfferFormToReview } from '../lib/flows';

test('review renders a truthful dry-run verdict', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  const post = await lenderOfferFormToReview(page);
  // The dry run only builds once consent is ticked (consent=false
  // would just preview RiskAndTermsConsentRequired — round 1 of
  // #1058), so use the same consent helper the posting flow uses.
  await consentAndWaitEnabled(page, post);

  // A real verdict must appear…
  await expect(
    page.getByText(/Dry run passed|token approval will be requested first/),
  ).toBeVisible({ timeout: 30_000 });
  // …and the false-alarm forms must not (the #1059 regression, and
  // the silent-unavailable state that would mean the eth_call never
  // reached Anvil).
  await expect(page.getByText(/just failed with/)).toHaveCount(0);
  await expect(page.getByText(/dry run isn’t available/)).toHaveCount(0);
});
