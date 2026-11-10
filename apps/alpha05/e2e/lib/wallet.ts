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

/**
 * Every test runs on the chain as the suite's setup left it, and leaves it
 * that way (#3482). The suite shares one node, so this is the one place the
 * isolation lives: a snapshot before each test (before any page opens) and,
 * after it, whatever the outcome, a revert to that snapshot. A test that
 * fails part-way, or an attempt that is retried, therefore leaves no minted
 * token, allowance or offer behind for a later spec to trip over.
 *
 * A revert leaves the head at the snapshot's timestamp, as old as the test
 * took, while the next block mines at the wall clock. A write estimated in
 * that stale environment can mine short of gas on a call whose cost grows
 * with elapsed time (interest accrues per second) and revert. So a block is
 * mined at once, bringing the head to the present.
 *
 * A spec may still take its own snapshot inside a test, to undo a step and
 * go on; the fixture's revert covers it.
 */
export const test = walletTest<Role>({
  chainId: CHAIN_ID,
  rpcUrl: ANVIL_URL,
  accountFor,
  rpc: (method, params) => anvilRpc(method, params),
  advancedModeStorage: { 'app.mode': 'advanced' },
  // Every spec runs on the desktop AND the phone project (playwright.config).
  deviceFromProject: true,
}).extend<{ chainIsolation: void }>({
  chainIsolation: [
    async ({}, use) => {
      const snapshot = await anvilRpc<string>('evm_snapshot');
      try {
        await use();
      } finally {
        const reverted = await anvilRpc<boolean>('evm_revert', [snapshot]);
        await anvilRpc('evm_mine');
        if (reverted !== true) throw new Error(`the chain could not be put back after this test (snapshot ${snapshot})`);
      }
    },
    { auto: true },
  ],
});
