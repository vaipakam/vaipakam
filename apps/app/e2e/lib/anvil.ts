/**
 * Anvil control plane for the fork tier. The suite runs against
 * `anvil --fork-url <base-sepolia> --chain-id 84532` — the REAL
 * deployed Diamond and its live state, but disposable and
 * time-travelable. Everything here talks raw JSON-RPC so no wallet
 * or chain config is needed for control operations.
 */

export const ANVIL_URL = process.env.APP_E2E_ANVIL_URL ?? 'http://127.0.0.1:8545';

let rpcId = 1;

export async function anvilRpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Fund an address with native ETH (hex-quantity wei). */
export async function setBalance(address: string, wei: bigint): Promise<void> {
  await anvilRpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
}

/** Advance chain time and mine a block so view functions see it.
 *  This is what makes cancel cooldowns (300 s), maturities, and grace
 *  windows testable in seconds. */
export async function increaseTime(seconds: number): Promise<void> {
  await anvilRpc('evm_increaseTime', [seconds]);
  await anvilRpc('evm_mine', []);
}

export async function mine(blocks = 1): Promise<void> {
  for (let i = 0; i < blocks; i++) await anvilRpc('evm_mine', []);
}

/**
 * Errors that mean the FORK BACKEND could not serve state for the block
 * anvil forked at — as opposed to anvil itself being broken (#1979).
 * The upstream pruned or reorged the head between anvil's genesis and
 * the first state read, or a fallback endpoint in the pool never had
 * it. Transient by nature: a fresh anvil picks a new head.
 */
const FORK_UNUSABLE_RE = /unknown block|block could not be found|header not found/i;

export function isForkUnusableError(e: unknown): boolean {
  return FORK_UNUSABLE_RE.test(e instanceof Error ? e.message : String(e));
}

/**
 * Prove the fork is USABLE, not merely listening (#1979).
 *
 * `waitForAnvil` answers "is anvil up?" — `eth_chainId` is served from
 * anvil's own config and never touches the upstream. But anvil forks
 * LAZILY: it accepts RPC immediately and fetches account state on
 * demand. So a fork whose base block the upstream can no longer serve
 * is up, ready, and unusable, and the failure surfaces at the first
 * state read — which used to be `setBalance` in `createAndFundWallets`,
 * far past every retry branch in global-setup.
 *
 * This is that first state read, pulled forward to where the retry can
 * still act on it. `eth_getBalance` against the fork's parent state is
 * the cheapest call that must reach the upstream; the address is
 * arbitrary (a nonexistent account still forces the lookup).
 *
 * Throws the underlying error unchanged — the caller classifies it with
 * `isForkUnusableError`, so a genuine bug is never swallowed as a flake.
 */
export async function assertForkUsable(): Promise<void> {
  await anvilRpc<string>('eth_getBalance', [
    '0x000000000000000000000000000000000000dEaD',
    'latest',
  ]);
}

/** Wait until anvil answers with the expected fork chain id. */
export async function waitForAnvil(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const id = await anvilRpc<string>('eth_chainId');
      if (Number(id) === 84532) return;
      lastErr = new Error(`unexpected chainId ${id}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`anvil not ready at ${ANVIL_URL}: ${String(lastErr)}`);
}
