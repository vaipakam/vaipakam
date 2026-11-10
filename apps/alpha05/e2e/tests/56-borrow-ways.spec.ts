/**
 * Borrow: the two ways and the rate ladder (#3319). After the pair, the page
 * names both ways up front (borrow now, or set your own rate); the open
 * offers read as a ladder grouped by rate, lowest first, each step stating
 * how many offers it holds and their amounts per offer, never summed; the
 * borrower's highest rate (and in Advanced, highest loan-to-value) hides
 * offers and says how many; and the way to set your own rate states the
 * lenders standing ready for the pair from the protocol's list of active
 * intents, with the plain statement that a fill is likely but neither
 * instant nor guaranteed, only while the network's switches are on and its
 * keepers are not paused, and only for request terms a standing lender can
 * fill. Runs on the desktop and the phone project; each
 * test posts what it reads, so the second project never depends on the
 * first.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const E18 = 10n ** 18n;
/** The lowest finer-schedule threshold the protocol accepts (1,000 numeraire units). */
const THRESHOLD = 1_000n * E18;

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function openPair(page: Page, tliq: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
}

test('both ways are named up front, and the offers read as a rate ladder the borrower can limit', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const low1 = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.2', collateralTliq: '1000', rateBps: 400, days: 30 });
  const low2 = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.3', collateralTliq: '1500', rateBps: 400, days: 30 });
  const high = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.1', collateralTliq: '500', rateBps: 700, days: 30 });

  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);

  // The two ways, before the list.
  const ways = page.getByRole('region', { name: 'Two ways to borrow' });
  await expect(ways).toBeVisible({ timeout: 60_000 });
  await expect(ways.getByRole('heading', { name: 'Borrow now' })).toBeVisible();
  await expect(ways.getByRole('heading', { name: 'Set your own rate' })).toBeVisible();
  await expect(ways.getByTestId('request-open')).toBeVisible();
  await expect(ways.getByTestId('standing-lenders')).not.toContainText('Checking', { timeout: 60_000 });

  // The ladder: one step per rate, lowest first, amounts per offer.
  const offers = page.getByRole('region', { name: 'Offers you can take' });
  const step400 = offers.locator('.ladder-step[data-rate-bps="400"]');
  await expect(step400.locator(`[data-offer-id="${low1}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(step400.locator(`[data-offer-id="${low2}"]`)).toBeVisible();
  await expect(step400.locator('.ladder-head')).toContainText(/At 4% a year: \d+ offers, from [\d.]+ \S+ to [\d.]+ \S+ each\./);
  await expect(offers.locator(`.ladder-step[data-rate-bps="700"] [data-offer-id="${high}"]`)).toBeVisible();
  const rates = await offers.locator('.ladder-step').evaluateAll((els) => els.map((e) => BigInt(e.getAttribute('data-rate-bps')!)));
  expect(rates).toEqual([...rates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  await expect(offers).toContainText('Grouped by rate, lowest first');
  await fitsWidth(page);

  // The highest rate hides the 7% offer and says so; the rest stay.
  const limit = offers.getByTestId('limit-rate');
  await limit.fill('5');
  await expect(offers.locator(`[data-offer-id="${high}"]`)).toHaveCount(0);
  await expect(offers.getByTestId('hidden-rate')).toContainText(/Hidden: \d+ offers above your highest rate\./);
  await expect(offers.locator(`[data-offer-id="${low1}"]`)).toBeVisible();
  // An unreadable limit applies none, and says so.
  await limit.fill('five');
  await expect(offers).toContainText('until then no limit applies');
  await expect(offers.locator(`[data-offer-id="${high}"]`)).toBeVisible();
  await limit.fill('');
  await expect(offers.getByTestId('hidden-rate')).toHaveCount(0);
  // Basic offers no loan-to-value limit.
  await expect(offers.getByTestId('limit-ltv')).toHaveCount(0);

  // "See the offers" brings the list into view.
  await ways.getByRole('button', { name: 'See the offers' }).click();
  await expect(offers.getByRole('heading', { name: 'Offers you can take' })).toBeInViewport();
  await fitsWidth(page);
});

test('Advanced adds a loan-to-value limit, and the standing lenders are stated without promising a fill', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.2', collateralTliq: '1000', rateBps: 450, days: 30 });
  // A standing intent for the pair, funded with 0.5 WETH under a 1 WETH cap.
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, parseEther('1'), 350n, 7000, 60, parseEther('0.1'), false, true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.5'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, parseEther('0.5')]);
  // A fill against an intent needs both network switches on.
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  // A monthly schedule is open from the threshold up, so the form can offer it.
  await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);
  await sc.diamondWrite('admin', 'setMinPrincipalForFinerCadence', [THRESHOLD]);
  const perWeth = await sc.read<bigint>('getNumeraireValue', [WETH, E18, false]);
  const wholeWeth = (THRESHOLD * 3n) / 2n / perWeth + 1n;

  const { page } = await launchWallet('borrower', { advanced: true });
  await openPair(page, tliq);

  const ways = page.getByRole('region', { name: 'Two ways to borrow' });
  const standing = ways.getByTestId('standing-ready');
  await expect(standing).toContainText(/stands? ready for this pair: up to [\d.]+ \S+/, { timeout: 60_000 });
  await expect(standing).toContainText(/at rates from [\d.]+%/);
  await expect(ways).toContainText('a fill is likely but neither instant nor guaranteed');
  await expect(ways).toContainText(/Their limits reach \d+ days and [\d.]+% loan-to-value at most\./);

  // The loan-to-value limit: zero hides every offer whose ratio is a figure.
  const offers = page.getByRole('region', { name: 'Offers you can take' });
  await expect(offers.locator(`[data-offer-id="${offerId}"]`)).toBeVisible({ timeout: 60_000 });
  await offers.getByTestId('limit-ltv').fill('0');
  await expect(offers.getByTestId('hidden-ltv')).toContainText(/Hidden: \d+ offers above your highest loan-to-value\./);
  await expect(offers.locator(`[data-offer-id="${offerId}"]`)).toHaveCount(0);
  await expect(offers).toContainText('clear them to see all');
  await fitsWidth(page);

  // The request form states the same lenders under its heading.
  await ways.getByTestId('request-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  await expect(page.getByTestId('standing-ready')).toContainText(/ready for this pair/, { timeout: 60_000 });
  // Terms no standing lender accepts say so instead of a likely fill.
  await page.getByTestId('request-prorata').check();
  await expect(page.getByTestId('standing-blocked')).toContainText('so no standing lender can fill it');
  await expect(page.locator('form')).not.toContainText('a fill is likely');
  // Back to the full term's interest, the likely fill returns…
  await page.locator('input[name="request-interest"]').first().check();
  await expect(page.getByTestId('standing-blocked')).toHaveCount(0);
  await expect(page.locator('form')).toContainText('a fill is likely');
  // …and an interest schedule rules every standing lender out again.
  await page.getByTestId('request-amount').fill(String(wholeWeth));
  await page.getByTestId('request-duration').getByRole('radio', { name: '60 days' }).check();
  const monthly = page.getByTestId('request-cadence').getByRole('radio', { name: /Every month/ });
  await expect(monthly).toBeEnabled({ timeout: 60_000 });
  await monthly.check();
  await expect(page.getByTestId('standing-blocked')).toContainText('This request pays interest on a schedule, so no standing lender can fill it');
  await expect(page.locator('form')).not.toContainText('a fill is likely');
  await fitsWidth(page);
});

test('with the standing-intent switch off, the lenders are not offered as a likely fill', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, parseEther('1'), 350n, 7000, 60, parseEther('0.1'), false, true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.5'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, parseEther('0.5')]);
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [false]);

  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);
  const ways = page.getByRole('region', { name: 'Two ways to borrow' });
  const standing = ways.getByTestId('standing-lenders');
  await expect(standing).toContainText('Matching against standing lenders is switched off on this network', { timeout: 60_000 });
  await expect(standing.getByTestId('standing-ready')).toHaveCount(0);
  await expect(ways).not.toContainText('a fill is likely');
  await fitsWidth(page);
});

test('with every keeper paused, the matching service is said to fill none and others still may', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, parseEther('1'), 350n, 7000, 60, parseEther('0.1'), false, true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.5'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, parseEther('0.5')]);
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.diamondWrite('admin', 'setKeepersPaused', [true]);

  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);
  const ways = page.getByRole('region', { name: 'Two ways to borrow' });
  await expect(ways.getByTestId('standing-ready')).toContainText(/ready for this pair/, { timeout: 60_000 });
  await expect(ways.getByTestId('standing-paused')).toContainText('The protocol has paused every keeper on this network, its matching service included');
  await expect(ways.getByTestId('standing-paused')).toContainText('A lender can still fill a request from its own standing offer');
  await expect(ways).not.toContainText('a fill is likely');
  await fitsWidth(page);
});

test('a borrower’s own standing intent is never counted as a lender ready for them', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('borrower', 'setLenderIntent', [WETH, tliq, parseEther('1'), 350n, 7000, 60, parseEther('0.1'), false, true]);
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.5'));
  await sc.write('borrower', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('borrower', 'fundLenderIntent', [WETH, tliq, parseEther('0.5')]);
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);

  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);
  const standing = page.getByRole('region', { name: 'Two ways to borrow' }).getByTestId('standing-lenders');
  await expect(standing).toContainText('No lender stands ready on this pair now', { timeout: 60_000 });
  await expect(standing.getByTestId('standing-ready')).toHaveCount(0);
});
