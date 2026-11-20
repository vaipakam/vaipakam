/**
 * Unrecognised items (#3435, matrix row "Unrecognised items"). A vault funded
 * through the protocol is then sent tLIQ by a plain transfer. The index's
 * arrival list (the stand-in, in the route's shape) names both the deposited
 * WETH and the stray tLIQ; the page checks each against the protocol's
 * `untrackedHolding` at one block and shows only the tLIQ, apart from the
 * wallet's own assets and closed by default, with the count, the scan's
 * "still checking" state, and what the token calls itself as plain text
 * beside its address. Its link goes to Recover, which shows the same list to
 * pick from and suggests neither choice. A vault the index has not finished
 * says how far it reached; with the index refusing, the page says the list
 * is unknown. Runs on the desktop and the phone project.
 */
import { parseEther, type Address } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { ScenarioChain } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setArrivals } from '../lib/stub';
import { CHAIN_ID, connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A vault holding a WETH deposit, then sent 5 tLIQ straight. */
async function vaultWithStray(sc: ScenarioChain, tliq: Hex): Promise<Address> {
  const deposit = parseEther('0.02');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], deposit);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, deposit]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, deposit]);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [sc.address('lender')])) as Address;
  await sc.write('lender', tliq, TOKEN_ABI, 'mint', [vault, parseEther('5')]);
  return vault;
}

function answer(owner: Hex, vault: Hex, tliq: Hex, complete: boolean) {
  return {
    chainId: CHAIN_ID,
    owner: owner.toLowerCase(),
    vault: vault.toLowerCase(),
    scannedFromBlock: 1,
    scannedToBlock: complete ? 1_000 : 400,
    headBlock: 1_000,
    complete,
    candidates: [
      { asset: tliq.toLowerCase(), kind: 'erc20', tokenId: null, firstBlock: 300, lastBlock: 300 },
      { asset: WETH.toLowerCase(), kind: 'erc20', tokenId: null, firstBlock: 200, lastBlock: 200 },
    ],
    truncated: false,
    pruned: false,
    nextCursor: null,
  };
}

test('a stray token is listed apart, closed, as plain text with its address, and Recover lists the same to pick from', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const me = sc.address('lender');
  const vault = await vaultWithStray(sc, tliq);
  await setArrivals({ chainId: CHAIN_ID, owner: me, answer: answer(me, vault, tliq, false) });

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const section = page.getByTestId('unrecognised');
  await expect(section).toHaveAttribute('data-count', '1', { timeout: 90_000 });
  await expect(section.getByTestId('unrecognised-checking')).toContainText('block 400 of 1000');
  const details = section.getByTestId('unrecognised-details');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  const item = section.locator(`[data-unrecognised="erc20:${tliq.toLowerCase()}:"]`);
  await expect(item).toContainText(tliq.toLowerCase());
  await expect(item.getByTestId('unrecognised-figure')).toContainText('5 in your vault, not counted as yours');
  await expect(item.getByTestId('unrecognised-says')).toContainText('Calls itself');
  await expect(item.locator('img')).toHaveCount(0);
  await expect(section).toContainText('The platform did not put them there');
  await expect(section.locator(`[data-unrecognised="erc20:${WETH.toLowerCase()}:"]`)).toHaveCount(0);
  await fitsWidth(page);

  await item.getByRole('link', { name: 'Choose what to do on Recover' }).click();
  await expect(page).toHaveURL(new RegExp(`/recover\\?asset=${tliq}`, 'i'));
  const list = page.getByTestId('recover-unrecognised');
  await expect(list).toHaveAttribute('data-count', '1', { timeout: 90_000 });
  await expect(list.getByTestId('recover-unrecognised-details')).toHaveAttribute('open', '');
  await expect(list.getByTestId(`recover-pick-erc20:${tliq.toLowerCase()}:`)).toBeVisible();
  await expect(page.getByTestId('recover-subject').getByTestId('recover-figure')).toHaveAttribute('data-state', 'untracked', { timeout: 60_000 });
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);
});

test('a finished scan says the block it checked to; a refusing index makes the list unknown', async ({ launchWallet }) => {
  const sc = scenario({ lender: 'freshLender' });
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const me = sc.address('lender');
  const vault = await vaultWithStray(sc, tliq);
  await setArrivals({ chainId: CHAIN_ID, owner: me, answer: answer(me, vault, tliq, true) });

  const { page } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const section = page.getByTestId('unrecognised');
  await expect(section.getByTestId('unrecognised-checked')).toContainText('up to block 1000', { timeout: 90_000 });
  await expect(section.locator('summary')).toHaveText('Show the 1 found');

  await setArrivals({ chainId: CHAIN_ID, owner: me, status: 503 });
  await page.reload();
  await expect(page.getByTestId('unrecognised')).toContainText('could not be listed', { timeout: 90_000 });
});
