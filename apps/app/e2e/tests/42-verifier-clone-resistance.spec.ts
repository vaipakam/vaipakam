/** #745 — what the NFT verifier gives a reader to hold any copy of it to.
 *
 *  A cloned verifier can render any verdict and add a "connect to confirm"
 *  step that drains the wallet. No page can stop being copied, so the real
 *  one states three things a copy cannot change for the reader: it never
 *  asks for a wallet, it names the full contract address it checked, and it
 *  links the same token on the chain's block explorer, a view Vaipakam does
 *  not serve. The Help page lists that address for every network.
 *
 *  Token 999999 is never minted on the fixture chain, so the verdict is the
 *  "does not exist" one, which must offer the explorer cross-check too.
 */
import { test, expect } from '../lib/wallet-fixture';
import { DIAMOND } from '../lib/chain';

const ABSENT_TOKEN = '999999';

test('the verifier says it never needs a wallet and names the contract it checked', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto(`/nft/${ABSENT_TOKEN}`, { waitUntil: 'domcontentloaded' });

  const notice = page.getByRole('note').filter({ hasText: /never needs your wallet/i });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/connect a wallet, sign a message, or approve a transfer/i);

  // The FULL address, linked to the explorer's page for that address.
  const contract = page.locator(`a[href$="/address/${DIAMOND}"]`).first();
  await expect(contract).toBeVisible();
  await expect(contract).toHaveText(DIAMOND);
  await expect(contract).toHaveAttribute('target', '_blank');

  // The verdict renders, and it carries the independent cross-check.
  await expect(page.getByText(/does not currently exist on this network/i)).toBeVisible();
  const explorer = page.locator(`a[href$="/nft/${DIAMOND}/${ABSENT_TOKEN}"]`);
  await expect(explorer).toBeVisible();
  await expect(explorer).toContainText(`#${ABSENT_TOKEN}`);
  await expect(explorer).toHaveAttribute('rel', /noopener/);
});

test('Help lists the contract address and explains how to spot a fake verifier', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/help', { waitUntil: 'domcontentloaded' });

  const contracts = page.locator('#contracts');
  await expect(contracts).toBeVisible();
  await expect(contracts.locator(`a[href$="/address/${DIAMOND}"]`)).toHaveText(DIAMOND);

  await expect(page.getByText(/how do I spot a fake verifier/i)).toBeVisible();
});
