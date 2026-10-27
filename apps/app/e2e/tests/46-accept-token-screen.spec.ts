/** #2726 / #2934 — every accept runs the token screen, signed-offer fills
 *  included, on Anvil.
 *
 *  Before #2726 the Rate Desk's signed-fill card ran no token screen at all,
 *  so a maker could post a signed order on a honeypot and the card presented
 *  it like any other. The screen is now one shared module: the card shows the
 *  verdicts (`useTokenScreen` + `TokenScreenBanner`) and the signed-fill
 *  signer re-screens live before the wallet prompt (`assertTokenScreenLive`).
 *  Its rules are unit-tested in `src/contracts/acceptTokenScreen.test.ts`;
 *  what a unit test cannot show is the card wiring them: the banner, the
 *  held button, consent voided when the verdict changes, and the signer
 *  refusing BEFORE the wallet is asked.
 *
 *  GoPlus does not index test networks, so the card is driven on the
 *  GoPlus-screened dev server (`lib/goplus.ts`) with the GoPlus origin
 *  route-mocked per page. The maker posts on the suite's own server
 *  (unscreened chain), exactly as spec 19 does; only the taker's view is
 *  screened. The order is WETH lent against mUSDC collateral; WETH is
 *  curated (never screened), so the screened leg is the collateral.
 *
 *  Asserted, against ONE signed order:
 *  1. BLOCK: the card names the finding, and the Fill button stays disabled
 *     with consent ticked.
 *  2. OUTAGE: a check that cannot run holds the button and offers "Check
 *     again"; once the check answers clean, consent given while it was held
 *     is void, and a fresh tick enables Fill.
 *  3. CHANGED WARNING: consent given against warning A, then the screen
 *     reports warning B. Fill refuses before any wallet prompt (no
 *     AcceptTerms request, no transaction), the card now shows B and the
 *     consent is cleared. Consent against B fills the order on-chain.
 */
import { parseEther, parseUnits } from 'viem';
import type { Locator, Page } from '@playwright/test';
import { test, expect, connectWallet, type WalletSession } from '../lib/wallet-fixture';
import { consentAndWaitEnabled } from '../lib/flows';
import { ERC20_MIN_ABI, WETH, forkChain, pub, walletFor, confirm } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { MUSDC, freshTenor, openMarketViaCustomPair } from '../lib/desk';
import { fetchSignedBook, fundVaultFreeBalance, signedFilledAmount } from '../lib/signed';
import {
  goPlusRow,
  mockGoPlus,
  startGoPlusServer,
  type GoPlusAnswer,
  type GoPlusServer,
} from '../lib/goplus';
import { copySource as copy } from '../../src/content/copy';

const SCREEN_PORT = 4178;
/** A rate no other row in this fresh market carries, so the ladder row is
 *  found by its text. */
const RATE = '6.61';

let screened: GoPlusServer | undefined;

test.beforeAll(async () => {
  screened = await startGoPlusServer(SCREEN_PORT);
});

test.afterAll(() => {
  screened?.stop();
});

const LEG = copy.offerFlow.securityLegCollateral;
const HONEYPOT = 'flagged as a honeypot — buyers cannot sell it';
const WARN_A = 'the owner can change the trading tax at any time';
const WARN_B = 'the contract has a hidden owner — privileged control is obscured';

/** Mint mUSDC to the taker (the borrower role posts the collateral leg
 *  when it fills a signed LENDER order). */
async function fundTakerMusdc(): Promise<void> {
  const decimals = Number(
    await pub.readContract({ address: MUSDC, abi: ERC20_MIN_ABI, functionName: 'decimals' }),
  );
  const account = accountFor('borrower');
  const hash = await walletFor(account).writeContract({
    address: MUSDC,
    abi: ERC20_MIN_ABI,
    functionName: 'mint',
    args: [account.address, parseUnits('100000', decimals)],
    account,
    chain: forkChain,
  });
  await confirm(hash, 'mint mUSDC (token-screen spec)');
}

/** The maker signs and posts a single-value lender order from the Rate Desk
 *  ticket, on the suite's own (unscreened) server: the minimal path of
 *  spec 19, which pins the ticket itself. */
async function postSignedLenderOrder(page: Page, tenor: number): Promise<void> {
  await openMarketViaCustomPair(page, tenor, MUSDC);
  await connectWallet(page);
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.locator('#desk-amount').fill('0.002');
  await page.locator('#desk-rate').fill(RATE);
  await page.locator('#desk-collateral-amount').fill('100');
  // GTC: the signature deadline is anchored to chain time, so the order
  // outlives the suite's fork time travel.
  await page
    .getByRole('group', { name: 'How long it stays open' })
    .getByRole('button', { name: 'Until I cancel', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'How to post' })
    .getByRole('button', { name: 'Sign only (free)', exact: true })
    .click();
  const post = page.getByRole('button', { name: 'Sign and post' });
  await consentAndWaitEnabled(page, post);
  await post.click();
  await expect(
    page.getByText(/Signed offer posted — no network fee spent\./),
  ).toBeVisible({ timeout: 60_000 });
}

/** A fresh taker session on the screened server, with the GoPlus origin
 *  answering `answer()`, opened on the order's fill card. */
async function openFillCard(
  launchWallet: (role: 'borrower', opts: { advanced: boolean }) => Promise<WalletSession>,
  tenor: number,
  answer: () => GoPlusAnswer,
): Promise<{ taker: WalletSession; card: Locator; consent: Locator; fill: Locator }> {
  const taker = await launchWallet('borrower', { advanced: true });
  await mockGoPlus(taker.page, answer);
  await openMarketViaCustomPair(taker.page, tenor, MUSDC, screened!.base);
  await connectWallet(taker.page);
  const row = taker.page.locator('.desk-ladder-row').filter({ hasText: `${RATE}%` });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.getByRole('button', { name: 'Fill', exact: true }).click();
  const card = taker.page.locator('.desk-signed-confirm');
  await expect(card).toBeVisible();
  return {
    taker,
    card,
    consent: card.locator('input[type="checkbox"]'),
    fill: card.getByRole('button', { name: 'Fill order', exact: true }),
  };
}

test('a signed fill runs the token screen: a block or an outage holds it, a changed warning refuses before the wallet, the shown warning fills', async ({
  launchWallet,
}) => {
  const tenor = await freshTenor(WETH, MUSDC);
  await fundTakerMusdc();
  // The fill pulls the maker's leg from vault FREE balance.
  await fundVaultFreeBalance('lender', WETH, parseEther('0.002'));

  const maker = await launchWallet('lender', { advanced: true });
  await postSignedLenderOrder(maker.page, tenor);
  const book = await fetchSignedBook(WETH, MUSDC, tenor);
  expect(book).toHaveLength(1);
  const orderHash = book[0].orderHash;

  await test.step('a blocking verdict names the finding and holds the button', async () => {
    const { card, consent, fill } = await openFillCard(launchWallet, tenor, () => ({
      row: goPlusRow({ is_honeypot: '1' }),
    }));
    await expect(card).toContainText(copy.tokenSecurity.gateBlock(LEG, HONEYPOT), {
      timeout: 30_000,
    });
    await consent.check();
    await expect(fill).toBeDisabled();
  });

  await test.step('a check that cannot run holds the button until it answers', async () => {
    let answer: GoPlusAnswer = { status: 500 };
    const { card, consent, fill } = await openFillCard(launchWallet, tenor, () => answer);
    await expect(card).toContainText(copy.tokenSecurity.gateUnknown(LEG), {
      timeout: 30_000,
    });
    await consent.check();
    await expect(fill).toBeDisabled();

    answer = { row: goPlusRow() };
    await card.getByRole('button', { name: copy.tokenSecurity.retry }).click();
    await expect(card).not.toContainText(copy.tokenSecurity.gateUnknown(LEG), {
      timeout: 30_000,
    });
    // Consent ticked against the held screen does not carry over.
    await expect(consent).not.toBeChecked();
    await consent.check();
    await expect(fill).toBeEnabled({ timeout: 30_000 });
  });

  await test.step('a warning that changes after consent refuses before the wallet; the shown one fills', async () => {
    let answer: GoPlusAnswer = { row: goPlusRow({ slippage_modifiable: '1' }) };
    const { taker, card, consent, fill } = await openFillCard(
      launchWallet,
      tenor,
      () => answer,
    );
    await expect(card).toContainText(copy.tokenSecurity.gateWarn(LEG, WARN_A), {
      timeout: 30_000,
    });
    await consent.check();
    await expect(fill).toBeEnabled({ timeout: 30_000 });

    // The screen now reports a different finding. The card still shows A
    // (its cached verdict), so the signer's live re-screen is what sees B.
    answer = { row: goPlusRow({ hidden_owner: '1' }) };
    const txsBefore = taker.flags.sentTransactions;
    await fill.click();
    await expect(card).toContainText(/reports new findings since you reviewed it/, {
      timeout: 30_000,
    });
    expect(taker.flags.typedDataRequests.AcceptTerms ?? 0).toBe(0);
    expect(taker.flags.sentTransactions).toBe(txsBefore);
    // The card now discloses B, and consent given against A is void.
    await expect(card).toContainText(copy.tokenSecurity.gateWarn(LEG, WARN_B));
    await expect(consent).not.toBeChecked();
    await expect(fill).toBeDisabled();

    // Consent against what is shown now fills the order on-chain.
    await consent.check();
    await expect(fill).toBeEnabled({ timeout: 30_000 });
    await fill.click();
    await expect
      .poll(async () => signedFilledAmount(orderHash), { timeout: 120_000 })
      .toBe(parseEther('0.002'));
    expect(taker.flags.typedDataRequests.AcceptTerms).toBe(1);
  });
});
