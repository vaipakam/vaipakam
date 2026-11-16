/**
 * Why an offer is not matching (#3623, matrix OFF-41 and OFF-46, RB-WHY-MATCH). A
 * lender's own open offer page names the closest open request on the other
 * side of the pair (ranked by the index stand-in as the indexer ranks it)
 * and states the protocol's own reason the two do not match, with both
 * rates; a request whose rates meet is reported as one the protocol would
 * match now, at the middle of where the ranges meet; an empty other side
 * says so; and with the index down the section says the closest offers are
 * unknown instead of claiming there are none. The Offers list links an open
 * own offer to its page. Nothing is sent. Runs on the desktop and the phone
 * project; the chain is reverted after each test.
 */
import { postBorrowRequest, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openOwn(page: Page, id: bigint): Promise<void> {
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
}

test('names the closest request’s rate gap, and a request whose rates meet as one the protocol would match now', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  // The lender asks 7%; the request pays 4.5% to 5.5%: the rates do not meet.
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 700, days: 14 });
  const far = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 450, rateMaxBps: 550, days: 14 });

  const { page, flags } = await launchWallet('lender');
  await page.goto('/offers');
  await connectWallet(page);
  await expect(page.getByTestId(`offer-why-${ask}`)).toHaveText('Why isn’t it matching?', { timeout: 60_000 });
  await page.getByTestId(`offer-why-${ask}`).click();
  await expect(page).toHaveURL(new RegExp(`/offers/${ask}$`));

  const why = page.getByTestId('why-match');
  const verdict = why.getByTestId('why-match-verdict');
  await expect(verdict).toHaveAttribute('data-why', 'gap', { timeout: 60_000 });
  await expect(verdict).toHaveText('The closest request pays at most 5.5% a year; you ask at least 7%.');
  await expect(why.getByTestId('why-match-standing')).toHaveText('Open offers on the other side of this pair: 1.');
  await why.getByTestId('why-match-closest').locator('summary').click();
  await expect(why.getByTestId(`why-match-row-${far}`)).toContainText('their rates do not overlap.');
  await expect(why.getByTestId('why-match-change-rate')).toHaveText('Change my lowest rate to 5.5%');
  await fitsWidth(page);

  // A second request whose range reaches 7%: the protocol would match it.
  const near = await postBorrowRequest(scenario({ borrower: 'freshBorrower' }), {
    borrower: 'borrower',
    principalWeth: '0.05',
    collateralTliq: '250',
    rateBps: 650,
    rateMaxBps: 750,
    days: 14,
  });
  await page.reload();
  await connectWallet(page);
  await expect(verdict).toHaveAttribute('data-why', 'matchable', { timeout: 60_000 });
  await expect(verdict).toHaveText(`The protocol would match this with offer #${near} now, at 7% a year. Anyone may send that match; nobody has yet.`);
  await expect(why.getByTestId('why-match-standing')).toHaveText('Open offers on the other side of this pair: 2.');
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);
});

test('says so when nothing stands on the other side, and when the index is down', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.03', collateralTliq: '150', rateBps: 500, days: 10 });

  const { page } = await launchWallet('lender');
  await openOwn(page, ask);
  const verdict = page.getByTestId('why-match-verdict');
  await expect(verdict).toHaveAttribute('data-why', 'none', { timeout: 60_000 });
  await expect(verdict).toHaveText('No open offer stands on the other side of this pair yet.');
  await fitsWidth(page);

  await setIndexPosture('down');
  try {
    await page.reload();
    await connectWallet(page);
    await expect(page.getByTestId('why-match-index-failed')).toContainText('The offer index did not answer, so the closest offers are unknown', { timeout: 60_000 });
    await expect(page.getByTestId('why-match-verdict')).toHaveCount(0);
  } finally {
    await setIndexPosture('live');
  }
});
