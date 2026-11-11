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

/** The block tags a block parameter may name. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(['latest', 'earliest', 'pending', 'safe', 'finalized']);

/** A storage slot: up to 32 bytes of hex. */
const SLOT = /^0x[0-9a-f]{1,64}$/i;

/** Most blocks one `eth_feeHistory` call may ask about. The app does not
 *  call it; a wallet's fee estimate asks for a handful. */
export const RPC_PROXY_MAX_FEE_HISTORY_BLOCKS = 100;

/** Most reward percentiles one `eth_feeHistory` call may ask for. */
export const RPC_PROXY_MAX_FEE_HISTORY_PERCENTILES = 10;

/** Whether `v` is a block parameter: a tag, a block number, or the
 *  EIP-1898 object naming one block by hash or number. */
function isBlockParam(v: unknown): boolean {
  if (typeof v === 'string') return BLOCK_TAGS.has(v) || QUANTITY.test(v) || HASH.test(v);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => k !== 'blockHash' && k !== 'blockNumber' && k !== 'requireCanonical')) return false;
  if (o.requireCanonical !== undefined && typeof o.requireCanonical !== 'boolean') return false;
  if (o.blockHash !== undefined) return o.blockNumber === undefined && typeof o.blockHash === 'string' && HASH.test(o.blockHash);
  return typeof o.blockNumber === 'string' && (BLOCK_TAGS.has(o.blockNumber) || QUANTITY.test(o.blockNumber));
}

/** The params as an array of `min` to `max` entries, or `null`. An absent
 *  `params` reads as no params. */
function paramList(params: unknown, min: number, max: number): unknown[] | null {
  const list = params === undefined ? [] : params;
  if (!Array.isArray(list) || list.length < min || list.length > max) return null;
  return list;
}

/** `eth_call` / `eth_estimateGas`: one transaction object and an optional
 *  block. A third parameter (a state override) is refused: it lets one call
 *  replace any account's code and storage, which is a simulation service,
 *  not a read of chain state, and the app never sends one. */
function checkCallLike(method: string, params: unknown): RpcCallCheck {
  const list = paramList(params, 1, 2);
  if (list === null) return invalidParams(`${method} takes a transaction and an optional block (no state override)`);
  const tx = list[0];
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) return invalidParams('the transaction must be an object');
  if (list.length === 2 && !isBlockParam(list[1])) return invalidParams('the block must be a tag, a number or a hash');
  return { ok: true };
}

/** `[address, block?]`, and for `eth_getStorageAt` `[address, slot, block?]`. */
function checkAccountRead(method: string, params: unknown): RpcCallCheck {
  const withSlot = method === 'eth_getStorageAt';
  const list = paramList(params, withSlot ? 2 : 1, withSlot ? 3 : 2);
  if (list === null) return invalidParams(`${method} takes an address${withSlot ? ', a slot' : ''} and an optional block`);
  if (typeof list[0] !== 'string' || !ADDRESS.test(list[0])) return invalidParams('the address must be 20 bytes of hex');
  if (withSlot && (typeof list[1] !== 'string' || !SLOT.test(list[1]))) return invalidParams('the slot must be up to 32 bytes of hex');
  const block = list[withSlot ? 2 : 1];
  if (block !== undefined && !isBlockParam(block)) return invalidParams('the block must be a tag, a number or a hash');
  return { ok: true };
}

/** `eth_getBlockByNumber` / `eth_getBlockByHash`: the block and whether to
 *  include whole transactions. */
function checkBlockRead(method: string, params: unknown): RpcCallCheck {
  const list = paramList(params, 2, 2);
  if (list === null || typeof list[1] !== 'boolean') return invalidParams(`${method} takes a block and a boolean`);
  const ok =
    method === 'eth_getBlockByHash'
      ? typeof list[0] === 'string' && HASH.test(list[0])
      : typeof list[0] === 'string' && (BLOCK_TAGS.has(list[0]) || QUANTITY.test(list[0]));
  return ok ? { ok: true } : invalidParams(method === 'eth_getBlockByHash' ? 'the block must be a hash' : 'the block must be a tag or a number');
}

/** `eth_feeHistory`: a bounded block count, the newest block, and at most a
 *  few percentiles. */
function checkFeeHistory(params: unknown): RpcCallCheck {
  const list = paramList(params, 2, 3);
  if (list === null) return invalidParams('eth_feeHistory takes a block count, the newest block and optional percentiles');
  const [count, newest, percentiles] = list;
  const n =
    typeof count === 'number' && Number.isInteger(count)
      ? count
      : typeof count === 'string' && QUANTITY.test(count)
        ? Number(BigInt(count))
        : NaN;
  if (!(n >= 1 && n <= RPC_PROXY_MAX_FEE_HISTORY_BLOCKS)) {
    return invalidParams(`the block count must be 1 to ${RPC_PROXY_MAX_FEE_HISTORY_BLOCKS}`);
  }
  if (typeof newest !== 'string' || !(BLOCK_TAGS.has(newest) || QUANTITY.test(newest))) {
    return invalidParams('the newest block must be a tag or a number');
  }
  if (
    percentiles !== undefined &&
    (!Array.isArray(percentiles) ||
      percentiles.length > RPC_PROXY_MAX_FEE_HISTORY_PERCENTILES ||
      !percentiles.every((p) => typeof p === 'number' && p >= 0 && p <= 100))
  ) {
    return invalidParams(`at most ${RPC_PROXY_MAX_FEE_HISTORY_PERCENTILES} percentiles, each 0 to 100`);
  }
  return { ok: true };
}

/** One transaction hash. */
function checkTxHash(method: string, params: unknown): RpcCallCheck {
  const list = paramList(params, 1, 1);
  return list !== null && typeof list[0] === 'string' && HASH.test(list[0])
    ? { ok: true }
    : invalidParams(`${method} takes one transaction hash`);
}

/** A method that takes no params. */
function checkNoParams(method: string, params: unknown): RpcCallCheck {
  return paramList(params, 0, 0) !== null ? { ok: true } : invalidParams(`${method} takes no params`);
}

/**
 * Check one call's method and its params. Every method the proxy serves
 * has a stated shape (#1283): a call outside it is refused with -32602 here
 * rather than forwarded, so the provider is only ever asked the bounded
 * question the app itself asks.
 */
export function checkRpcCall(method: string, params: unknown): RpcCallCheck {
  if (!RPC_PROXY_METHODS.has(method)) {
    return { ok: false, code: -32601, message: 'method not served by this proxy' };
  }
  switch (method) {
    case 'eth_getLogs':
      return checkGetLogs(params);
    case 'eth_call':
    case 'eth_estimateGas':
      return checkCallLike(method, params);
    case 'eth_getBalance':
    case 'eth_getCode':
    case 'eth_getTransactionCount':
    case 'eth_getStorageAt':
      return checkAccountRead(method, params);
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return checkBlockRead(method, params);
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
      return checkTxHash(method, params);
    case 'eth_feeHistory':
      return checkFeeHistory(params);
    default:
      // eth_chainId, eth_blockNumber, eth_gasPrice, eth_maxPriorityFeePerGas
      return checkNoParams(method, params);
  }
}

/**
 * What one allowed call costs against the per-call budget (#1283), in
 * units. The per-request budget counts HTTP requests, so before this a
 * batch of fifty log scans cost the same as one block-number poll. The
 * weights follow what the provider does for each: a plain read is 1, an
 * execution is more, a log scan or a block with every transaction in it
 * is the most.
 */
export function rpcCallWeight(method: string, params: unknown): number {
  switch (method) {
    case 'eth_getLogs':
      return 10;
    case 'eth_estimateGas':
      return 3;
    case 'eth_call':
    case 'eth_feeHistory':
      return 2;
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return Array.isArray(params) && params[1] === true ? 5 : 1;
    default:
      return 1;
  }
}

/** How many units one slot of the per-call budget stands for. A request
 *  takes `ceil(units / RPC_PROXY_UNITS_PER_SLOT)` slots, so the largest
 *  batch the proxy accepts (fifty log scans, 500 units) takes 20 slots and a
 *  block-number poll takes one. */
export const RPC_PROXY_UNITS_PER_SLOT = 25;

/** Largest upstream answer the proxy reads, in bytes. An answer over it is
 *  refused as a whole (the proxy cannot pass on part of a JSON-RPC batch),
 *  and the app's transport moves on to its public fallback. */
export const RPC_PROXY_MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
