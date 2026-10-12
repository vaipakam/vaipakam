/** The fee-entitlement kill-switch, flipped as the testnet admin on the fork.
 *  Shared by the Full-tariff specs (24 — the acceptor; 37 — the signed-order
 *  maker, #1949): the switch is chain-global, so each spec restores it in a
 *  `finally`. Enabling requires the canonical-VPFI stamp; the deploy sets it on
 *  Base Sepolia, but a fork is asserted, not assumed. */
import { encodeFunctionData } from 'viem';
import { anvilRpc, setBalance } from './anvil';
import { pub, ADMIN, DIAMOND, DIAMOND_ABI_VIEM } from './chain';

export async function setFeeEntitlementEnabled(enabled: boolean): Promise<void> {
  await anvilRpc('anvil_impersonateAccount', [ADMIN]);
  await setBalance(ADMIN, 10n ** 18n);
  const send = async (fn: string, args: readonly unknown[]) => {
    const data = encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName: fn,
      args: args as unknown[],
    });
    const hash = await anvilRpc<`0x${string}`>('eth_sendTransaction', [
      { from: ADMIN, to: DIAMOND, data, gas: '0x2dc6c0' },
    ]);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`${fn} reverted`);
    }
  };
  try {
    if (enabled) {
      try {
        await send('setFeeEntitlementEnabled', [true]);
      } catch {
        await send('setCanonicalVPFIChain', [true]);
        await send('setFeeEntitlementEnabled', [true]);
      }
    } else {
      await send('setFeeEntitlementEnabled', [false]);
    }
  } finally {
    await anvilRpc('anvil_stopImpersonatingAccount', [ADMIN]);
  }
}
