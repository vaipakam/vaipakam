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

/** Open the More sheet when the page folds the navigation into it (phone
 *  width), so a spec can reach the primary navigation and the mode control
 *  on either device. */
export async function openMenu(page: Page): Promise<void> {
  const more = page.getByRole('navigation', { name: 'Quick access' }).getByRole('button', { name: 'More' });
  if (await more.isVisible()) await more.click();
}

/** True when this run's project is the phone one. */
export function onPhone(projectName: string): boolean {
  return projectName === 'phone';
}

export const test = walletTest<Role>({
  chainId: CHAIN_ID,
  rpcUrl: ANVIL_URL,
  accountFor,
  rpc: (method, params) => anvilRpc(method, params),
  advancedModeStorage: { 'app.mode': 'advanced' },
  // Every spec runs on the desktop AND the phone project (playwright.config).
  deviceFromProject: true,
});
