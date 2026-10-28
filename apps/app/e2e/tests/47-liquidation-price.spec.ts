/** #2531 — the loan page states the collateral price at which the health
 *  factor reaches 1.00, next to the health factor (advanced mode).
 *
 *  The figure is DERIVED in the app (collateral price ÷ health factor, read
 *  in one aggregate), so the regression this guards is a wrong number, not
 *  only a missing row. The spec re-derives the same figure from the chain's
 *  own answers and requires the page to agree within a small band: the
 *  page's read and this one are a few blocks apart and interest accrues in
 *  between, which moves the line up by a hair, never by a percent.
 *
 *  It also pins the unit: the numeraire symbol the chain reports, decoded the
 *  way the protocol reads it (the empty word is its USD default).
 */
import { hexToString, type Hex } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI } from '../lib/chain';

const WAD = 10n ** 18n;

test('the loan page states the liquidation price the chain implies', async ({ launchWallet }) => {
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 900,
    amountWeth: '0.02',
    collateralTliq: '150',
    days: 30,
  });
  const loanId = await acceptOfferDirect('borrower', offerId);

  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { collateralAsset: `0x${string}`; status: number | bigint };
  expect(Number(loan.status), 'loan should open Active').toBe(0);
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: loan.collateralAsset, abi: ERC20_MIN_ABI, functionName: 'decimals' }),
    pub.readContract({ address: loan.collateralAsset, abi: ERC20_MIN_ABI, functionName: 'symbol' }),
  ]);

  // The chain's own two answers, and the line they imply.
  const [hf, unitValue, numeraireWord] = await Promise.all([
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'calculateHealthFactor',
      args: [loanId],
    }) as Promise<bigint>,
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getNumeraireValue',
      args: [loan.collateralAsset, 10n ** BigInt(Number(decimals)), false],
    }) as Promise<bigint>,
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getNumeraireSymbol',
    }) as Promise<Hex>,
  ]);
  // Precondition: a priced, healthy loan, so the row must carry a figure.
  expect(hf, 'seeded loan must be priced and above the line').toBeGreaterThan(WAD);
  expect(unitValue, 'collateral must have a price').toBeGreaterThan(0n);
  const expected = Number((unitValue * WAD) / hf) / 1e18;
  const unit = /^0x0{64}$/.test(numeraireWord)
    ? 'USD'
    : hexToString(numeraireWord, { size: 32 }).toUpperCase();

  const borrower = await launchWallet('borrower', { advanced: true });
  const { page } = borrower;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });

  const row = page.getByTestId('position-liquidation-price');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(new RegExp(`About [\\d.,]+ ${unit} per ${symbol}\\.`), {
    timeout: 60_000,
  });
  const text = (await row.textContent()) ?? '';
  const shown = Number(/About ([\d.,]+)/.exec(text)![1].replace(/,/g, ''));
  expect(shown, 'never a zero price').toBeGreaterThan(0);
  // Within half a percent of the chain's line, and never meaningfully below
  // it: the page rounds UP so a borrower is not told they have more room.
  expect(Math.abs(shown - expected) / expected).toBeLessThan(0.005);
  // What the figure assumes is said beside it.
  await expect(row).toContainText(/amount owed where they are now/i);

  await borrower.ctx.close();
});
