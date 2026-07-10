/** Rate Desk phase 2 (#1130) — executed-rate chart honesty (§5.3 of
 *  ProRateTerminalDesign.md) + the History bottom tab, on the fork,
 *  per the COVERAGE.md phase-2 gap row.
 *
 *  Market choice follows spec 17 (helpers shared via lib/desk.ts):
 *  WETH / faucet tLIQ at a tenor verified fresh — here fresh means no
 *  live offers AND no executed fills ever (the fork inherits Base
 *  Sepolia's full loan history, and a single inherited fill in the
 *  bucket would corrupt the exact fill-count / empty-state asserts).
 *
 *  Fills are seeded by DIRECT-WRITE accepts (lib/desk.ts
 *  acceptOfferDirect — the same approve + signed-AcceptTerms +
 *  acceptOffer transactions the app sends); the guided accept UI is
 *  specs 03/04's coverage, and driving it per fill would spend the
 *  whole test budget re-proving it.
 *
 *  Canvas pixels aren't assertable — the chart's DRAWING is trusted to
 *  lightweight-charts and the §5.3 decision math to its unit tests
 *  (src/lib/rateChart.test.ts); these tests assert the DOM the honesty
 *  rules hang off (sparse note, last-fill header, empty copy, quoted-
 *  mid hint, attribution) plus the stub/worker wire shape directly.
 *
 *  Layout note: the wallet fixture's 1280px viewport sits above the
 *  1080px desktop breakpoint, so chart + ladder + ticket all render
 *  side-by-side and the mobile Book|Chart toggle is display:none —
 *  which is why spec 17's ladder asserts needed no changes for the
 *  phase-2 layout (asserted below as a cheap layout-assumption guard).
 */
import { parseEther } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { increaseTime } from '../lib/anvil';
import { WETH } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import {
  BUCKET_PREFERENCE,
  TLIQ,
  acceptOfferDirect,
  liveOfferTenors,
  openMarketViaCustomPair,
  repayLoanInFull,
  seedDeskOffer,
} from '../lib/desk';

const STUB_ORIGIN = `http://127.0.0.1:${Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788)}`;

interface CandleBucket {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  fills: number;
  principalTotal: string;
}

/** The stub's candle answer for a WETH/tLIQ tenor — also the specs'
 *  direct wire-shape probe (the app-visible half is asserted via the
 *  DOM below; a fold bug that shipped the wrong buckets would fail the
 *  positive sparse-mode asserts, so using the stub as the fresh-market
 *  probe is not circular). */
async function stubCandles(
  days: number,
  range: '7d' | '30d' | '90d' | 'all',
  interval: '1h' | '4h' | '1d' = '1d',
): Promise<CandleBucket[]> {
  const params = new URLSearchParams({
    chainId: '84532',
    lendingAsset: WETH.toLowerCase(),
    collateralAsset: TLIQ.toLowerCase(),
    durationDays: String(days),
    interval,
    range,
  });
  const res = await fetch(`${STUB_ORIGIN}/loans/rate-candles?${params}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { chainId: number; buckets: CandleBucket[] };
  expect(body.chainId).toBe(84532);
  return body.buckets;
}

async function stubHistory(
  wallet: string,
): Promise<{ loanId: number; roles: string[]; status: string }[]> {
  const res = await fetch(
    `${STUB_ORIGIN}/loans/by-participant?chainId=84532&wallet=${wallet.toLowerCase()}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    chainId: number;
    loans: { loanId: number; roles: string[]; status: string }[];
  };
  return body.loans;
}

/** A WETH/tLIQ tenor with no live offers AND no fills ever — spec 17's
 *  freshTenor covers only the offer book; the chart tests also need a
 *  fill-free candle history for the bucket. */
async function freshMarketTenor(): Promise<number> {
  const live = await liveOfferTenors();
  for (const d of BUCKET_PREFERENCE) {
    if (live.has(d)) continue;
    if ((await stubCandles(d, 'all')).length === 0) return d;
  }
  throw new Error(
    'no WETH/tLIQ tenor bucket is both offer-free and fill-free on the fork — no fresh market to test in',
  );
}

test('a zero-fill market shows the honest empty chart; seeded fills render sparse-tape mode with last-fill header, quoted-mid hint, and attribution', async ({
  launchWallet,
}) => {
  const tenor = await freshMarketTenor();
  const lender = await launchWallet('lender', { advanced: true });
  const { page } = lender;
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);
  const chartCard = page.locator('.desk-chart-card');

  // Layout-assumption guard (see the header note): desktop 3-column
  // grid at the fixture's 1280px viewport — chart card visible
  // alongside the ladder, mobile Book|Chart toggle hidden.
  await expect(chartCard).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.desk-book-col .card').first()).toBeVisible();
  await expect(page.locator('.desk-view-toggle')).toBeHidden();

  // §5.3 honesty, zero-fill side (#1139 empty-copy split): the DEFAULT
  // view is a 30d range, and under the stub the tape route
  // (/loans/recent) is deliberately unserved — the app cannot prove
  // the market never filled, so the empty copy must be RANGE-scoped
  // (copy.desk.chart.emptyRange), never a "no fills yet for this
  // market" claim it can't back. No series is drawn either way.
  await expect(
    chartCard.getByText(/No fills in this range — try a longer range\./),
  ).toBeVisible({ timeout: 30_000 });
  await expect(chartCard.locator('.desk-chart-canvas')).toHaveCount(0);
  // Switching to range=all makes the empty series the market's WHOLE
  // history — only then is the never-filled copy (copy.desk.chart.empty)
  // claimable.
  await chartCard
    .getByRole('group', { name: 'Range' })
    .getByRole('button', { name: 'all', exact: true })
    .click();
  await expect(
    chartCard.getByText(
      /No fills yet for this market — the chart draws only executed rates\./,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(chartCard.locator('.desk-chart-canvas')).toHaveCount(0);
  await expect(chartCard.locator('.desk-chart-lastfill')).toHaveText(
    'no fills yet',
  );
  // The TradingView attribution (Apache-2.0 NOTICE) is unconditional —
  // present even before any series exists.
  const attribution = chartCard.locator('.desk-chart-attribution a');
  await expect(attribution).toHaveText('Charts by TradingView');
  await expect(attribution).toHaveAttribute(
    'href',
    'https://www.tradingview.com/lightweight-charts/',
  );

  // ---- seed 3 fills (< 10 = sparse, §5.3 rule 2), one day apart so
  // they land in three distinct 1d buckets. Distinctive rates so the
  // fold's per-bucket closes are exactly checkable: 7.11 / 8.22 / 9.33.
  for (const rateBps of [711, 822, 933]) {
    const offerId = await seedDeskOffer({
      role: 'lender',
      side: 'lend',
      rateBps,
      amountWeth: '0.002',
      collateralTliq: '100',
      days: tenor,
    });
    await acceptOfferDirect('borrower', offerId);
    // > one 1d bucket width, so consecutive fills can never share a
    // bucket (the fork clock feeds both loan startAt and the stub's
    // range bound). Skipped after the last fill — the final state
    // should read "just accepted", not "a day since the last fill".
    if (rateBps !== 933) await increaseTime(86_401);
  }
  // A resting two-sided book gives the chart a QUOTED mid to overlay
  // (§5.3 rule 4) — the fills above consumed their offers, so without
  // these the ladder (and hence the overlay + its hint) would be empty.
  await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 950,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });
  await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 650,
    amountWeth: '0.002',
    collateralTliq: '100',
    days: tenor,
  });

  // ---- wire-shape probe: the stub folds exactly like the worker's
  // foldRateCandles (which is unit-tested) — three one-fill buckets,
  // ascending, closes in seed order, BigInt principal as a decimal
  // string (0.002 WETH each; loan principal is the accepted amountMax).
  const buckets = await stubCandles(tenor, 'all');
  expect(buckets.map((b) => b.close)).toEqual([711, 822, 933]);
  for (const b of buckets) {
    expect(b.fills).toBe(1);
    expect(b.open).toBe(b.close);
    expect(b.high).toBe(b.close);
    expect(b.low).toBe(b.close);
    expect(b.principalTotal).toBe(parseEther('0.002').toString());
  }
  expect([...buckets].sort((a, b) => a.t - b.t)).toEqual(buckets);

  // ---- reload the market (pair/tenor selection is component state —
  // same idiom as spec 17) and assert the sparse-mode DOM.
  await openMarketViaCustomPair(page, tenor);
  await connectWallet(page);

  // §5.3 rule 2 — the sparse-tape note names the honest fill count
  // (copy.desk.chart.sparseNote). Default view is 1d × 30d; the three
  // fills sit within ~2 fork-days, all in range. Marker source under
  // the stub (#1139): the tape route is unserved, so sparse mode
  // deterministically takes the BUCKET-marker fallback (one point per
  // bucket, ×N on collapsed buckets) — per-fill tape markers are the
  // live tier's surface; the decision math (fillPointsFromTape /
  // tapeCoversSparseFills) is pinned in src/lib/rateChart.test.ts.
  await expect(page.locator('.desk-chart-sparse-note')).toHaveText(
    /Sparse market — 3 fills in this range, drawn individually\./,
    { timeout: 30_000 },
  );
  // §5.3 rule 5 — last EXECUTED print in the header
  // (copy.desk.chart.lastFill), never a %-change ticker. 933 bps
  // formats as 9.33%; the age suffix is fork-vs-wall-clock dependent,
  // so only the rate half is pinned.
  await expect(page.locator('.desk-chart-lastfill')).toHaveText(
    /^last fill: 9\.33% · /,
  );
  // The series canvas now exists (step-line mode draws INTO it —
  // pixel-level shape is the library's job, not this spec's).
  await expect(page.locator('.desk-chart-canvas')).toBeVisible();
  // §5.3 rule 4 — the quoted-mid overlay is labelled a resting quote.
  // Own timeout: the hint hangs off the BOOK query (the ladder mid),
  // which lands independently of the candle query that gated above.
  await expect(page.locator('.desk-chart-midhint')).toHaveText(
    /quoted mid — a resting quote, not an executed rate\./,
    { timeout: 30_000 },
  );
  await expect(page.locator('.desk-chart-attribution a')).toHaveText(
    'Charts by TradingView',
  );
});

test('History tab lists all-status participation with role badges — a repaid loan stays listed', async ({
  launchWallet,
}) => {
  const tenor = await freshMarketTenor();
  const lenderAddr = accountFor('lender').address;
  const borrowerAddr = accountFor('borrower').address;

  // Two fills → two loans with the run's lender/borrower as parties.
  const loanIds: bigint[] = [];
  for (const rateBps of [505, 606]) {
    const offerId = await seedDeskOffer({
      role: 'lender',
      side: 'lend',
      rateBps,
      amountWeth: '0.002',
      collateralTliq: '100',
      days: tenor,
    });
    loanIds.push(await acceptOfferDirect('borrower', offerId));
  }
  const [loanA, loanB] = loanIds;

  // Wire-shape probe: both loans appear for BOTH wallets with the
  // correct role sides (scoped to this run's ids — the role wallets
  // accumulate loans across the suite).
  const lenderRows = await stubHistory(lenderAddr);
  const borrowerRows = await stubHistory(borrowerAddr);
  for (const id of [Number(loanA), Number(loanB)]) {
    expect(lenderRows.find((l) => l.loanId === id)?.roles).toEqual(['lender']);
    expect(borrowerRows.find((l) => l.loanId === id)?.roles).toEqual(['borrower']);
  }

  const lender = await launchWallet('lender', { advanced: true });
  const { page } = lender;
  await page.goto('/desk', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();

  // Row scoped to a loan id via its position deep link (exact name —
  // 'Loan #12' must not match 'Loan #123').
  const rowFor = (loanId: bigint) =>
    page
      .locator('.item-row')
      .filter({
        has: page.getByRole('link', { name: `Loan #${loanId}`, exact: true }),
      })
      .first();

  // Both live loans listed, with the lender role badge and an active
  // ("Due in …") status; the loan-id link targets the position page.
  for (const id of loanIds) {
    const row = rowFor(id);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText('Lender', { exact: true })).toBeVisible();
    await expect(row).toContainText(/Due in \d+ day/);
    await expect(
      row.getByRole('link', { name: `Loan #${id}`, exact: true }),
    ).toHaveAttribute('href', `/positions/${id}`);
  }

  // ---- the gap this feature closes: repay one loan fully, and the
  // History row PERSISTS (all-status participation) with its status
  // badge flipped — current-holder reads drop repaid+claimed history.
  await repayLoanInFull('borrower', loanA);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();

  const repaidRow = rowFor(loanA);
  await expect(repaidRow).toBeVisible({ timeout: 30_000 });
  await expect(repaidRow.getByText('Repaid', { exact: true })).toBeVisible();
  // Role attribution survives the terminal status.
  await expect(repaidRow.getByText('Lender', { exact: true })).toBeVisible();
  await expect(
    repaidRow.getByRole('link', { name: `Loan #${loanA}`, exact: true }),
  ).toHaveAttribute('href', `/positions/${loanA}`);
  // Control: the still-active loan keeps its live status.
  await expect(rowFor(loanB)).toContainText(/Due in \d+ day/);
});
