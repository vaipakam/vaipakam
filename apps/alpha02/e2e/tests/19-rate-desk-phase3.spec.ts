/** Rate Desk phase 3 (#1131) — crossable-band previewMatch strip (slice
 *  B) + the gasless signed-offer loop (slice D: post → discover → fill),
 *  on the fork, per the #1131 DoD and the COVERAGE.md phase-3 row.
 *
 *  Market convention follows specs 17/18 (lib/desk.ts) EXCEPT the pair:
 *  this spec trades WETH / faucet mUSDC (deployments `liquidToken2` —
 *  18 decimals, $1 USD feed, Liquid tier), at a tenor verified
 *  live-empty first, so the inherited Base Sepolia book can never pad
 *  the ladder or cross against this run's seeds. The pair is this
 *  spec's OWN on purpose: a pair has only six tenor buckets and specs
 *  17/18 (plus retries) already spend WETH/tLIQ's — test 1 below
 *  deliberately rests a crossed pair forever, which exhausted the
 *  shared pair's budget (see the bucket-budget note at
 *  lib/desk.ts#freshTenor). mUSDC's decimals/symbol are read LIVE from
 *  the fork (like the app does), never assumed; the borrower wallet
 *  self-funds via the mock's open mint (lib/seed.ts only funds tLIQ).
 *  Each test recomputes `freshTenor(WETH, MUSDC)`, so a previous
 *  test's resting seeds exclude their bucket automatically.
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
import { parseEther, parseUnits } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { consentAndWaitEnabled, newestLoanIdFor } from '../lib/flows';
import {
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  WETH,
  forkChain,
  pub,
  walletFor,
} from '../lib/chain';
import { accountFor } from '../lib/wallets';
import {
  MUSDC,
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

/** mUSDC (liquidToken2) metadata read LIVE from the fork — the same
 *  runtime `decimals()`/`symbol()` reads the app makes, so the seeded
 *  base-unit amounts and the symbol asserts can never drift from the
 *  deployed mock (it is 18-dec / "mUSDC" today, but that is a deploy
 *  detail, not a contract of this spec). Cached per worker. */
let musdcMetaCache: { decimals: number; symbol: string } | undefined;
async function musdcMeta(): Promise<{ decimals: number; symbol: string }> {
  if (!musdcMetaCache) {
    const [decimals, symbol] = await Promise.all([
      pub.readContract({ address: MUSDC, abi: ERC20_MIN_ABI, functionName: 'decimals' }),
      pub.readContract({ address: MUSDC, abi: ERC20_MIN_ABI, functionName: 'symbol' }),
    ]);
    musdcMetaCache = { decimals: Number(decimals), symbol };
  }
  return musdcMetaCache;
}

/** Fund the borrower-side wallet with mUSDC collateral via the faucet
 *  mock's open `mint(address,uint256)` — the same direct-write style as
 *  lib/seed.ts, which only funds tLIQ (the specs-17/18 pair). Only the
 *  borrower role ever escrows/locks the collateral leg here (the
 *  lender leg is always WETH), so it is the only wallet funded.
 *  Additive and idempotent-enough: each call mints a fresh 100,000. */
async function fundBorrowerMusdc(decimals: number): Promise<void> {
  const account = accountFor('borrower');
  const wallet = walletFor(account);
  const hash = await wallet.writeContract({
    address: MUSDC,
    abi: ERC20_MIN_ABI,
    functionName: 'mint',
    args: [account.address, parseUnits('100000', decimals)],
    account,
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash });
}

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
  const tenor = await freshTenor(WETH, MUSDC);
  const { decimals } = await musdcMeta();
  await fundBorrowerMusdc(decimals);
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
    collateralAsset: MUSDC,
    collateralDecimals: decimals,
  });
  const borrowerOfferId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: '0.0002',
    collateralTliq: '100',
    days: tenor,
    collateralAsset: MUSDC,
    collateralDecimals: decimals,
  });

  // The contract's own verdict FIRST, so the DOM assert below can't
  // false-pass on a differently-broken pair. MatchError.AmountNoOverlap
  // is ordinal 4 in LibOfferMatch.MatchError.
  const preview = await previewMatch(lenderOfferId, borrowerOfferId);
  expect(preview.errorCode).not.toBe(0);
  expect(preview.errorCode).toBe(4); // AmountNoOverlap — pins the seed shape

  const session = await launchWallet('newLender', { advanced: true });
  const { page } = session;
  await openMarketViaCustomPair(page, tenor, MUSDC);
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
  const tenor = await freshTenor(WETH, MUSDC);
  const { decimals } = await musdcMeta();
  await fundBorrowerMusdc(decimals);
  await assertPartialFillFlagOn();

  // A genuinely matchable pair: ask 6% floor × bid 9% ceiling at the
  // SAME single amount (borrower's 0.002 sits inside the lender's
  // [0.0002, 0.002] range). Expected midpoint: 7.5%.
  //
  // HF headroom (previewMatch's synthetic init gate, mirrored from
  // LoanFacet's HF >= 1.5 check): collateral 100 mUSDC ≈ $100 (the
  // deploy's $1 mUSDC/USD feed) vs principal 0.002 WETH ≈ $6 at the
  // deploy's ~$3,000 ETH quote. The floor is
  // principalUsd × 1.5 / tierLiquidationLtv(>= 80%) ≈ $11.25 —
  // 100 mUSDC clears it ~9×, and stays Ok for any ETH quote below
  // ~$26,600 (= 100 × 0.8 / 1.5 / 0.002). Same margin class as the
  // 100-tLIQ shape specs 17/18 use on their pair.
  const lenderOfferId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 600,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
    collateralAsset: MUSDC,
    collateralDecimals: decimals,
  });
  const borrowerOfferId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
    collateralAsset: MUSDC,
    collateralDecimals: decimals,
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
  await openMarketViaCustomPair(page, tenor, MUSDC);
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
  const tenor = await freshTenor(WETH, MUSDC);
  const { decimals, symbol } = await musdcMeta();
  // The TAKER (borrower role) posts the collateral leg at fill time —
  // fund its wallet with the pair's mUSDC.
  await fundBorrowerMusdc(decimals);
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
  await openMarketViaCustomPair(maker.page, tenor, MUSDC);
  await connectWallet(maker.page);
  const txsBefore = maker.flags.sentTransactions;

  await maker.page.getByRole('button', { name: 'Lend', exact: true }).click();
  await maker.page.locator('#desk-amount').fill('0.002');
  await maker.page.locator('#desk-rate').fill('7.77');
  await maker.page.locator('#desk-collateral-amount').fill('100');
  // GTC on purpose: the gasless GTC policy stamps a 7-day signature
  // deadline anchored to LIVE chain time (#1145 round-2 — never the
  // device clock), so it stays live across the suite's fork time
  // travel (~2 days) by construction; the GTT presets resolve from
  // wall time and WOULD lapse against the travelled chain clock.
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
  // #1145 round-2 — gasless LENDER posts are single-fill only: a signed
  // lender order can't be sliced (the matcher's constant
  // collateral:principal ratio is unsatisfiable with the lender's
  // single-value collateral), so the ticket auto-switches the default
  // Partial to AON, disables the Partial chip, and says why.
  const fillGroup = maker.page.getByRole('group', { name: 'Fill mode' });
  await expect(
    fillGroup.getByRole('button', { name: 'AON', exact: true }),
  ).toHaveClass(/active/);
  await expect(
    fillGroup.getByRole('button', { name: 'Partial', exact: true }),
  ).toBeDisabled();
  await expect(
    maker.page.getByText(/Gasless lend orders fill only as one whole loan/),
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
  const book = await fetchSignedBook(WETH, MUSDC, tenor);
  expect(book).toHaveLength(1);
  const row = book[0];
  expect(row.signer).toBe(makerAddr.toLowerCase());
  expect(row.order.offerType).toBe('0');
  // The custom-pair load drove the signed order's collateral leg. A
  // lender payload ships single-value collateral (the offerSchema /
  // LenderCollateralRangeNotAllowed invariant), so the pin binds both
  // fields to the same figure the fill confirm displays.
  expect(row.order.collateralAsset).toBe(MUSDC.toLowerCase());
  expect(row.order.collateralAmount).toBe(parseUnits('100', decimals).toString());
  expect(row.order.collateralAmountMax).toBe(row.order.collateralAmount);
  expect(row.order.interestRateBps).toBe('777');
  expect(row.order.amountMax).toBe(parseEther('0.002').toString());
  // #1145 round-2 — the SIGNED wire order is the collapsed single-value
  // AON shape (`amount == amountMax`, fillMode 1): with the lender's
  // single-value collateral, the matcher's constant-ratio gate
  // (`collateralAmount × ceiling == collateralAmountMax × amount`)
  // admits ONLY this shape — a ranged lender order would rest as
  // unmatchable partial depth. This also keeps the indexer's static
  // AON invariant (`fillMode 1 ⇒ amount == amountMax`) satisfied.
  expect(row.order.amount).toBe(row.order.amountMax);
  expect(row.order.fillMode).toBe('1');
  expect(row.order.durationDays).toBe(String(tenor));
  expect(row.order.expiresAt).toBe('0'); // GTC
  // Bounded 7d signature deadline, anchored to chain time (#1145 r2):
  // never the contract's unbounded `deadline = 0`.
  expect(row.order.deadline).not.toBe('0');
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
  await openMarketViaCustomPair(taker.page, tenor, MUSDC);
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
  // The symbol is the LIVE on-chain read (never a hard-coded ticker),
  // and "100" holds whatever the mock's decimals are — the seeded
  // base-unit amount used the same runtime `decimals()`.
  await expect(confirm).toContainText(
    `You lock 100 ${symbol} as collateral and receive the loan principal.`,
    { timeout: 30_000 },
  );
  const baseline = await newestBorrowerLoanOrZero(borrowerAddr);
  await confirm.locator('input[type="checkbox"]').check();
  const fill = confirm.getByRole('button', { name: 'Fill order', exact: true });
  await expect(fill).toBeEnabled({ timeout: 30_000 });
  await fill.click();
  // The transient success copy is deliberately NOT the primary assert
  // (same posture as the MatchBand's executed note): the fill's
  // invalidation refetches the signed book, the stub GET drops the
  // consumed row, and RateLadder's stale-target clear (#1145 round-1
  // P2) then auto-closes the confirm — the text lives only for the
  // refetch round-trip. The ON-CHAIN loan poll below is the success
  // criterion; here we only require that the confirm either shows the
  // success copy or has already auto-closed (never an error state).
  await expect
    .poll(
      async () =>
        (await confirm
          .getByText('Signed order filled — the loan is live.')
          .isVisible()
          .catch(() => false)) || (await confirm.count()) === 0,
      { timeout: 120_000 },
    )
    .toBe(true);

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
  expect(await fetchSignedBook(WETH, MUSDC, tenor)).toHaveLength(0);
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
