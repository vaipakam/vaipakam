/**
 * Recover (matrix ACC-25, ACC-26, ACC-27; RB-RECOVER), against a vault funded
 * through the protocol's public entry points on the fixture chain and then
 * sent WETH by a plain transfer, which the protocol does not count. The page
 * states the protocol's own figure for what sits uncounted and what stops
 * adopting it: with no sanctions screen set, adopting is refused and
 * disowning stays open. With a screen set, the wallet names the source,
 * reads the declaration word for word, types CONFIRM, signs the protocol's
 * EIP-712 type and sends the adoption; the finish card reads the credit from
 * the transaction's record and the protocol's figure drops to nothing. A
 * source the screen flags is never sent. A vault an earlier adoption barred
 * says so, names the source, offers no adoption, and can still disown.
 *
 * Runs on the desktop and the phone project. The screen is a contract placed
 * with `anvil_setCode` at a fixed address and set as the Diamond's oracle by
 * the fixture's admin; the chain is reverted after each test.
 */
import { erc20Abi, getAddress, parseEther, type Address } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { ScenarioChain } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { ADOPTION_ACK_TEXT, ADOPTION_TYPES, adoptionDomain, adoptionMessage } from '../../src/shared/recover/adoption';
import { anvilRpc } from '../lib/anvil';
import { scenario, txDeadline } from '../lib/chain';
import { CHAIN_ID, connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

const ORACLE = '0x000000000000000000000000000000000000f1a6' as Hex;
/** `isSanctioned(address)` answers true for `flagged` alone. */
const flagsOnly = (flagged: Hex): Hex => `0x73${flagged.slice(2).toLowerCase()}6004351460005260206000f3`;
/** Every address reads clean. */
const CLEAN = '0x600060005260206000f3' as Hex;
/** A source address no test wallet controls. */
const FLAGGED = '0x00000000000000000000000000000000000bad01' as Hex;
const SENT = parseEther('0.001');

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A vault holding a 0.02 WETH deposit, then sent 0.001 WETH straight. */
async function vaultWithStray(sc: ScenarioChain): Promise<Address> {
  const deposit = parseEther('0.02');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], deposit + SENT);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, deposit]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, deposit]);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [sc.address('lender')])) as Address;
  await sc.write('lender', WETH, TOKEN_ABI, 'transfer', [vault, SENT]);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBe(deposit + SENT);
  return vault;
}

const untracked = (sc: ScenarioChain) => sc.read<bigint>('untrackedHolding', [sc.address('lender'), 0, WETH, 0n]);

test('an asset sent straight to the vault is adopted after the declaration, and the protocol counts it', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  await vaultWithStray(sc);
  expect(await untracked(sc)).toBe(SENT);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto(`/recover?asset=${WETH}`);
  await connectWallet(page);
  const card = page.getByTestId('recover-subject');
  const figure = card.getByTestId('recover-figure');
  await expect(figure).toHaveAttribute('data-state', 'untracked', { timeout: 60_000 });
  await expect(figure).toContainText('0.001 WETH of this sits in your vault outside the protocol');

  // No screen set: the protocol refuses an adoption it cannot screen.
  await expect(card.getByTestId('recover-adopt-stop')).toContainText('no sanctions screen set');
  await expect(card.getByTestId('recover-adopt-open')).toHaveCount(0);
  await expect(card.getByTestId('recover-disown-open')).toBeVisible();
  await fitsWidth(page);

  await anvilRpc('anvil_setCode', [ORACLE, CLEAN]);
  await sc.diamondWrite('admin', 'setSanctionsOracle', [ORACLE]);
  await expect(card.getByTestId('recover-adopt-stop')).toHaveCount(0, { timeout: 60_000 });
  await card.getByTestId('recover-adopt-open').click();

  await page.getByTestId('recover-adopt-amount').fill('0.001');
  await page.getByTestId('recover-adopt-source').fill(me);
  await page.getByTestId('recover-adopt-review').click();

  const flow = page.getByTestId('recover-adopt-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Adopt into your vault', { timeout: 60_000 });
  await expect(receipt).toContainText(me);
  await expect(receipt).toContainText('Nothing moves: the asset is already in your vault.');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await expect(flow.getByTestId('recover-ack-text')).toHaveText(ADOPTION_ACK_TEXT);
  const confirm = flow.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await flow.getByTestId('recover-adopt-confirm').fill('CONFIRM');
  await expect(confirm).toBeEnabled();
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await confirm.click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Counted in your vault');
  expect(flags.typedDataRequests.AdoptionAcknowledgment).toBe(1);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await untracked(sc)).toBe(0n);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(figure).toHaveAttribute('data-state', 'none', { timeout: 60_000 });
  await fitsWidth(page);
});

test('a flagged source is never sent, and a barred vault says so and can still disown', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  await vaultWithStray(sc);
  await anvilRpc('anvil_setCode', [ORACLE, flagsOnly(FLAGGED)]);
  await sc.diamondWrite('admin', 'setSanctionsOracle', [ORACLE]);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto(`/recover?asset=${WETH}`);
  await connectWallet(page);
  const card = page.getByTestId('recover-subject');
  await card.getByTestId('recover-adopt-open').click({ timeout: 60_000 });
  await page.getByTestId('recover-adopt-amount').fill('0.001');
  await page.getByTestId('recover-adopt-source').fill(FLAGGED);
  await page.getByTestId('recover-adopt-review').click();

  // The screen flags the source: the declaration is not offered and nothing is asked.
  const flow = page.getByTestId('recover-adopt-panel');
  await expect(flow).toContainText('The sanctions screen flags this source', { timeout: 60_000 });
  await expect(flow.getByTestId('recover-ack-text')).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.typedDataRequests.AdoptionAcknowledgment ?? 0).toBe(0);
  await fitsWidth(page);
  await flow.getByTestId('recover-adopt-change').click();
  await page.getByTestId('recover-adopt-cancel').click();

  // The wallet adopts from the flagged source outside the app: nothing is
  // credited and the vault is barred.
  const deadline = await txDeadline(sc);
  const nonce = await sc.read<bigint>('adoptionNonce', [me]);
  const draft = { subject: { standard: 'erc20' as const, asset: WETH as Hex, tokenId: 0n }, amount: SENT, source: FLAGGED };
  const wallet = sc.wallet('lender');
  const signature = await wallet.signTypedData({
    account: wallet.account!,
    domain: adoptionDomain(CHAIN_ID, sc.diamond),
    types: ADOPTION_TYPES,
    primaryType: 'AdoptionAcknowledgment',
    message: adoptionMessage(me, draft, nonce, deadline),
  });
  await sc.diamondWrite('lender', 'adoptUntracked', [0, WETH, 0n, SENT, FLAGGED, deadline, signature]);
  expect((await sc.read<Hex>('vaultBannedSource', [me])).toLowerCase()).toBe(FLAGGED);
  expect(await untracked(sc)).toBe(SENT);

  await expect(card.getByTestId('recover-barred')).toContainText(getAddress(FLAGGED), { timeout: 60_000 });
  await expect(card.getByTestId('recover-adopt-stop')).toContainText('barred from adopting');
  await expect(card.getByTestId('recover-adopt-open')).toHaveCount(0);
  await fitsWidth(page);

  await card.getByTestId('recover-disown-open').click();
  const disown = page.getByTestId('recover-disown-panel');
  const receipt = disown.locator('.receipt');
  await expect(receipt).toContainText('Disown from your vault', { timeout: 60_000 });
  await expect(receipt).toContainText('Disowning moves and credits nothing.');
  await expect(receipt).toContainText('Wallet prompts: 1');
  const sent = flags.sentTransactions;
  await disown.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = disown.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Disowned: WETH, 0.001 WETH recorded');
  expect(flags.sentTransactions).toBe(sent + 1);
  await fitsWidth(page);
});
