/**
 * Anvil control plane for the e2e tier. The suite runs against a bare
 * anvil carrying the repository's CURRENT contracts, deployed from source
 * by global setup and presented as Base Sepolia (#2334; `fixture.ts`) —
 * disposable, deterministic and time-travelable. Everything here talks raw
 * JSON-RPC so no wallet or chain config is needed for control operations.
 *
 * The control itself lives in `@vaipakam/anvil-harness`, shared with the
 * keeper's Anvil scenarios; this module binds it to the suite's one node.
 */
import { anvilControl } from '@vaipakam/anvil-harness/rpc';

export { childHasExited } from '@vaipakam/anvil-harness/process';

export const ANVIL_URL = process.env.APP_E2E_ANVIL_URL ?? 'http://127.0.0.1:8545';

const control = anvilControl(ANVIL_URL);

export function anvilRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return control.rpc<T>(method, params);
}

/** Fund an address with native ETH (hex-quantity wei). */
export async function setBalance(address: string, wei: bigint): Promise<void> {
  await control.setBalance(address, wei);
}

/** Advance chain time and mine a block so view functions see it.
 *  This is what makes cancel cooldowns (300 s), maturities, and grace
 *  windows testable in seconds. */
export async function increaseTime(seconds: number): Promise<void> {
  await control.increaseTime(seconds);
}

export async function mine(blocks = 1): Promise<void> {
  await control.mine(blocks);
}

/** Wait until anvil answers with `chainId`. */
export async function waitForAnvil(chainId: number, timeoutMs = 60_000): Promise<void> {
  await control.waitForChainId(chainId, timeoutMs);
}
