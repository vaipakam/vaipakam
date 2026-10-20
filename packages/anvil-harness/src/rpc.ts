/**
 * JSON-RPC control of a local anvil node — the operations a test drives that
 * no wallet or chain config is needed for: balances, code and storage, time
 * travel, mining, chain-id switching and state dumps.
 *
 * One {@link AnvilControl} per node URL. The connected app's e2e tier binds
 * one to its single anvil (`apps/app/e2e/lib/anvil.ts`); the keeper's Anvil
 * scenarios bind one per scenario chain.
 */

export interface AnvilControl {
  /** The node this controls. */
  readonly url: string;
  /** A raw JSON-RPC call; an RPC error is thrown with the method's name. */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Fund an address with native ETH. */
  setBalance(address: string, wei: bigint): Promise<void>;
  /** Advance chain time by `seconds` and mine a block, so view functions see it. */
  increaseTime(seconds: number): Promise<void>;
  /** Mine `blocks` blocks. */
  mine(blocks?: number): Promise<void>;
  /** The latest block's timestamp, in unix seconds. */
  latestTimestamp(): Promise<number>;
  /** Wait until the node answers `eth_chainId` with `chainId`. `cancel`
   *  stops the wait (rejecting) as soon as it aborts. */
  waitForChainId(chainId: number, timeoutMs?: number, cancel?: AbortSignal): Promise<void>;
}

/** The longest a single readiness probe may wait for an answer. */
const PROBE_TIMEOUT_MS = 2_000;

/** The hosts a disposable node may be reached on: this machine only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Refuse any node URL that is not on this machine. The harness sends state a
 * fixture read from disk (a `--load-state` dump, `anvil_setCode` bytecode) and
 * time-travel and balance commands that only make sense against a disposable
 * local node, so a URL elsewhere is a misconfiguration, never a target.
 */
export function assertLoopbackUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`anvil-harness: not a URL: ${url}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`anvil-harness: refusing ${url}: the harness drives only a local node (127.0.0.1, localhost or ::1)`);
  }
}

/** Where a disposable local node listens, in the one form both anvil and its
 *  clients read the same way. */
export interface LocalEndpoint {
  /** The URL every client uses: the bind address and the port, written out. */
  url: string;
  /** The bare IP address anvil binds (`--host` takes an IP, not a hostname). */
  host: '127.0.0.1' | '::1';
  port: number;
}

/**
 * Read a node URL into the address anvil binds and the URL clients reach it
 * on, so the two can never disagree (Codex #2604 r6, r8). A URL and anvil read
 * the same text differently in three ways, and each one used to leave a
 * healthy node unreachable by its own readiness probe:
 *
 *   - IPv6 is bracketed in a URL (`[::1]`) and bare for anvil;
 *   - `localhost` is a hostname, which anvil refuses, and which a client may
 *     resolve to either loopback family — so it is pinned to `127.0.0.1`;
 *   - an omitted port is the scheme's default (80) for a client and 8545 for
 *     anvil, and `URL` erases an explicitly written default the same way — so
 *     the port must be written, and not as the default.
 *
 * Refuses anything off this machine first ({@link assertLoopbackUrl}).
 */
export function localEndpoint(url: string): LocalEndpoint {
  assertLoopbackUrl(url);
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`anvil-harness: refusing ${url}: a local node is reached over plain http`);
  if (u.port === '') {
    throw new Error(
      `anvil-harness: refusing ${url}: name the node's port explicitly, and not 80 — without one, a client reads port 80 and anvil listens on 8545`,
    );
  }
  const host = u.hostname === '[::1]' || u.hostname === '::1' ? '::1' : '127.0.0.1';
  const port = Number(u.port);
  return { url: `http://${host === '::1' ? '[::1]' : host}:${port}`, host, port };
}

export function anvilControl(url: string): AnvilControl {
  assertLoopbackUrl(url);
  let rpcId = 1;
  const call = async <T = unknown>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal,
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
  const rpc = <T = unknown>(method: string, params: unknown[] = []): Promise<T> => call<T>(method, params);
  return {
    url,
    rpc,
    async setBalance(address, wei) {
      await rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
    },
    async increaseTime(seconds) {
      await rpc('evm_increaseTime', [seconds]);
      await rpc('evm_mine', []);
    },
    async mine(blocks = 1) {
      for (let i = 0; i < blocks; i++) await rpc('evm_mine', []);
    },
    async latestTimestamp() {
      const block = await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
      return Number(BigInt(block.timestamp));
    },
    async waitForChainId(chainId, timeoutMs = 60_000, cancel) {
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown = null;
      while (Date.now() < deadline) {
        if (cancel?.aborted) throw new Error(`stopped waiting for anvil at ${url}`);
        try {
          // Each probe is bounded by what is left of the deadline (Codex #2604
          // r3): a node that accepts the connection and never answers would
          // otherwise hold the loop past it, and the caller's cleanup with it.
          const bound = AbortSignal.timeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())));
          const probe = cancel ? AbortSignal.any([bound, cancel]) : bound;
          const id = await call<string>('eth_chainId', [], probe);
          if (Number(id) === chainId) return;
          lastErr = new Error(`unexpected chainId ${id}`);
        } catch (e) {
          lastErr = e;
        }
        if (cancel?.aborted) throw new Error(`stopped waiting for anvil at ${url}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`anvil not ready at ${url}: ${String(lastErr)}`);
    },
  };
}
