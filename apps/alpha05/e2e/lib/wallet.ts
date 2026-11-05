/**
 * The injected-wallet fixture (`@vaipakam/e2e-wallet`) bound to this
 * suite's chain, node and roster. Specs import `test` and `expect` from
 * here. The app's connect control reads "Connect wallet".
 */
import { connectWallet as connectWalletShared, walletTest } from '@vaipakam/e2e-wallet';
import type { Page } from '@playwright/test';
import { E2E_CHAIN_ID } from '@vaipakam/anvil-harness/fixture';
import { ANVIL_URL, anvilRpc } from './anvil';
import { accountFor, type Role } from './wallets';

export type { WalletFlags, WalletSession } from '@vaipakam/e2e-wallet';
export { expect } from '@vaipakam/e2e-wallet';

export const CHAIN_ID = E2E_CHAIN_ID;

export function connectWallet(page: Page): Promise<void> {
  return connectWalletShared(page, /^connect wallet$/i);
}

export const test = walletTest<Role>({
  chainId: CHAIN_ID,
  rpcUrl: ANVIL_URL,
  accountFor,
  rpc: (method, params) => anvilRpc(method, params),
  advancedModeStorage: { 'app.mode': 'advanced' },
});
