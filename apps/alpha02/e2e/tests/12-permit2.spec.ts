/** #1038 — Permit2 signature approvals, on Anvil.
 *
 *  Canonical Permit2 (0x…78BA3) has code on the Base Sepolia fork, so
 *  the REAL contract verifies the signatures. The permit path has a
 *  hard precondition the app checks before engaging: a standing
 *  token→Permit2 ERC-20 approval (SignatureTransfer executes the
 *  transferFrom AS the Permit2 contract — without that approval every
 *  *WithPermit call categorically reverts). The suite's ephemeral
 *  wallets are born WITHOUT it, so the regular flow specs (02/03) run
 *  the classic approve+action path throughout; each test here sets the
 *  lender's WETH→Permit2 allowance explicitly (direct viem write —
 *  outside the fixture, so the wallet counters stay untouched) and is
 *  order-independent. Three properties:
 *
 *  1. NO-PERMIT2-APPROVAL wallets skip permit SILENTLY: zero Permit2
 *     typed-data requests, classic approve+create still succeeds —
 *     zero degradation for the common wallet.
 *  2. SINGLE-TRANSACTION posting: with the Permit2 approval standing
 *     and no Diamond allowance, the permit path sends exactly ONE
 *     transaction (createOfferWithPermit) and leaves no Diamond
 *     allowance behind — the whole point of #1038.
 *  3. CLASSIC FALLBACK: a wallet that refuses the Permit2 typed-data
 *     request (fixture flag → EIP-1193 4001) degrades to the
 *     approve+create sequence and still succeeds — Permit2 is an
 *     upgrade, never a gate.
 */
import { erc20Abi, maxUint256, parseEther } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, newestOfferIdFor } from '../lib/flows';
import { pub, DIAMOND, WETH, forkChain, walletFor } from '../lib/chain';
import { accountFor } from '../lib/wallets';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

async function wethAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return pub.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

/** Set the lender's WETH→Permit2 allowance directly against the fork —
 *  the standing approval a real wallet acquires the first time it uses
 *  any Permit2 app (Uniswap et al). Deliberately NOT via the injected
 *  fixture wallet: the spec's transaction counters must only see what
 *  the APP sends. */
async function setPermit2Allowance(value: bigint): Promise<void> {
  const account = accountFor('lender');
  const hash = await walletFor(account).writeContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'approve',
    args: [PERMIT2, value],
    chain: forkChain,
    account,
  });
  await pub.waitForTransactionReceipt({ hash });
}

test('a wallet without a Permit2 approval keeps the classic path, silently', async ({
  launchWallet,
}) => {
  await setPermit2Allowance(0n);
  const session = await launchWallet('lender');
  const { page, account, flags } = session;

  await postLenderOffer(page);
  const offerId = await newestOfferIdFor(account.address);
  expect(offerId > 0n).toBe(true);

  // The permit path never engaged — not attempted-and-failed, SKIPPED:
  // no Permit2 typed-data request ever reached the wallet…
  expect(flags.permit2SignatureRequests).toBe(0);
  // …and the classic sequence ran: approve + createOffer.
  expect(flags.sentTransactions).toBeGreaterThanOrEqual(2);
});

test('permit path posts an offer in a single transaction, leaving no Diamond allowance', async ({
  launchWallet,
}) => {
  await setPermit2Allowance(maxUint256);
  const session = await launchWallet('lender');
  const { page, account, flags } = session;

  // Precondition for the single-tx claim: the classic path WOULD need
  // an approval here (otherwise one transaction proves nothing).
  const before = await wethAllowance(account.address, DIAMOND);
  expect(before < parseEther('0.005')).toBe(true);

  await postLenderOffer(page);
  const offerId = await newestOfferIdFor(account.address);
  expect(offerId > 0n).toBe(true);

  // Exactly one Permit2 signature, exactly one transaction ATTEMPT
  // (the fixture counts attempts, so this also proves no doomed
  // transaction preceded it) — the signature replaced the approve tx…
  expect(flags.permit2SignatureRequests).toBe(1);
  expect(flags.permit2Rejections).toBe(0);
  expect(flags.sentTransactions).toBe(1);
  // …and no standing DIAMOND allowance was left behind (permit
  // hygiene: the pull was one-shot, via Permit2).
  expect(await wethAllowance(account.address, DIAMOND)).toBe(before);
});

test('a wallet refusing Permit2 typed data degrades to the classic approve path', async ({
  launchWallet,
}) => {
  // The Permit2 approval is standing, so the app WILL attempt the
  // permit path — the refusal is what forces the fallback.
  await setPermit2Allowance(maxUint256);
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
