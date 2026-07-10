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
 */
import { parseEther, parseUnits } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import {
  chooseMenuValue,
  consentAndWaitEnabled,
  newestOfferIdFor,
} from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import {
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  MOCKS,
  WETH,
  forkChain,
  pub,
  walletFor,
} from '../lib/chain';
import { accountFor, type Role } from '../lib/wallets';
import type { Page } from '@playwright/test';

const TLIQ = MOCKS!.liquidToken as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** Bucket preference for the fresh-tenor pick. 365 is left out to stay
 *  clear of the protocol's offer-duration cap whatever its live value;
 *  30 goes last because it's the app-wide default every other spec
 *  posts into. */
const BUCKET_PREFERENCE = [60, 90, 14, 180, 7, 30] as const;

/** A WETH/tLIQ tenor bucket with NO live offers on the fork right now.
 *  The ranked view is active-only; treating its lazily-expired GTT
 *  rows as live is a safe over-approximation — it can only skip a
 *  bucket, never return a false-empty one. Each test recomputes, so a
 *  previous test's (or retry's) seeds exclude their bucket
 *  automatically. */
async function freshTenor(): Promise<number> {
  const [rankings] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getActiveOffersByAssetPairRanked',
    args: [WETH, TLIQ],
  })) as readonly [readonly { durationDays: bigint }[], bigint];
  const live = new Set(rankings.map((r) => Number(r.durationDays)));
  for (const d of BUCKET_PREFERENCE) if (!live.has(d)) return d;
  throw new Error(
    'every duration bucket for WETH/tLIQ already has live offers on the fork — no fresh market to test in',
  );
}

/** Direct-write seeding (the lib/seed.ts pattern): approve + createOffer
 *  from the role wallet, mirroring offerSchema's canonical
 *  role-asymmetric payload mapping — lender ships floor rate + open
 *  ceiling with amount = the 10% min-partial default; borrower ships a
 *  rate ceiling + zero floor, single-value amount. GTC + Partial, like
 *  the guided flows. */
async function seedDeskOffer(opts: {
  role: Role;
  side: 'lend' | 'borrow';
  rateBps: number;
  amountWeth: string;
  collateralTliq: string;
  days: number;
}): Promise<bigint> {
  const account = accountFor(opts.role);
  const wallet = walletFor(account);
  const amount = parseEther(opts.amountWeth);
  const collateral = parseUnits(opts.collateralTliq, 18);
  const isLend = opts.side === 'lend';
  // Escrowed leg per side: lender pre-vaults amountMax of the lending
  // asset; borrower pre-vaults collateralAmountMax of the collateral.
  const [token, locked] = isLend
    ? [WETH, amount]
    : ([TLIQ, collateral] as const);
  const approveHash = await wallet.writeContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'approve',
    args: [DIAMOND, locked],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  const params = {
    offerType: isLend ? 0 : 1,
    lendingAsset: WETH,
    amount: isLend ? (amount / 10n > 0n ? amount / 10n : 1n) : amount,
    interestRateBps: isLend ? BigInt(opts.rateBps) : 0n,
    collateralAsset: TLIQ,
    collateralAmount: collateral,
    durationDays: BigInt(opts.days),
    assetType: 0,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: ZERO,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: true,
    amountMax: amount,
    interestRateBpsMax: isLend ? 10_000n : BigInt(opts.rateBps),
    collateralAmountMax: collateral,
    periodicInterestCadence: 0,
    expiresAt: 0n, // GTC
    fillMode: 0, // Partial
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: false,
  };
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'createOffer',
    args: [params],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return newestOfferIdFor(account.address);
}

async function getOffer(offerId: bigint): Promise<Record<string, unknown>> {
  return (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOffer',
    args: [offerId],
  })) as Record<string, unknown>;
}

/** Load the WETH/tLIQ market via the header's CUSTOM-pair branch —
 *  deterministic even before anything is seeded (the markets summary
 *  only lists pairs with live offers). The dropdown selection path is
 *  exercised separately by the ticket test. */
async function openMarketViaCustomPair(page: Page, days: number): Promise<void> {
  await page.goto('/desk', { waitUntil: 'domcontentloaded' });
  await chooseMenuValue(page, 'desk-pair', '__custom__');
  await page.locator('#desk-custom-lend').fill(WETH);
  await page.locator('#desk-custom-coll').fill(TLIQ);
  await page.getByRole('button', { name: 'Load market' }).click();
  await selectTenor(page, days);
}

/** Tenor chips are scoped to the header's "Term" group — the ticket's
 *  expiry chips reuse the '7d' label. */
async function selectTenor(page: Page, days: number): Promise<void> {
  await page
    .getByRole('group', { name: 'Term' })
    .getByRole('button', { name: `${days}d`, exact: true })
    .click();
}

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
  const ownAsk = (pct: string) =>
    page.locator('.desk-ladder-row.desk-own').filter({ hasText: pct });
  await expect(ownAsk('8%')).toBeVisible({ timeout: 30_000 });

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
  await expect(ownAsk('11%')).toBeVisible({ timeout: 30_000 });
  await expect(ownAsk('8%')).toHaveCount(0);

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
  await expect(ownAsk('11%')).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator('.desk-ladder .desk-ladder-row').filter({ hasText: '5%' }),
  ).toHaveCount(1, { timeout: 30_000 });
});
