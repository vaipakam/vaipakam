/** Rate Desk phase 1 (#1129) — book / ticket / amend / cancel on the
 *  fork, per the issue's DoD and the COVERAGE.md gap row.
 *
 *  Market choice: every test trades WETH (lending) / faucet tLIQ
 *  (collateral) — the pair the role wallets are seeded for — but at a
 *  TENOR bucket verified live-empty on the fork first. The on-chain
 *  matcher requires exact durationDays equality, so a fresh tenor IS a
 *  fresh market: the inherited Base Sepolia book can never leak rows
 *  into the ladder under test, and exact rate/size/mid/spread
 *  assertions stay deterministic without faking anything.
 *
 *  Harness notes: the desk's book is a two-step CHAIN read
 *  (getActiveOffersByAssetPairRanked + hydration) with the indexer as
 *  fallback, so the ladder needs no stub support; the markets summary
 *  (pair dropdown) comes from the stub's /offers/markets route, which
 *  aggregates live from the fork. The tape route (/loans/recent) is
 *  deliberately not stubbed — the tape shows its honest unavailable
 *  state, which none of these tests assert on.
 *
 *  The market/seeding helpers live in lib/desk.ts, shared with spec 18
 *  (chart + History) so the two desk specs can't drift on conventions.
 */
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { chooseMenuValue, consentAndWaitEnabled, newestOfferIdFor } from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { DIAMOND, DIAMOND_ABI_VIEM, WETH, pub } from '../lib/chain';
import {
  TLIQ,
  freshTenor,
  getOffer,
  openMarketViaCustomPair,
  seedDeskOffer,
  selectTenor,
} from '../lib/desk';

test('Rate Desk nav entry is advanced-only but /desk stays URL-reachable in Basic', async ({
  launchWallet,
}) => {
  // Basic mode (the default): positively loaded shell first, so the
  // absence assert can't false-pass before React mounts.
  const basic = await launchWallet('newBorrower');
  await expect(
    basic.page.getByRole('link', { name: 'Home' }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(basic.page.getByRole('link', { name: 'Rate Desk' })).toHaveCount(0);
  // Hidden-not-blocked doctrine: the URL still works in Basic.
  await basic.page.goto('/desk', { waitUntil: 'domcontentloaded' });
  await expect(
    basic.page.getByRole('heading', { name: 'Rate Desk', level: 1 }),
  ).toBeVisible({ timeout: 30_000 });

  // Advanced mode: the nav entry appears and routes to the desk.
  const adv = await launchWallet('newBorrower', { advanced: true });
  const link = adv.page.getByRole('link', { name: 'Rate Desk' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(
    adv.page.getByRole('heading', { name: 'Rate Desk', level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
});

test('an empty market renders the honest empty state; a seeded two-sided book renders the ladder with quoted mid/spread', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor();
  const lender = await launchWallet('lender', { advanced: true });
  const { page } = lender;
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);

  // Honesty: a (pair, tenor) with no live offers is an EMPTY ladder
  // with the honest copy — never a fake ladder, never "unavailable".
  await expect(
    page.getByText(/no open offers for this market yet/i),
  ).toBeVisible({ timeout: 30_000 });

  // Seed both sides directly on the fork (the ticket test below owns
  // the UI post path; specs 02/03 keep covering the guided flows).
  // Distinctive rates so a collision with anything is impossible in a
  // tenor verified empty: ask 9.37% floor, bid 6.11% ceiling.
  await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 937,
    amountWeth: '0.005',
    collateralTliq: '100',
    days: tenor,
  });
  const bidId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 611,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });

  // Pair/tenor selection is component state — reload + reselect forces
  // a fresh book query instead of waiting out the 30 s poll. wagmi
  // auto-reconnects the injected wallet across loads, but the
  // own-order assertions below NEED the address — make it a hard gate,
  // not an assumption.
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);
  const ladder = page.locator('.desk-ladder');

  // Ask side: the lender's floor rate, remaining size, own-order
  // highlight (this session IS the creator).
  const askLevel = ladder.locator('.desk-ladder-row').filter({ hasText: '9.37%' });
  await expect(askLevel).toHaveCount(1, { timeout: 30_000 });
  await expect(askLevel.locator('.desk-rate-ask')).toBeVisible();
  await expect(askLevel).toContainText('0.005');
  await expect(askLevel).toHaveClass(/desk-own/);
  // Own top-of-book gets NO taker affordance — direct-accepting your
  // own offer would only mint a doomed transaction.
  await expect(askLevel.getByRole('link')).toHaveCount(0);

  // Bid side: the borrower's ceiling rate — someone else's order, so
  // no own-highlight and the top-of-book taker deep link is armed.
  const bidLevel = ladder.locator('.desk-ladder-row').filter({ hasText: '6.11%' });
  await expect(bidLevel).toHaveCount(1);
  await expect(bidLevel.locator('.desk-rate-bid')).toBeVisible();
  await expect(bidLevel).toContainText('0.002');
  await expect(bidLevel).not.toHaveClass(/desk-own/);
  const take = bidLevel.getByRole('link', { name: 'Lend to this' });
  await expect(take).toBeVisible();
  await expect(take).toHaveAttribute('href', new RegExp(`offer=${bidId}&`));

  // Exactly our two levels — the tenor was picked empty, so nothing
  // inherited can pad the ladder.
  await expect(ladder.locator('.desk-ladder-row')).toHaveCount(2);

  // Header stats quote the ladder: mid (937+611)/2 = 774 bps, spread
  // 937−611 = 326 bps.
  const stat = (label: string) =>
    page.locator('.desk-stat').filter({ hasText: label }).locator('.desk-stat-value');
  await expect(stat('Quoted mid')).toHaveText('7.74%');
  await expect(stat('Spread')).toHaveText('3.26%');
});

test('ticket posts a GTC/Partial lend order, amend reprices it in ONE modifyOffer, cancel clears it from book and open orders', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor();
  // A resting borrower bid guarantees the pair shows up in the
  // markets summary, so THIS test selects it through the markets
  // dropdown (test 2 covers the custom-pair branch) — and the ladder
  // keeps one non-own level as a control throughout.
  await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 500,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });

  const lender = await launchWallet('lender', { advanced: true });
  const { page, account } = lender;
  await page.goto('/desk', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await chooseMenuValue(
    page,
    'desk-pair',
    `${WETH.toLowerCase()}:${TLIQ.toLowerCase()}`,
  );
  await selectTenor(page, tenor);

  const [beforeIds] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserOffersPaginated',
    args: [account.address, 0n, 200n],
  })) as [readonly bigint[], bigint];

  // ---- ticket: lend side, GTC, Partial — all chosen explicitly ----
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.locator('#desk-amount').fill('0.004');
  await page.locator('#desk-rate').fill('8');
  // The collateral ASSET is fixed to the selected market's (read-only
  // display, no picker) — the ticket can never post into a pair the
  // ladder isn't showing. Only the AMOUNT is typed.
  await expect(page.locator('#desk-collateral-asset')).toContainText(
    new RegExp(`${TLIQ.slice(0, 6)}…${TLIQ.slice(-4)}`, 'i'),
  );
  await page.locator('#desk-collateral-amount').fill('100');
  await page
    .getByRole('group', { name: 'Expiry' })
    .getByRole('button', { name: 'GTC', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Fill mode' })
    .getByRole('button', { name: 'Partial', exact: true })
    .click();
  const post = page.getByRole('button', { name: /^post order$/i });
  await consentAndWaitEnabled(page, post);
  await post.click();
  await expect(page.getByText(/order posted/i)).toBeVisible({ timeout: 90_000 });

  // The offer landed on-chain with the ticket's exact terms.
  const offerId = await newestOfferIdFor(account.address);
  expect(beforeIds.includes(offerId)).toBe(false);
  const posted = await getOffer(offerId);
  expect(Number(posted.offerType)).toBe(0);
  expect(Number(posted.interestRateBps)).toBe(800);
  expect(Number(posted.durationDays)).toBe(tenor);
  expect(Number(posted.fillMode)).toBe(0); // Partial
  expect(Number(posted.expiresAt)).toBe(0); // GTC

  // …and on the ladder as an OWN level (afterPost invalidates the
  // book query — no reload needed).
  // The ladder renders rates at a FIXED 2 decimals (UX-028) — "8.00%",
  // not "8%" — so the ladder-scoped filters below use the padded form.
  // The Open orders panel (row(), below) keeps the trimmed form.
  const ownAsk = (pct: string) =>
    page.locator('.desk-ladder-row.desk-own').filter({ hasText: pct });
  await expect(ownAsk('8.00%')).toBeVisible({ timeout: 30_000 });

  // …and under Open orders (the default bottom tab), scoped to THIS
  // run's row by id — roles are reused across scenarios and retries.
  const row = () =>
    page
      .locator('.row-list > div')
      .filter({ has: page.getByText(`#${offerId} ·`) })
      .first();
  await expect(row()).toBeVisible({ timeout: 30_000 });
  await expect(row()).toContainText('8%');
  await expect(row()).toContainText('no expiry');

  // ---- amend (#193 first UI): pencil → live-seeded form → ONE
  // modifyOffer — same offerId, same position NFT ----
  await row().getByRole('button', { name: /amend/i }).click();
  const rateInput = page.locator(`#amend-${offerId}-rate`);
  // The form must seed from the LIVE getOffer read before editing.
  await expect(rateInput).toHaveValue('8', { timeout: 30_000 });
  await rateInput.fill('11');
  const save = page.getByRole('button', { name: /save changes/i });
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => Number((await getOffer(offerId)).interestRateBps), {
      timeout: 90_000,
    })
    .toBe(1100);
  // Same offer id survived the amend — modify-in-place, not
  // cancel+repost.
  await expect(row()).toContainText('11%', { timeout: 30_000 });
  await expect(ownAsk('11.00%')).toBeVisible({ timeout: 30_000 });
  await expect(ownAsk('8.00%')).toHaveCount(0);

  // ---- cancel: past the 300 s protocol cooldown (time travel — the
  // inside-the-window refusal is spec 05's job) ----
  await increaseTime(301);
  await row().getByRole('button', { name: /^cancel$/i }).click();
  await expect
    .poll(
      async () => /^0x0{40}$/i.test(String((await getOffer(offerId)).creator)),
      { timeout: 90_000 },
    )
    .toBe(true);
  // Gone from Open orders and from the book; the seeded 5% bid stays
  // as the control that the ladder didn't just blank.
  await expect(
    page.locator('.row-list > div').filter({ has: page.getByText(`#${offerId} ·`) }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(ownAsk('11.00%')).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator('.desk-ladder .desk-ladder-row').filter({ hasText: '5.00%' }),
  ).toHaveCount(1, { timeout: 30_000 });
});
