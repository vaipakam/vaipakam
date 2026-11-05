/**
 * Injected-wallet Playwright fixture, bound to THIS suite's chain. The
 * fixture itself (the EIP-1193 + EIP-6963 provider whose signing and RPC
 * happen in the Playwright process via viem against the local anvil, the
 * per-session flags, the connect helper and the `launchWallet` test
 * extension) is `@vaipakam/e2e-wallet`, shared with apps/alpha05's tier;
 * this module only tells it which chain, which RPC and which wallet roster.
 *
 * `launchWallet(role)` returns an independent context+page, so one test can
 * drive multiple actors (poster + acceptor, seller + buyer).
 */
import { connectWallet as connectWalletShared, walletTest } from '@vaipakam/e2e-wallet';
import type { Page } from '@playwright/test';
import { ANVIL_URL, anvilRpc } from './anvil';
import { CHAIN_ID } from './chain';
import { accountFor, type Role } from './wallets';

export type { WalletFlags, WalletSession } from '@vaipakam/e2e-wallet';
export { expect } from '@vaipakam/e2e-wallet';

/** Ensure the wallet is connected (see the shared helper for the race it
 *  tolerates). This app's connect control reads "Connect wallet". */
export function connectWallet(page: Page): Promise<void> {
  return connectWalletShared(page, /^connect wallet$/i);
}

export const test = walletTest<Role>({
  chainId: CHAIN_ID,
  rpcUrl: ANVIL_URL,
  accountFor,
  // Reads forward through the harness control, which refuses a non-loopback
  // URL, so the wallet can never read a live chain by misconfiguration.
  rpc: (method, params) => anvilRpc(method, params),
  advancedModeStorage: { 'app.mode': 'advanced' },
});
