/** Flow 3.1 (L2) — lender posts a WETH lending offer against faucet
 *  tLIQ collateral: details → terms → review receipt → consent →
 *  approve + createOffer → done, then the offer is live on-chain. */
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer } from '../lib/flows';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('posts a lending offer end-to-end', async ({ launchWallet }) => {
  const { page, account } = await launchWallet('lender');

  const [beforeIds] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserOffersPaginated',
    args: [account.address, 0n, 100n],
  })) as [readonly bigint[], bigint];

  await postLenderOffer(page);

  const [afterIds] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserOffersPaginated',
    args: [account.address, 0n, 100n],
  })) as [readonly bigint[], bigint];
  expect(afterIds.length).toBe(beforeIds.length + 1);
});
