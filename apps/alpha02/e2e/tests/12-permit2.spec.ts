/** #1038 — Permit2 signature approvals, on Anvil.
 *
 *  Canonical Permit2 (0x…78BA3) has code on the Base Sepolia fork,
 *  so the REAL contract verifies the signatures. Two properties the
 *  regular flow specs (02/03 — which now run through the permit path
 *  implicitly, since the fixture signs typed data) can't show:
 *
 *  1. SINGLE-TRANSACTION posting: with no standing allowance, the
 *     permit path sends exactly ONE transaction (createOfferWithPermit)
 *     — the classic path would need an approve transaction first.
 *     This is the whole point of #1038, asserted via the fixture's
 *     eth_sendTransaction counter.
 *  2. CLASSIC FALLBACK: a wallet that refuses the Permit2 typed-data
 *     request (fixture flag → EIP-1193 4001) must degrade to the
 *     approve+create sequence and still succeed — Permit2 is an
 *     upgrade, never a gate. The rejection counter proves the permit
 *     path was actually attempted, and the transaction count proves
 *     the classic path ran.
 */
import { parseEther } from 'viem';
import { erc20Abi } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, newestOfferIdFor } from '../lib/flows';
import { pub, DIAMOND, WETH } from '../lib/chain';

async function wethAllowance(owner: `0x${string}`): Promise<bigint> {
  return pub.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, DIAMOND],
  });
}

test('permit path posts an offer in a single transaction, leaving no allowance', async ({
  launchWallet,
}) => {
  const session = await launchWallet('lender');
  const { page, account, flags } = session;

  // Precondition for the single-tx claim: the classic path WOULD need
  // an approval here (otherwise one transaction proves nothing).
  const before = await wethAllowance(account.address);
  expect(before < parseEther('0.005')).toBe(true);

  await postLenderOffer(page);
  const offerId = await newestOfferIdFor(account.address);
  expect(offerId > 0n).toBe(true);

  // One transaction total — the signature replaced the approve tx…
  expect(flags.sentTransactions).toBe(1);
  expect(flags.permit2Rejections).toBe(0);
  // …and no standing allowance was left behind (permit hygiene).
  expect(await wethAllowance(account.address)).toBe(before);
});

test('a wallet refusing Permit2 typed data degrades to the classic approve path', async ({
  launchWallet,
}) => {
  const session = await launchWallet('lender');
  const { page, account, flags } = session;
  flags.rejectPermit2 = true;

  await postLenderOffer(page);
  const offerId = await newestOfferIdFor(account.address);
  expect(offerId > 0n).toBe(true);

  // The permit path was attempted and refused…
  expect(flags.permit2Rejections).toBeGreaterThanOrEqual(1);
  // …and the classic sequence completed: approve + createOffer.
  expect(flags.sentTransactions).toBeGreaterThanOrEqual(2);
});
