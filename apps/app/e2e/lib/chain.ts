/**
 * Fork-facing viem plumbing shared by the fixtures, the seeding
 * helpers, and the indexer stub. One place resolves the Diamond and
 * the testnet mock assets from the SAME consolidated deployments
 * bundle the app reads, so the suite can never drift from the app's
 * own address source.
 */
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type TransactionReceipt,
} from 'viem';
import { ANVIL_URL } from './anvil';
import { loadDeployment, loadDiamondAbi } from './artifacts';

export const CHAIN_ID = 84532;

const deployment = loadDeployment(CHAIN_ID);

export const DIAMOND = deployment.diamond;
/** The testnet admin/deployer — testnets stay deployer-owned, so this
 *  account holds ADMIN_ROLE on the forked Diamond (#1355 spec flips
 *  the fee-entitlement kill-switch through it). */
export const ADMIN = deployment.admin as `0x${string}`;
export const WETH = deployment.weth as `0x${string}`;
export const MOCKS = deployment.testnetMocks;
if (!MOCKS) {
  throw new Error(
    'Base Sepolia bundle has no testnetMocks — the fork tier seeds via the faucet assets',
  );
}

export const DIAMOND_ABI_VIEM = loadDiamondAbi();

/** The fork chain as viem sees it — Base Sepolia's id, anvil's URL. */
export const forkChain: Chain = {
  id: CHAIN_ID,
  name: 'Base Sepolia (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
};

export const pub: PublicClient = createPublicClient({
  chain: forkChain,
  transport: http(ANVIL_URL),
});

export function walletFor(account: Account): WalletClient {
  return createWalletClient({
    chain: forkChain,
    transport: http(ANVIL_URL),
    account,
  });
}

/**
 * Wait for a transaction and FAIL if it reverted (#2183).
 *
 * `waitForTransactionReceipt` does not throw on a reverted transaction — it
 * resolves with `status: 'reverted'`. Every bare `await pub.waitForTransaction-
 * Receipt(...)` therefore reads as "the write succeeded" when it means "the
 * write was mined", and a revert continues the setup as though its effect had
 * landed. The test then fails much later, on a surface three steps downstream,
 * with a message about the wrong thing.
 *
 * That is the mechanism behind #2183: a `createLoanSaleOffer` that reverts
 * against live forked state let the spec go on to assert a hold card that had
 * nothing to render, failing 60s later with "element(s) not found" — a message
 * that says nothing about the listing never having existed, on a line three
 * steps from the cause. The suite had 19 of these calls and exactly ONE read
 * `status`, by hand.
 *
 * `label` is what makes the failure worth reading: it names the write that
 * reverted, so the first line of the error is the cause rather than a hash.
 *
 * Use this instead of a bare `waitForTransactionReceipt` for every write. If a
 * test genuinely EXPECTS a revert, call `waitForTransactionReceipt` directly
 * and assert on `status` there, so the expectation is visible at the call site.
 *
 * THE MESSAGE NAMES THE REVERT, not only the fact of it (#2334). A receipt
 * carries no revert data, and the fork is discarded with the job, so without
 * this the cause of a reverted setup write is unrecoverable afterwards —
 * which is exactly what happened when `26-sale-listing-hold` flaked on live
 * forked state. See `revertReason` for how, and for what it cannot promise.
 */
export async function confirm(
  hash: `0x${string}`,
  label: string,
): Promise<TransactionReceipt> {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const reason = await revertReason(hash, receipt.blockNumber);
    throw new Error(
      `${label} REVERTED (tx ${hash}, block ${receipt.blockNumber}). ` +
        `The transaction was mined, so nothing here timed out — its effect ` +
        `simply did not happen, and every assertion after this point would ` +
        `have been testing a state that was never reached. ` +
        `Revert reason: ${reason}`,
    );
  }
  return receipt;
}

/**
 * Why a mined transaction reverted, as a sentence for an error message.
 *
 * FIRST FROM A TRACE OF THE TRANSACTION ITSELF (#2335 r1). `debug_trace-
 * Transaction` with the call tracer re-executes the transaction in its own
 * block, with that block's context and every earlier transaction in it, and
 * returns the exact revert output. anvil serves it, which is what CI runs
 * against. Its revert bytes are decoded against the Diamond's merged ABI, so
 * a custom error reads as `Name(args)` rather than as a selector.
 *
 * ONLY IF THE TRACE IS UNAVAILABLE, a replay with `eth_call` at the previous
 * block — and that is an approximation, labelled as one. It runs against the
 * right state only when no earlier transaction shared the block, and against
 * the previous block's context (timestamp, number, base fee) in every case,
 * so a deadline or a timestamp check can revert the original and pass the
 * replay. A replay that does not revert is therefore reported as unknown,
 * never attributed to a cause.
 *
 * BEST-EFFORT, AND NEVER THE CAUSE OF A FAILURE. Every path returns a string:
 * a lookup that itself fails is reported as unavailable, so the caller still
 * throws the original revert with its label and hash.
 */
async function revertReason(hash: Hex, blockNumber: bigint): Promise<string> {
  try {
    const trace = (await pub.request({
      method: 'debug_traceTransaction' as never,
      params: [hash, { tracer: 'callTracer' }] as never,
    })) as { output?: unknown; error?: unknown };
    if (typeof trace?.output === 'string' && trace.output.startsWith('0x') && trace.output.length > 2) {
      return decodeRevert(trace.output as Hex);
    }
    if (typeof trace?.error === 'string') {
      return `${trace.error} (from a trace of the transaction; it carried no revert data)`;
    }
  } catch {
    // No trace on this node — fall through to the labelled replay.
  }
  let tx;
  try {
    tx = await pub.getTransaction({ hash });
  } catch (err) {
    return `unavailable — no trace, and the transaction could not be fetched (${shortMessage(err)})`;
  }
  const approx = `(approximate: replayed at block ${blockNumber - 1n}, not traced in its own block)`;
  try {
    await pub.call({
      account: tx.from,
      to: tx.to ?? undefined,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber: blockNumber - 1n,
    });
    return (
      'unknown — no trace was available, and a replay against the previous block did not ' +
      'revert; it differs from the original in block context (timestamp, number) and in ' +
      'any earlier transaction of the same block, so it cannot say which'
    );
  } catch (err) {
    const data = revertData(err);
    if (!data || !data.startsWith('0x')) {
      return `unavailable — no trace, and the replay failed without revert data (${shortMessage(err)})`;
    }
    return `${decodeRevert(data as Hex)} ${approx}`;
  }
}

/**
 * The raw revert bytes a failed `eth_call` carried, from STRUCTURED fields
 * only, walking the `cause` chain: `data` as a string, the nested
 * `data.data` some providers use, and viem's `raw`.
 *
 * NOT `@vaipakam/lib`'s `extractRevertData` (#2335 r1, measured). That helper
 * falls back to a regex over each node's MESSAGE before descending, and viem's
 * `CallExecutionError` message embeds the request's calldata — which has the
 * selector-plus-words shape it accepts. Against real reverted Base Sepolia
 * transactions it returned the call's own arguments as the revert, where this
 * walk finds the true bytes on the nested `RawContractError`. Filed as #2336.
 */
function revertData(err: unknown): Hex | undefined {
  let node: unknown = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 8; depth++) {
    const n = node as { data?: unknown; raw?: unknown; cause?: unknown };
    const nested =
      n.data && typeof n.data === 'object' ? (n.data as { data?: unknown }).data : undefined;
    for (const c of [n.data, nested, n.raw]) {
      if (typeof c === 'string' && c.startsWith('0x') && c.length >= 10) return c as Hex;
    }
    node = n.cause;
  }
  return undefined;
}

/** Revert bytes as `Name(args)` against the Diamond's merged ABI, or raw. */
function decodeRevert(data: Hex): string {
  try {
    const decoded = decodeErrorResult({ abi: DIAMOND_ABI_VIEM, data });
    const args = (decoded.args ?? []).map((a) =>
      typeof a === 'bigint' ? a.toString() : JSON.stringify(a),
    );
    return `${decoded.errorName}(${args.join(', ')})`;
  } catch {
    return `undecoded revert data ${data}`;
  }
}

function shortMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

export const ERC20_MIN_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;
