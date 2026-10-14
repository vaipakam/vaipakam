/** #1949 — a signed-order MAKER authorizes the Full VPFI tariff on the
 *  artifact they sign, from the desk ticket's gasless mode.
 *
 *  One serial spec (workers=1; the fee-entitlement kill-switch is
 *  chain-global, so it is restored in a finally):
 *  1. DARK — while `feeEntitlementEnabled` is false the gasless ticket
 *     offers the maker no opt-in at all (a Full authorization presented
 *     while dark is a failed opt-in at every fill).
 *  2. ENABLED — the maker ticks the opt-in and the downgrade permission;
 *     the maker-specific note renders; the order the stub accepted (its
 *     EIP-712 signature verified against the fork Diamond's domain, the
 *     worker's own check) carries `creatorFull = true`, the ceiling the
 *     control showed, and `creatorAllowFullDowngrade = true`; and the
 *     CONTRACT's own hash of that order equals the stub's, so the three
 *     fields are part of what the maker signed. This is the
 *     discriminating leg: a ticket that dropped the choice would sign
 *     `creatorFull = false` and fail here. Before posting, the straddle
 *     (Codex #2489 r1 P1): a ticked Full choice with no ceiling keeps Post
 *     disabled, with consent given, rather than signing the order Full-off.
 *
 *  The fill-time charge itself (the maker's C* taken at materialization,
 *  the pro-rata ceiling) is pinned by the contract suite
 *  (FeeEntitlementFacetTest, #1949's cells); this spec pins that the app
 *  puts the maker's choice INTO the signed artifact.
 */
import { parseEther, parseUnits } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { consentAndWaitEnabled } from '../lib/flows';
import { WETH } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { MUSDC, freshTenor, openMarketViaCustomPair } from '../lib/desk';
import { fetchSignedBook, signedOrderHashOnChain } from '../lib/signed';
import { setFeeEntitlementEnabled } from '../lib/feeEntitlement';

/** Fill the ticket's lender terms and switch to signing-only (gasless) GTC. */
async function fillGaslessLenderTicket(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.locator('#desk-amount').fill('0.002');
  await page.locator('#desk-rate').fill('7.77');
  await page.locator('#desk-collateral-amount').fill('100');
  await page
    .getByRole('group', { name: 'How long it stays open' })
    .getByRole('button', { name: 'Until I cancel', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'How to post' })
    .getByRole('button', { name: 'Sign only (free)', exact: true })
    .click();
}

test('signed-order maker Full tariff: dark hides it; enabled signs the maker’s choice into the order', async ({
  launchWallet,
}) => {
  test.setTimeout(240_000);

  // ── 1. Dark default: no opt-in on the gasless ticket. ──
  {
    const tenor = await freshTenor(WETH, MUSDC);
    const maker = await launchWallet('lender', { advanced: true });
    await openMarketViaCustomPair(maker.page, tenor, MUSDC);
    await connectWallet(maker.page);
    await fillGaslessLenderTicket(maker.page);
    // The ticket is complete (the post button exists) and still no control.
    await expect(maker.page.getByRole('button', { name: 'Sign and post' })).toBeVisible();
    await expect(maker.page.getByTestId('full-tariff-optin')).toHaveCount(0);
    await maker.ctx.close();
  }

  // ── 2. Enabled: the maker's choice is signed into the order. ──
  await setFeeEntitlementEnabled(true);
  try {
    const tenor = await freshTenor(WETH, MUSDC);
    const maker = await launchWallet('lender', { advanced: true });
    await openMarketViaCustomPair(maker.page, tenor, MUSDC);
    await connectWallet(maker.page);
    await fillGaslessLenderTicket(maker.page);

    const card = maker.page.getByTestId('full-tariff-optin');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Fixture-live: the opt-in is offerable (a live quote, a liquid
    // principal) before it is ticked — otherwise the tick is disabled and
    // the leg would assert nothing about signing.
    const optIn = card.getByRole('checkbox').first();
    await expect(optIn).toBeEnabled({ timeout: 30_000 });
    await optIn.check();
    await expect(card.getByTestId('full-tariff-maker-note')).toBeVisible();
    const ceilingInput = card.getByTestId('full-tariff-ceiling');
    await expect(ceilingInput).not.toHaveValue('');
    const ceiling = parseUnits(await ceilingInput.inputValue(), 18);
    expect(ceiling > 0n, 'the control seeded a positive ceiling').toBe(true);
    // The downgrade permission — the third signed field, ticked so every
    // field the maker controls differs from the default.
    await card.getByRole('checkbox').nth(1).check();

    const post = maker.page.getByRole('button', { name: 'Sign and post' });
    // The consent box BY NAME: the Full opt-in is the first checkbox on this
    // ticket, so the helper's default would re-tick it instead.
    const termsConsent = maker.page.getByRole('checkbox', { name: /I understand and agree to the Risk Disclosures/ });
    await consentAndWaitEnabled(maker.page, post, termsConsent);

    // Codex #2489 r1 P1 — the straddle: a ticked Full choice that is not valid
    // (here, no ceiling) is never signed, and never quietly signed as "Full
    // off". With consent given again, Post stays DISABLED and the ticket names
    // the reason; restoring the ceiling enables it. (Editing a Full field
    // clears consent, so it is re-ticked first — only the Full gate can then
    // keep the button disabled.)
    const seeded = await ceilingInput.inputValue();
    await ceilingInput.fill('');
    if (!(await termsConsent.isChecked())) await termsConsent.check();
    // The TICKET's own blocker line, by its tag: the opt-in card repeats the
    // same sentence as its field hint, so a page-wide text match is ambiguous.
    await expect(maker.page.getByTestId('post-blocker')).toHaveText(
      /before opting in — a Full opt-in without a ceiling can’t be signed\./,
    );
    await expect(post).toBeDisabled();
    await ceilingInput.fill(seeded);
    await consentAndWaitEnabled(maker.page, post, termsConsent);
    await post.click();
    await expect(
      maker.page.getByText(/Signed offer posted — no network fee spent\./),
    ).toBeVisible({ timeout: 60_000 });

    const book = await fetchSignedBook(WETH, MUSDC, tenor);
    expect(book).toHaveLength(1);
    const row = book[0];
    expect(row.signer).toBe(accountFor('lender').address.toLowerCase());
    expect(row.order.amountMax).toBe(parseEther('0.002').toString());
    expect(row.order.creatorFull, 'the opt-in is in the signed order').toBe(true);
    expect(row.order.creatorMaxCStar, 'the ceiling the control showed').toBe(ceiling.toString());
    expect(row.order.creatorAllowFullDowngrade, 'the downgrade permission').toBe(true);
    // The contract's own struct hash of the served order equals the hash the
    // stub verified the signature over: the fields are signed, not attached.
    expect(await signedOrderHashOnChain(row.order)).toBe(row.orderHash);
    await maker.ctx.close();
  } finally {
    await setFeeEntitlementEnabled(false);
  }
});
