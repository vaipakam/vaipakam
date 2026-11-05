/**
 * The suite's one Anvil node: the harness control bound to its URL. Its
 * port differs from apps/app's (8545) so the two suites can run side by
 * side on one machine.
 */
import { anvilControl } from '@vaipakam/anvil-harness/rpc';

export const ANVIL_URL = process.env.ALPHA05_E2E_ANVIL_URL ?? 'http://127.0.0.1:8546';

const control = anvilControl(ANVIL_URL);

export function anvilRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return control.rpc<T>(method, params);
}

export async function setBalance(address: string, wei: bigint): Promise<void> {
  await control.setBalance(address, wei);
}

export async function increaseTime(seconds: number): Promise<void> {
  await control.increaseTime(seconds);
}

export async function mine(blocks = 1): Promise<void> {
  await control.mine(blocks);
}
