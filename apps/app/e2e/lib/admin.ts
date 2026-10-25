/** Diamond writes as the deployment admin, on the e2e chain only.
 *
 *  The one place a spec changes protocol configuration. Each write
 *  impersonates the admin the fixture deployed with, sends one transaction
 *  and confirms it, so a refused write fails the spec with its revert
 *  reason (`confirm`) instead of leaving every later assertion testing a
 *  configuration that was never set. Configuration is chain-global: a spec
 *  that changes it restores what it read, in a `finally`. */
import { encodeFunctionData } from 'viem';
import { anvilRpc, setBalance } from './anvil';
import { ADMIN, DIAMOND, DIAMOND_ABI_VIEM, confirm } from './chain';

export async function sendAsAdmin(
  functionName: string,
  args: readonly unknown[] = [],
): Promise<void> {
  await setBalance(ADMIN, 10n ** 18n);
  await anvilRpc('anvil_impersonateAccount', [ADMIN]);
  try {
    const data = encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName,
      args: args as unknown[],
    });
    const hash = await anvilRpc<`0x${string}`>('eth_sendTransaction', [
      { from: ADMIN, to: DIAMOND, data, gas: '0x2dc6c0' },
    ]);
    await confirm(hash, `${functionName} (as admin)`);
  } finally {
    await anvilRpc('anvil_stopImpersonatingAccount', [ADMIN]);
  }
}
