/**
 * Anvil control plane for the e2e tier. The suite runs against a bare
 * anvil carrying the repository's CURRENT contracts, deployed from source
 * by global setup and presented as Base Sepolia (#2334; `fixture.ts`) —
 * disposable, deterministic and time-travelable. Everything here talks raw
 * JSON-RPC so no wallet or chain config is needed for control operations.
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
 * Has the spawned anvil already exited? (#2019 round 1 P2.)
 *
 * The answer decides whether its PID stays in `pids.json` for teardown
 * to kill, and getting it wrong in the "already dead" direction means
 * signalling a number the OS may have REASSIGNED to an unrelated
 * process. So it errs deliberately toward "still running": Node sets
 * these fields when it processes the exit event, and a process that has
 * died without that event yet reads as running here — teardown then
 * signals a stale PID and catches ESRCH, which is the harmless outcome.
 * The opposite mistake is not harmless.
 */
export function childHasExited(child: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait until anvil answers with `chainId`. */
export async function waitForAnvil(chainId: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const id = await anvilRpc<string>('eth_chainId');
      if (Number(id) === chainId) return;
      lastErr = new Error(`unexpected chainId ${id}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`anvil not ready at ${ANVIL_URL}: ${String(lastErr)}`);
}
