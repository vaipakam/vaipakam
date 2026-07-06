/** #1029 — the shared book's on-chain catch-up merge, on Anvil.
 *
 *  The always-live stub can't lag the chain, so this spec uses its
 *  PIN mode (`POST /__pin`) to freeze /offers/active and the
 *  freshness cursor at "now" while the fork advances — real ingest
 *  lag, manufactured honestly. Then: an offer that terminates ON
 *  CHAIN after the pin must vanish from the rendered book even
 *  though the frozen cache still serves it, because the app's
 *  chunkedGetLogs scan over [pinnedBlock+1, head] decodes the
 *  terminal event and strips the row.
 *
 *  This is also the regression guard for the hardcoded-signature bug
 *  the port fixed: with a stale OfferCanceled/OfferClosed topic0 the
 *  scan matches nothing and the ghost row stays — this spec fails.
 *  The topic table is additionally drift-checked below by deriving
 *  every terminal selector from the compiled ABI on the node side.
 */
import { toEventSelector } from 'viem';
import type { Abi, AbiEvent } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, newestOfferIdFor } from '../lib/flows';
import { increaseTime, mine } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

const STUB = `http://127.0.0.1:${Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788)}`;

async function stubServesOffer(offerId: bigint): Promise<boolean> {
  const res = await fetch(`${STUB}/offers/active?chainId=84532`);
  const body = (await res.json()) as { offers: Array<{ offerId: number }> };
  return body.offers.some((o) => o.offerId === Number(offerId));
}

test('every terminal event the catch-up scans still exists in the ABI', () => {
  // The scan's topic table derives from DIAMOND_ABI_VIEM at runtime
  // (never hand-written signatures — defi's original hardcoded
  // strings silently stopped matching when events grew fields). A
  // rename/removal must fail HERE, not fail-open in production.
  for (const name of [
    'OfferAccepted',
    'OfferCanceled',
    'OfferClosed',
    'OfferConsumedBySale',
  ]) {
    // Type-aware find, mirroring bookCatchUp.eventTopic0 — getAbiItem
    // by name can return a same-named custom ERROR
    // (OfferConsumedBySale is both; the first CI run caught it).
    const item = (DIAMOND_ABI_VIEM as Abi).find(
      (i): i is AbiEvent => i.type === 'event' && i.name === name,
    );
    expect(item, `event ${name} missing from DIAMOND_ABI_VIEM`).toBeTruthy();
    expect(toEventSelector(item!)).toMatch(/^0x[0-9a-f]{64}$/);
  }
});

test('a just-cancelled offer vanishes from the book while the cache still serves it', async ({
  launchWallet,
}) => {
  // Two roles on purpose: the LENDER posts and cancels; the BORROWER
  // watches the book. The ghost-row danger is for OTHER users — and
  // the book only renders an accept LINK (the row identity this spec
  // keys on) for offers that aren't the viewer's own (the first CI
  // run failed on exactly that as the lender).
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  // Past the cancel cooldown BEFORE pinning, so the cancel lands in
  // the post-pin window.
  await increaseTime(301);

  const pinRes = await fetch(`${STUB}/__pin`, { method: 'POST' });
  expect(pinRes.ok).toBe(true);
  try {
    // The frozen cache lists the offer…
    expect(await stubServesOffer(offerId)).toBe(true);

    // …and with an empty post-pin window, the borrower's rendered
    // book shows it (positive control: the row's presence proves the
    // catch-up layer doesn't over-filter).
    const borrower = await launchWallet('borrower');
    await borrower.page.goto('/offers', { waitUntil: 'domcontentloaded' });
    const bookRow = borrower.page.locator(`a[href*="offer=${offerId}&"]`);
    await expect(bookRow.first()).toBeVisible({ timeout: 30_000 });

    // Cancel ON CHAIN (the proven /positions UI path from spec 05).
    await lender.page.goto('/positions', { waitUntil: 'domcontentloaded' });
    const row = lender.page
      .locator('.row-list > div')
      .filter({ has: lender.page.getByText(`Offer #${offerId} ·`) })
      .first();
    await row.getByRole('button', { name: /cancel offer/i }).click();
    await row.getByRole('button', { name: /confirm.*cancel/i }).click();
    await expect
      .poll(
        async () => {
          const o = (await pub.readContract({
            address: DIAMOND,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getOffer',
            args: [offerId],
          })) as { creator: string };
          return /^0x0{40}$/i.test(o.creator);
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // Let the cancel block clear the scan's reorg-settling buffer
    // (toBlock = latest − CONFIRMATION_BUFFER).
    await mine(4);

    // The frozen cache STILL serves the ghost row…
    expect(await stubServesOffer(offerId)).toBe(true);

    // …but the borrower's rendered book must not: the catch-up scan
    // over the post-pin tail decodes the terminal event and strips
    // it. A full page load guarantees a fresh query (no SPA cache
    // carry-over).
    await borrower.page.goto('/offers', { waitUntil: 'domcontentloaded' });
    // Wait for a POSITIVELY loaded book first — some rendered row
    // (the pinned snapshot carries the fork's inherited open book, so
    // rows always exist) — because waiting for the loading text to be
    // ABSENT would pass trivially before React even mounts, letting
    // the absence assert below false-pass.
    await expect(borrower.page.locator('.item-row').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      borrower.page.getByText('We couldn’t load the offer book right now', {
        exact: false,
      }),
    ).toHaveCount(0);
    // …and the terminated offer is gone.
    await expect(bookRow).toHaveCount(0);
  } finally {
    await fetch(`${STUB}/__unpin`, { method: 'POST' });
  }
});
