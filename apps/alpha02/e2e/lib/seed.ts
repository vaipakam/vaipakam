/**
 * Fork-state seeding — direct contract calls (not UI) that give every
 * ephemeral role wallet the assets the scenarios spend: wrapped WETH
 * for lender-side principal and faucet tLIQ for borrower-side
 * collateral. Scenarios that TEST minting still drive the faucet UI;
 * this just guarantees preconditions without coupling tests together.
 */
import { parseEther, parseUnits } from 'viem';
import { ERC20_MIN_ABI, MOCKS, WETH, forkChain, pub, walletFor } from './chain';
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
    await pub.waitForTransactionReceipt({ hash: h1 });
    // 100,000 tLIQ each (collateral side; faucet token mint is open).
    const h2 = await wallet.writeContract({
      address: MOCKS!.liquidToken as `0x${string}`,
      abi: ERC20_MIN_ABI,
      functionName: 'mint',
      args: [account.address, parseUnits('100000', 18)],
      account,
      chain: forkChain,
    });
    await pub.waitForTransactionReceipt({ hash: h2 });
  }
}
