/**
 * What the read-only RPC proxy (`apps/rpc-proxy`, #1724) forwards, stated
 * once for the two sides that must agree on it.
 *
 * The connected app used to put each chain's keyed provider URL into the
 * browser bundle (`VITE_*_RPC_URL`), so anyone could lift the key and spend
 * the plan behind it. The proxy holds the keys as Worker secrets instead and
 * forwards only the reads the app makes. Two parties read this module:
 *
 *   - the Worker, which refuses anything outside it;
 *   - the app, which sizes its JSON-RPC batches and its log windows to fit
 *     inside it, so a well-formed app request is never refused for shape.
 *
 * Nothing here can move funds or sign: the proxy is READ-ONLY by
 * construction. `eth_sendRawTransaction` is deliberately absent, because the
 * app sends every transaction through the user's own wallet provider, never
 * through a public read client.
 */

/** The chains the proxy serves, each with the Secrets Store name that holds
 *  its upstream URL. The keys are DEDICATED to the proxy, never the
 *  keeper's or indexer's `RPC_*` entries, so browser traffic cannot spend
 *  the quota the keeper needs to liquidate on time. The set matches the
 *  chains the app has RPC configuration for (`apps/app/src/lib/endpoints.ts`,
 *  pinned by a test there). */
export const RPC_PROXY_CHAINS: Readonly<Record<number, string>> = {
  1: 'RPC_PROXY_ETH',
  8453: 'RPC_PROXY_BASE',
  42161: 'RPC_PROXY_ARB',
  10: 'RPC_PROXY_OP',
  56: 'RPC_PROXY_BNB',
  84532: 'RPC_PROXY_BASE_SEPOLIA',
  421614: 'RPC_PROXY_ARB_SEPOLIA',
  97: 'RPC_PROXY_BNB_TESTNET',
};

/** Most calls in one JSON-RPC batch. The app's batching transport is sized
 *  to this, so a batch it builds is never refused for length. */
export const RPC_PROXY_MAX_BATCH = 50;

/** Widest `eth_getLogs` range, in blocks, inclusive of both ends. The app's
 *  log scans walk narrower windows (pinned by a test in the app). */
export const RPC_PROXY_MAX_LOG_RANGE_BLOCKS = 2000;

/** Most addresses one `eth_getLogs` filter may name. */
export const RPC_PROXY_MAX_LOG_ADDRESSES = 10;

/** Largest request body the proxy reads. */
export const RPC_PROXY_MAX_BODY_BYTES = 256 * 1024;

/**
 * The methods the proxy forwards: the reads the app's public clients make,
 * and the fee and nonce reads a transaction's preparation may make. Each is
 * a read of chain state. A method outside this set is refused per call with
 * JSON-RPC code -32601, which the app's transport treats as "try the next
 * endpoint".
 */
export const RPC_PROXY_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
]);

/** Whether one call may be forwarded, and if not, the JSON-RPC error. */
export type RpcCallCheck = { ok: true } | { ok: false; code: number; message: string };

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

function invalidParams(message: string): RpcCallCheck {
  return { ok: false, code: -32602, message };
}

/**
 * The `eth_getLogs` rule. A filter must name its contract(s) and either one
 * block hash or a numeric range no wider than the cap. Tags such as
 * `latest` are refused because the width of a tagged range cannot be known
 * without another call, and an unbounded log scan is the one read that can
 * cost a provider plan in a single request.
 */
function checkGetLogs(params: unknown): RpcCallCheck {
  if (!Array.isArray(params) || params.length !== 1) return invalidParams('eth_getLogs takes one filter');
  const f = params[0] as Record<string, unknown> | null;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return invalidParams('filter must be an object');
  const addresses = Array.isArray(f.address) ? f.address : [f.address];
  if (
    addresses.length === 0 ||
    addresses.length > RPC_PROXY_MAX_LOG_ADDRESSES ||
    !addresses.every((a) => typeof a === 'string' && ADDRESS.test(a))
  ) {
    return invalidParams(`filter must name 1 to ${RPC_PROXY_MAX_LOG_ADDRESSES} contract addresses`);
  }
  if (f.blockHash !== undefined) {
    if (typeof f.blockHash !== 'string' || !HASH.test(f.blockHash)) return invalidParams('blockHash must be a hash');
    if (f.fromBlock !== undefined || f.toBlock !== undefined) {
      return invalidParams('blockHash cannot be combined with a block range');
    }
    return { ok: true };
  }
  const { fromBlock, toBlock } = f;
  if (typeof fromBlock !== 'string' || typeof toBlock !== 'string' || !QUANTITY.test(fromBlock) || !QUANTITY.test(toBlock)) {
    return invalidParams('fromBlock and toBlock must both be block numbers (tags are not accepted)');
  }
  const from = BigInt(fromBlock);
  const to = BigInt(toBlock);
  if (to < from) return invalidParams('toBlock is before fromBlock');
  if (to - from + 1n > BigInt(RPC_PROXY_MAX_LOG_RANGE_BLOCKS)) {
    return invalidParams(`block range is wider than ${RPC_PROXY_MAX_LOG_RANGE_BLOCKS} blocks`);
  }
  return { ok: true };
}

/** Check one call's method and, where the method needs it, its params. */
export function checkRpcCall(method: string, params: unknown): RpcCallCheck {
  if (!RPC_PROXY_METHODS.has(method)) {
    return { ok: false, code: -32601, message: 'method not served by this proxy' };
  }
  if (method === 'eth_getLogs') return checkGetLogs(params);
  return { ok: true };
}
