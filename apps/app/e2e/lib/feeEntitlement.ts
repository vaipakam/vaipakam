/** The fee-entitlement kill-switch, flipped as the testnet admin on the fork.
 *  Shared by the Full-tariff specs (24 — the acceptor; 37 — the signed-order
 *  maker, #1949): the switch is chain-global, so each spec restores it in a
 *  `finally`. Enabling requires the canonical-VPFI stamp; the deploy sets it on
 *  Base Sepolia, but a fork is asserted, not assumed. */
import { sendAsAdmin } from './admin';

export async function setFeeEntitlementEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    await sendAsAdmin('setFeeEntitlementEnabled', [false]);
    return;
  }
  try {
    await sendAsAdmin('setFeeEntitlementEnabled', [true]);
  } catch {
    await sendAsAdmin('setCanonicalVPFIChain', [true]);
    await sendAsAdmin('setFeeEntitlementEnabled', [true]);
  }
}
