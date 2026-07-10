/** Rate Desk phase 3 (#1131) — crossable-band previewMatch strip (slice
 *  B) + the gasless signed-offer loop (slice D: post → discover → fill),
 *  on the fork, per the #1131 DoD and the COVERAGE.md phase-3 row.
 *
 *  Market convention follows specs 17/18 (lib/desk.ts): WETH / faucet
 *  tLIQ at a tenor verified live-empty first, so the inherited Base
 *  Sepolia book can never pad the ladder or cross against this run's
 *  seeds. Each test recomputes `freshTenor()`, so a previous test's
 *  resting seeds exclude their bucket automatically.
 *
 *  §5.2 honesty doctrine (ProRateTerminalDesign.md) is the spine here:
 *  bid >= ask alone is NOT matchable — the band may render ONLY when
 *  the contract's own `previewMatch` returns Ok. Both directions are
 *  asserted: a crossed-but-unmatchable book (amount ranges that cannot
 *  overlap) shows NO band, and a contract-confirmed Ok pair shows the
 *  band whose Execute initiates a real loan for the two makers.
 *
 *  The gasless loop runs against the stub's new /signed-offers routes
 *  (POST verifies the EIP-712 signature against the fork Diamond's
 *  domain exactly like the worker; GET live-probes the on-chain fill
 *  ledger as its fork-scale lifecycle substitute) — so the loop is the
 *  REAL protocol end-to-end: one wallet signature, an off-chain book
 *  row, and a taker fill that settles on-chain via acceptSignedOffer.
 *
 *  Push invalidation (slice A's KEY_MAP) is NOT fork-assertable: the
 *  stub is a plain HTTP server with no WebSocket rail (the same no-WS
 *  posture spec 15 pins for the chain side), so the desk's push roots
 *  are pinned by the vitest unit test (src/chain/pushKeyMap.test.ts)
 *  and the live half rides the production WS rail per COVERAGE.md.
 */
import { parseEther } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { consentAndWaitEnabled, newestLoanIdFor } from '../lib/flows';
import { DIAMOND, DIAMOND_ABI_VIEM, WETH, pub } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import {
  TLIQ,
  freshTenor,
  openMarketViaCustomPair,
  seedDeskOffer,
} from '../lib/desk';
import {
  fetchSignedBook,
  fundVaultFreeBalance,
  signedFilledAmount,
  signedOrderHashOnChain,
} from '../lib/signed';

/** `OfferMatchFacet.previewMatch(L, B)` — the contract's own verdict
 *  the band must obey (§5.2). */
async function previewMatch(
  lenderOfferId: bigint,
  borrowerOfferId: bigint,
): Promise<{ errorCode: number; matchAmount: bigint; matchRateBps: bigint }> {
  return (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'previewMatch',
    args: [lenderOfferId, borrowerOfferId],
  })) as { errorCode: number; matchAmount: bigint; matchRateBps: bigint };
}

/** The band renders only under `getMasterFlags().partialFill` — the
 *  governance kill switch DeployDiamond flips ON everywhere (§5.2).
 *  Asserted as a named precondition so a flags regression on the fork
 *  fails diagnosably instead of as a silent missing band. */
async function assertPartialFillFlagOn(): Promise<void> {
  const [, , partialFill] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getMasterFlags',
  })) as readonly [boolean, boolean, boolean];
  expect(partialFill, 'partialFill master flag expected ON (deploy default)').toBe(
    true,
  );
}

/** Newest borrower-side loan id, or 0n when the wallet has none yet —
 *  the "did a NEW loan appear" baseline (roles accumulate loans across
 *  the suite, so specs assert on the delta, never on absolutes). */
async function newestBorrowerLoanOrZero(who: `0x${string}`): Promise<bigint> {
  try {
    return await newestLoanIdFor(who, 'borrower');
  } catch {
    return 0n;
  }
}

test('§5.2 honesty inverse: a crossed-but-unmatchable book renders NO match band', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor();
  await assertPartialFillFlagOn();

  // Crossed on RATE (ask 6% floor < bid 9% ceiling) but with amount
  // ranges that cannot overlap: the lender's minimum slice is 10% of
  // 0.004 = 0.0004 WETH (seedDeskOffer's min-partial default), while
  // the borrower asks a single-value 0.0002 WETH — [maxMin, minMax] is
  // empty, so previewMatch reports AmountNoOverlap, never Ok.
  const lenderOfferId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 600,
    amountWeth: '0.004',
    collateralTliq: '100',
    days: tenor,
  });
  const borrowerOfferId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: '0.0002',
    collateralTliq: '100',
    days: tenor,
  });

  // The contract's own verdict FIRST, so the DOM assert below can't
  // false-pass on a differently-broken pair. MatchError.AmountNoOverlap
  // is ordinal 4 in LibOfferMatch.MatchError.
  const preview = await previewMatch(lenderOfferId, borrowerOfferId);
  expect(preview.errorCode).not.toBe(0);
  expect(preview.errorCode).toBe(4); // AmountNoOverlap — pins the seed shape

  const session = await launchWallet('newLender', { advanced: true });
  const { page } = session;
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);

  // The book IS crossed — the mid row says so (a crossed resting book
  // is a normal state here, unlike a CEX)...
  const ladder = page.locator('.desk-ladder');
  await expect(ladder.locator('.desk-ladder-row')).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator('.desk-mid-row')).toContainText('crossed');
  // ...but NO band: previewMatch said not-Ok, and §5.2 forbids showing
  // a band the contract would refuse. Settle past the preview query's
  // landing (it runs alongside the book query that rendered above) so
  // the zero-count can't pass merely because the strip hasn't loaded.
  await page.waitForTimeout(3_000);
  await expect(page.locator('.desk-match-band')).toHaveCount(0);
});

test('contract-confirmed crossable band: previewMatch Ok renders the band, a third wallet executes the match, the loan initiates on-chain and the ladder depth clears', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor();
  await assertPartialFillFlagOn();

  // A genuinely matchable pair: ask 6% floor × bid 9% ceiling at the
  // SAME single amount (borrower's 0.002 sits inside the lender's
  // [0.0002, 0.002] range) with the collateral shape spec 18's accepts
  // already prove passes the HF/LTV gate. Expected midpoint: 7.5%.
  const lenderOfferId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 600,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });
  const borrowerOfferId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });

  // The contract confirms Ok BEFORE any DOM assert — if this fails the
  // seed shape regressed, not the band.
  const preview = await previewMatch(lenderOfferId, borrowerOfferId);
  expect(preview.errorCode).toBe(0);
  expect(Number(preview.matchRateBps)).toBe(750); // midpoint of 600/900
  expect(preview.matchAmount).toBe(parseEther('0.002'));

  // Execution is PERMISSIONLESS — a THIRD wallet (neither maker) runs
  // it and earns the matcher kickback; it needs only gas.
  const matcher = await launchWallet('newLender', { advanced: true });
  const { page } = matcher;
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);

  const band = page.locator('.desk-match-band');
  await expect(band).toBeVisible({ timeout: 30_000 });
  await expect(band).toContainText('Matchable at 7.5%');
  await expect(band).toContainText(
    'These top-of-book offers can cross. Anyone can execute this match and earn the matcher fee.',
  );
  // Amount line renders once the lending asset's decimals resolve.
  await expect(band).toContainText(/0\.002 \S* ?would match\./);

  const borrowerAddr = accountFor('borrower').address;
  const baseline = await newestBorrowerLoanOrZero(borrowerAddr);

  await band.getByRole('button', { name: 'Execute match' }).click();

  // The DETERMINISTIC outcome is on-chain: a new loan for the two
  // MAKERS (the matcher is party to nothing). The band's transient
  // "Match executed" note is deliberately not asserted — the book
  // invalidation that follows the write unmounts the strip within one
  // refetch round-trip on the fork, faster than a stable assert.
  await expect
    .poll(async () => Number(await newestBorrowerLoanOrZero(borrowerAddr)), {
      timeout: 90_000,
    })
    .toBeGreaterThan(Number(baseline));
  const loanId = await newestLoanIdFor(borrowerAddr, 'borrower');
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    lender: string;
    borrower: string;
    principal: bigint;
    interestRateBps: bigint;
    durationDays: bigint;
    status: number;
  };
  expect(loan.lender.toLowerCase()).toBe(accountFor('lender').address.toLowerCase());
  expect(loan.borrower.toLowerCase()).toBe(borrowerAddr.toLowerCase());
  expect(loan.principal).toBe(parseEther('0.002'));
  expect(Number(loan.interestRateBps)).toBe(750); // the midpoint rate
  expect(Number(loan.durationDays)).toBe(tenor);
  expect(Number(loan.status)).toBe(0); // LoanStatus.Active

  // Ladder depth reduced: the match consumed BOTH offers in full, so
  // the book empties (honest empty copy, not a blank) and the band
  // leaves with it.
  await expect(
    page.getByText(/no open offers for this market yet/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.desk-match-band')).toHaveCount(0);
});

test('gasless loop: maker posts a signed order with ONE signature (no transaction), the book discovers it, a taker fills it on-chain, and the row leaves the book', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor();
  const makerAddr = accountFor('lender').address;
  const borrowerAddr = accountFor('borrower').address;

  // Vault-backed signed offers move the MAKER leg from vault FREE
  // balance at fill (nothing escrows at signing) — pre-fund it so the
  // fill exercises the happy path (the not-funded WARN branch is
  // pinned by the ticket's copy + the confirm's preflight in unit/live
  // coverage, not here).
  await fundVaultFreeBalance('lender', WETH, parseEther('0.002'));

  // ---- maker: sign & post from the ticket -------------------------
  const maker = await launchWallet('lender', { advanced: true });
  await openMarketViaCustomPair(maker.page, tenor);
  await connectWallet(maker.page);
  const txsBefore = maker.flags.sentTransactions;

  await maker.page.getByRole('button', { name: 'Lend', exact: true }).click();
  await maker.page.locator('#desk-amount').fill('0.002');
  await maker.page.locator('#desk-rate').fill('7.77');
  await maker.page.locator('#desk-collateral-amount').fill('100');
  // GTC on purpose: the gasless GTC policy stamps a 7-day signature
  // deadline from wall time, which stays live across the suite's fork
  // time travel (~2 days); the GTT presets also resolve from wall time
  // and WOULD lapse against the travelled chain clock.
  await maker.page
    .getByRole('group', { name: 'Expiry' })
    .getByRole('button', { name: 'GTC', exact: true })
    .click();
  await maker.page
    .getByRole('group', { name: 'Posting' })
    .getByRole('button', { name: 'Gasless (sign only)', exact: true })
    .click();
  // The escrow-reality hint must accompany the mode switch.
  await expect(
    maker.page.getByText(/Nothing is escrowed when you sign/),
  ).toBeVisible();

  const post = maker.page.getByRole('button', {
    name: 'Sign & post to the book',
  });
  await consentAndWaitEnabled(maker.page, post);
  await post.click();
  await expect(
    maker.page.getByText(
      /Signed order posted to the book — no gas spent\. It fills when a taker accepts it\./,
    ),
  ).toBeVisible({ timeout: 60_000 });
  // Vault was pre-funded to exactly the commitment — no funds warning.
  await expect(maker.page.getByText(/vault’s free balance is below/)).toHaveCount(0);
  // THE gasless property: posting sent ZERO transactions (the wallet
  // fixture counts eth_sendTransaction attempts at the provider
  // boundary — one signature, nothing mined, no gas).
  expect(maker.flags.sentTransactions).toBe(txsBefore);

  // ---- the stub's book holds the order, wire-shape + hash pinned ----
  const book = await fetchSignedBook(WETH, TLIQ, tenor);
  expect(book).toHaveLength(1);
  const row = book[0];
  expect(row.signer).toBe(makerAddr.toLowerCase());
  expect(row.order.offerType).toBe('0');
  expect(row.order.interestRateBps).toBe('777');
  expect(row.order.amountMax).toBe(parseEther('0.002').toString());
  expect(row.order.durationDays).toBe(String(tenor));
  expect(row.order.expiresAt).toBe('0'); // GTC
  expect(row.order.deadline).not.toBe('0'); // bounded 7d signature deadline
  expect(row.status).toBe('active');
  // The stub/app hash must agree with the CONTRACT's own hashStruct —
  // the ledger key every consumer (fill, cancel, D1) binds on.
  expect(await signedOrderHashOnChain(row.order)).toBe(row.orderHash);
  expect(await signedFilledAmount(row.orderHash)).toBe(0n);

  // ---- maker's own view: Signed row on the ladder + Open orders ----
  // The post invalidated the signed-book query, so the row lands
  // without a reload. Own signed rows arm NO Fill affordance (a maker
  // can't fill their own order).
  const makerRow = maker.page
    .locator('.desk-ladder-row')
    .filter({ hasText: '7.77%' });
  await expect(makerRow).toHaveCount(1, { timeout: 30_000 });
  await expect(makerRow.locator('.desk-signed-chip')).toHaveText('Signed');
  await expect(makerRow).toHaveClass(/desk-own/);
  await expect(makerRow.getByRole('button', { name: 'Fill', exact: true })).toHaveCount(0);
  // Open orders (the default bottom tab): the market-scoped own-signed
  // block with the on-chain cancel affordance (asserted armed, not
  // driven — cancelling would kill the fill half of this loop; the
  // cancel path is the live driver's follow-up per COVERAGE.md).
  await expect(
    maker.page.getByText('Signed orders (this market)'),
  ).toBeVisible({ timeout: 30_000 });
  const signedBlockRow = maker.page
    .locator('.item-row')
    .filter({ hasText: '7.77%' });
  await expect(signedBlockRow).toBeVisible();
  await expect(
    signedBlockRow.getByRole('button', { name: 'Cancel on-chain' }),
  ).toBeVisible();

  // ---- taker: discover on the ladder, fill via the inline confirm ---
  const taker = await launchWallet('borrower', { advanced: true });
  await openMarketViaCustomPair(taker.page, tenor);
  await connectWallet(taker.page);

  const takerRow = taker.page
    .locator('.desk-ladder-row')
    .filter({ hasText: '7.77%' });
  await expect(takerRow).toHaveCount(1, { timeout: 30_000 });
  await expect(takerRow.locator('.desk-signed-chip')).toHaveText('Signed');
  await expect(takerRow).not.toHaveClass(/desk-own/);
  await takerRow.getByRole('button', { name: 'Fill', exact: true }).click();

  const confirm = taker.page.locator('.desk-signed-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Fill signed order');
  // Filling a signed LENDER order: the taker posts the collateral leg.
  await expect(confirm).toContainText(
    /You lock 100 \S* ?as collateral and receive the loan principal\./,
    { timeout: 30_000 },
  );
  const baseline = await newestBorrowerLoanOrZero(borrowerAddr);
  await confirm.locator('input[type="checkbox"]').check();
  const fill = confirm.getByRole('button', { name: 'Fill order', exact: true });
  await expect(fill).toBeEnabled({ timeout: 30_000 });
  await fill.click();
  await expect(
    confirm.getByText('Signed order filled — the loan is live.'),
  ).toBeVisible({ timeout: 120_000 });

  // ---- on-chain: the loan carries the SIGNED terms exactly ----------
  await expect
    .poll(async () => Number(await newestBorrowerLoanOrZero(borrowerAddr)), {
      timeout: 30_000,
    })
    .toBeGreaterThan(Number(baseline));
  const loanId = await newestLoanIdFor(borrowerAddr, 'borrower');
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    lender: string;
    borrower: string;
    principal: bigint;
    collateralAmount: bigint;
    interestRateBps: bigint;
    durationDays: bigint;
    status: number;
  };
  expect(loan.lender.toLowerCase()).toBe(makerAddr.toLowerCase());
  expect(loan.borrower.toLowerCase()).toBe(borrowerAddr.toLowerCase());
  expect(loan.principal).toBe(parseEther('0.002')); // the signed amountMax
  expect(Number(loan.interestRateBps)).toBe(777); // the signed floor rate
  expect(Number(loan.durationDays)).toBe(tenor);
  expect(Number(loan.status)).toBe(0); // Active
  // The on-chain fill ledger marks the order consumed at its ceiling.
  expect(await signedFilledAmount(row.orderHash)).toBe(parseEther('0.002'));

  // ---- lifecycle: the consumed row leaves the book everywhere -------
  // Stub GET live-probes the fill ledger and drops the row (the
  // fork-scale substitute for the worker's event-driven lifecycle).
  expect(await fetchSignedBook(WETH, TLIQ, tenor)).toHaveLength(0);
  // Taker's ladder: the fill's invalidations refetch the signed book;
  // with the only row consumed the market reads honestly empty.
  await expect(
    taker.page.getByText(/no open offers for this market yet/i),
  ).toBeVisible({ timeout: 30_000 });

  // ---- History reflects the new participation ----------------------
  await taker.page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(
    taker.page.getByRole('link', { name: `Loan #${loanId}`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
});
