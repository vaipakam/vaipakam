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
  /** Wait until the node answers `eth_chainId` with `chainId`. */
  waitForChainId(chainId: number, timeoutMs?: number): Promise<void>;
}

export function anvilControl(url: string): AnvilControl {
  let rpcId = 1;
  const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
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
    async waitForChainId(chainId, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown = null;
      while (Date.now() < deadline) {
        try {
          const id = await rpc<string>('eth_chainId');
          if (Number(id) === chainId) return;
          lastErr = new Error(`unexpected chainId ${id}`);
        } catch (e) {
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`anvil not ready at ${url}: ${String(lastErr)}`);
    },
  };
}
