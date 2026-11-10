/**
 * Asset trust tiers and token search (#3446, RB-ASSET-TRUST): a chosen
 * token's tier from the public market rankings the index serves, matched by
 * contract address on the network, never by name. The stand-in index stores
 * no list by default, as on the live test networks; each step stores the
 * list it needs and reloads the page (the app keeps the rankings an hour).
 * Then the search: ranked tokens by name or symbol with their full address,
 * a suggested test token with its label, and the address filled on a pick.
 * Nothing is signed. Runs on the desktop and the phone project.
 */
import { erc20Abi, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setRankings, type StubRankingSource } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

const CHAIN = 84532;
const NOW = Math.floor(Date.now() / 1000);
const stored = (at = NOW - 3600): StubRankingSource => ({ listFetchedAt: at, lastRun: { fetchedAt: at, ok: true, rowCount: 2, detail: null } });
const EMPTY: StubRankingSource = { listFetchedAt: null, lastRun: null };
const weth = WETH.toLowerCase();
/** Addresses with no code, standing in for ranked tokens elsewhere. */
const LOOKALIKE = '0x' + '1'.repeat(40);
const USDC = '0x' + '2'.repeat(40);
const rank = (n: number, symbol: string, name: string) => ({ rank: n, symbol, name });

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Open Borrow afresh (so the rankings are read again) and pick `lending`. */
async function pick(page: Page, lending: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(lending);
}

const lendingTrust = (page: Page) => page.getByTestId('pick-lending').getByTestId('asset-trust');

test('a chosen token shows its tier from the public rankings, matched by its address', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page } = await launchWallet('borrower');

  // No list stored for the network: a test network says so.
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'testNetwork', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('Base Sepolia is a test network: its tokens have no market value and no public ranking.');
  // A test token the deployment publishes is labelled one, list or not.
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await expect(page.getByTestId('pick-collateral').getByTestId('asset-trust')).toHaveAttribute('data-trust', 'test');

  // Ranked by both lists: the better rank counts, and a top-20 token the
  // protocol prices is a blue chip.
  await setRankings({
    chainId: CHAIN,
    sources: { cg: stored(), cp: stored() },
    assets: [{ address: weth, ranks: { cg: rank(3, 'WETH', 'Wrapped Ether'), cp: rank(2, 'WETH', 'Wrapped Ether') } }],
  });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'blueChip', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('WETH is a blue chip: #2 by market value on Base Sepolia, and the protocol prices it.');
  await expect(lendingTrust(page)).toContainText('Rankings from the second public list of market values, as of');
  await fitsWidth(page);

  // Further down the list: its rank tier.
  await setRankings({
    chainId: CHAIN,
    sources: { cg: stored(), cp: stored() },
    assets: [{ address: weth, ranks: { cg: rank(150, 'WETH', 'Wrapped Ether') } }],
  });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'top200', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('WETH is in the Top 200 by market value on Base Sepolia, at #150.');

  // The symbol ranked at another address: this one is a possible copy.
  await setRankings({
    chainId: CHAIN,
    sources: { cg: stored(), cp: stored() },
    assets: [{ address: LOOKALIKE, ranks: { cg: rank(2, 'WETH', 'Wrapped Ether') } }],
  });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'copy', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText(
    `Possible copy: WETH shares the name or symbol of WETH (Wrapped Ether), ranked #2 at a different address, ${LOOKALIKE}.`,
  );

  // The two lists put the symbol at different addresses: unverified.
  await setRankings({
    chainId: CHAIN,
    sources: { cg: stored(), cp: stored() },
    assets: [
      { address: weth, ranks: { cg: rank(2, 'WETH', 'Wrapped Ether') } },
      { address: LOOKALIKE, ranks: { cp: rank(2, 'WETH', 'Wrapped Ether') } },
    ],
  });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'unverified', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('Unverified: the two public lists disagree on where WETH is on Base Sepolia.');
  await expect(lendingTrust(page)).toContainText(LOOKALIKE);

  // Not ranked, from an old list whose last refresh failed: own risk, and
  // the failed refresh is said rather than the old list shown as current.
  await setRankings({
    chainId: CHAIN,
    sources: { cg: { listFetchedAt: NOW - 3 * 86_400, lastRun: { fetchedAt: NOW - 3600, ok: false, rowCount: 0, detail: 'timeout' } }, cp: EMPTY },
    assets: [{ address: USDC, ranks: { cg: rank(5, 'USDC', 'USD Coin') } }],
  });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'unranked', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('WETH is not in the top 500 by market value on Base Sepolia. Use it at your own risk');
  await expect(lendingTrust(page)).toContainText('The latest refresh of the first public list failed on');

  // The index cannot answer: no tier, and why.
  await setRankings({ down: true });
  await pick(page, WETH);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'failed', { timeout: 30_000 });
  await expect(lendingTrust(page)).toContainText('The public market rankings could not be read (The indexer answered 503');
  await fitsWidth(page);
});

test('token search lists ranked tokens with their full address and fills the one picked', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const tliqSymbol = await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'symbol' });
  await setRankings({
    chainId: CHAIN,
    sources: { cg: stored(), cp: stored() },
    assets: [
      { address: weth, ranks: { cg: rank(2, 'WETH', 'Wrapped Ether') } },
      { address: USDC, ranks: { cg: rank(5, 'USDC', 'USD Coin'), cp: rank(6, 'USDC', 'USD Coin') } },
    ],
  });
  const { page } = await launchWallet('borrower');
  await page.goto('/borrow');
  await connectWallet(page);
  const leg = page.getByTestId('pick-lending');
  await leg.locator('select').selectOption('other');
  const search = leg.getByRole('textbox', { name: 'Search by name or symbol, or paste the address' });

  // By symbol: the ranked token, its tier and its full address.
  await search.fill('usd');
  const hits = leg.getByTestId('token-hit');
  // Ranked tokens come first; a suggested test token may follow.
  await expect(hits.first()).toContainText('USDC · USD Coin', { timeout: 30_000 });
  await expect(hits.first()).toContainText('Top 100, #5');
  await expect(hits.first()).toContainText(USDC);

  // A suggested test token is found by its symbol, with its label.
  await search.fill(tliqSymbol.slice(0, 3));
  await expect(leg.getByTestId('token-search')).toContainText('test token');
  await expect(leg.getByTestId('token-search')).toContainText(tliq);

  // By name, then picked: the address fills in and its tier is read.
  await search.fill('wrapped');
  await expect(hits.first()).toContainText(weth);
  await hits.first().click();
  await expect(search).toHaveValue(weth);
  await expect(leg.getByTestId('token-search')).toHaveCount(0);
  await expect(lendingTrust(page)).toHaveAttribute('data-trust', 'blueChip', { timeout: 30_000 });
  await fitsWidth(page);

  // Nothing ranked matches: say so.
  await search.fill('zzzz');
  await expect(leg.getByTestId('token-search')).toContainText('No ranked token on Base Sepolia matches; paste the contract address instead.');

  // An address attempt is checked as an address, not searched.
  await search.fill('0x12');
  await expect(leg).toContainText('This is not a token address.');
  await expect(leg.getByTestId('token-search')).toHaveCount(0);

  // The index down: the search says it cannot list ranked tokens.
  await setRankings({ down: true });
  await page.goto('/borrow');
  await connectWallet(page);
  await leg.locator('select').selectOption('other');
  await search.fill('usd');
  await expect(leg.getByTestId('token-search')).toContainText('The public rankings could not be read, so only suggested tokens are listed', {
    timeout: 30_000,
  });
  await fitsWidth(page);
});
