/**
 * Fork-state seeding — direct contract calls (not UI) that give every
 * ephemeral role wallet the assets the scenarios spend: wrapped WETH
 * for lender-side principal and faucet tLIQ for borrower-side
 * collateral. Scenarios that TEST minting still drive the faucet UI;
 * this just guarantees preconditions without coupling tests together.
 */
import { parseEther, parseUnits } from 'viem';
import { confirm, ERC20_MIN_ABI, MOCKS, WETH, forkChain, pub, walletFor } from './chain';
import { accountFor, ROLES } from './wallets';

export async function seedRoleAssets(): Promise<void> {
  for (const role of ROLES) {
    const account = accountFor(role);
    const wallet = walletFor(account);
    // 1 WETH each (principal side).
    const h1 = await wallet.writeContract({
      address: WETH,
      abi: ERC20_MIN_ABI,
      functionName: 'deposit',
      value: parseEther('1'),
      account,
      chain: forkChain,
    });
    await confirm(h1, 'deposit (WETH seeding)');
    // 100,000 tLIQ each (collateral side; faucet token mint is open).
    const h2 = await wallet.writeContract({
      address: MOCKS!.liquidToken as `0x${string}`,
      abi: ERC20_MIN_ABI,
      functionName: 'mint',
      args: [account.address, parseUnits('100000', 18)],
      account,
      chain: forkChain,
    });
    await confirm(h2, 'mint (ERC-20 seeding)');
  }
}

/** Wrap `amountEth` more WETH for one role, for a spec whose wallets the
 *  serial suite may already have spent from: the one-time seed above is 1
 *  WETH per role, and earlier specs leave some of it in loans that stay
 *  open. A spec that needs a known balance tops it up itself rather than
 *  relying on what earlier specs left. */
export async function topUpWeth(role: (typeof ROLES)[number], amountEth: string): Promise<void> {
  const account = accountFor(role);
  const hash = await walletFor(account).writeContract({
    address: WETH,
    abi: ERC20_MIN_ABI,
    functionName: 'deposit',
    value: parseEther(amountEth),
    account,
    chain: forkChain,
  });
  await confirm(hash, 'deposit (WETH top-up)');
}

/** Make sure `role`'s WALLET holds at least `amountWei` of WETH, wrapping
 *  only the shortfall (nothing when it already does).
 *
 *  The one-time seed above is 1 WETH per role, and the serial suite spends
 *  it: loans that stay open hold principal, and since #3387 a loan claim and
 *  a new loan's net principal are credited to the payee's VAULT, not its
 *  wallet, so a role's wallet no longer refills as the suite goes. Any step
 *  that pulls WETH from a wallet (an offer's escrowed leg, a buy) calls this
 *  first, so whether it can pay never depends on which specs ran, or
 *  retried, before it. */
export async function ensureWeth(role: (typeof ROLES)[number], amountWei: bigint): Promise<void> {
  const account = accountFor(role);
  const held = (await pub.readContract({
    address: WETH,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  if (held >= amountWei) return;
  const hash = await walletFor(account).writeContract({
    address: WETH,
    abi: ERC20_MIN_ABI,
    functionName: 'deposit',
    value: amountWei - held,
    account,
    chain: forkChain,
  });
  await confirm(hash, 'deposit (WETH shortfall)');
}
