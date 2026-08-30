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
  // Optional deadline. Omitted everywhere except the fork probe, whose
  // call is the one that reaches THROUGH anvil to the upstream and can
  // therefore hang on something we do not control.
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = opts.timeoutMs === undefined ? null : new AbortController();
  const timer =
    ctrl === null ? null : setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(ANVIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    // Read the body inside the deadline: headers can arrive in time while
    // the body stalls, and a `json()` after `clearTimeout` would hang with
    // no timer left to cut it.
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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

/**
 * The probe's own deadline expiring. A distinct CLASS rather than a
 * message match, because "timed out" is a phrase far too generic to put
 * in the regex above without making the classifier permissive — and the
 * permissive direction is the one that launders real failures into
 * retries.
 */
export class ForkProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `fork state probe got no answer within ${timeoutMs}ms — the fork ` +
        `RPC did not serve state for anvil's base block`,
    );
    this.name = 'ForkProbeTimeoutError';
  }
}

export function isForkUnusableError(e: unknown): boolean {
  if (e instanceof ForkProbeTimeoutError) return true;
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
 *
 * BOUNDED, unlike the RPCs around it. This is the only call in the
 * harness that reaches THROUGH anvil to a service we do not control, so
 * it is the only one that can hang on someone else's outage. Without a
 * deadline it would replace a red run with a job that sits until
 * Playwright's own timeout kills it and reports nothing useful — and it
 * sits on the critical path of every fork-tier run.
 */
export const FORK_PROBE_TIMEOUT_MS = 30_000;

export async function assertForkUsable(
  timeoutMs = FORK_PROBE_TIMEOUT_MS,
): Promise<void> {
  try {
    await anvilRpc<string>(
      'eth_getBalance',
      ['0x000000000000000000000000000000000000dEaD', 'latest'],
      { timeoutMs },
    );
  } catch (e) {
    // An abort is OUR deadline, not an answer — re-thrown as its own
    // class so the caller can retry it without the classifier having to
    // match on a generic phrase.
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ForkProbeTimeoutError(timeoutMs);
    }
    throw e;
  }
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
