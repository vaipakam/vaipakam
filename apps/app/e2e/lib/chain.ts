/**
 * Chain-facing viem plumbing shared by the fixtures, the seeding
 * helpers, and the indexer stub. One place resolves the Diamond and
 * the testnet mock assets from the SAME deployments bundle the app
 * reads — the e2e bundle global setup writes after deploying the
 * current contracts from source (#2334) — so the suite can never drift
 * from the app's own address source.
 */
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  hexToBigInt,
  numberToHex,
  type Account,
  type Transport,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type TransactionReceipt,
} from 'viem';
import { extractRevertData } from '@vaipakam/lib/decodeContractError';
import { gasLimitFromEstimate } from '@vaipakam/lib/gasLimit';
import { ANVIL_URL } from './anvil';
import { failingFrame, type TraceFrame } from './traceFrame';
import { loadDeployment, loadDiamondAbi } from './artifacts';

export const CHAIN_ID = 84532;

const deployment = loadDeployment(CHAIN_ID);

export const DIAMOND = deployment.diamond;
/** #3205 — where the position NFTs live: the fixture deploys the current
 *  contracts, so this is the standalone PositionNFT (owners, approvals,
 *  transfers, the holder lock). Never the Diamond on this tier. */
export const POSITION_NFT = (deployment.positionNFT ?? deployment.diamond) as `0x${string}`;
/** The fixture Diamond's admin — it holds ADMIN_ROLE and ownership, so
 *  specs that flip config impersonate it (#1355 flips the
 *  fee-entitlement kill-switch through it). */
export const ADMIN = deployment.admin as `0x${string}`;
export const WETH = deployment.weth as `0x${string}`;
export const MOCKS = deployment.testnetMocks;
if (!MOCKS) {
  throw new Error(
    'the e2e bundle has no testnetMocks — the suite seeds via the faucet assets',
  );
}

export const DIAMOND_ABI_VIEM = loadDiamondAbi();

/** The e2e chain as viem sees it — Base Sepolia's id, anvil's URL. */
export const forkChain: Chain = {
  id: CHAIN_ID,
  name: 'Base Sepolia (local e2e chain)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
};

export const pub: PublicClient = createPublicClient({
  chain: forkChain,
  transport: http(ANVIL_URL),
});

/**
 * The anvil transport, with every `eth_estimateGas` answer turned into a
 * gas limit by the shared rule (`@vaipakam/lib/gasLimit`): the estimate plus
 * its margin. A node's estimate is the lowest limit that works in the LATEST
 * block's environment; the write mines a block later, and an oracle read
 * whose cost moves with the timestamp then needs slightly more. Sent at the
 * bare estimate, a nested cross-facet call runs out of gas under the 63/64
 * rule and the setup write reverts with no reason (#3512: a seeded
 * `createOffer` ran out inside `openOfferOnBook` with 1,775,703 of its
 * 1,809,039 estimate used). Applied at the transport so every wallet write
 * a helper or spec makes gets it, not only the ones that remember to pad.
 */
function marginedTransport(url: string): Transport {
  const base = http(url);
  return (params) => {
    const t = base(params);
    return {
      ...t,
      request: (async (args: { method: string; params?: unknown }) => {
        const result = await t.request(args as Parameters<typeof t.request>[0]);
        return args.method === 'eth_estimateGas'
          ? numberToHex(gasLimitFromEstimate(hexToBigInt(result as Hex)))
          : result;
      }) as typeof t.request,
    };
  };
}

export function walletFor(account: Account): WalletClient {
  return createWalletClient({
    chain: forkChain,
    transport: marginedTransport(ANVIL_URL),
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
    // Gas used against the limit the sender set: a revert that used (nearly)
    // all of it ran out of gas, whatever the trace's wording.
    let gasNote = `gas used ${receipt.gasUsed}`;
    try {
      const tx = await pub.getTransaction({ hash });
      gasNote += ` of a ${tx.gas} limit`;
    } catch {
      // Best-effort, like the reason itself.
    }
    throw new Error(
      `${label} REVERTED (tx ${hash}, block ${receipt.blockNumber}). ` +
        `The transaction was mined, so nothing here timed out — its effect ` +
        `simply did not happen, and every assertion after this point would ` +
        `have been testing a state that was never reached. ` +
        `Revert reason: ${reason}; ${gasNote}.`,
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
    })) as TraceFrame;
    const origin = failingFrame(trace);
    const where = origin && origin !== trace ? ` — first failed in ${describeFrame(origin)}` : '';
    if (typeof trace?.output === 'string' && trace.output.startsWith('0x') && trace.output.length > 2) {
      return `${decodeRevert(trace.output as Hex)}${where}`;
    }
    if (typeof trace?.error === 'string') {
      return `${trace.error} (from a trace of the transaction; it carried no revert data)${where}`;
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
    // The app's own extractor (#2336): structured fields first, then only the
    // text the provider reported — never viem's notes about the call, which
    // repeat the request's calldata in the same shape as revert data.
    const data = extractRevertData(err);
    if (!data || !data.startsWith('0x')) {
      return `unavailable — no trace, and the replay failed without revert data (${shortMessage(err)})`;
    }
    return `${decodeRevert(data as Hex)} ${approx}`;
  }
}

/** Revert bytes as `Name(args)` against the Diamond's merged ABI, or raw. */
function describeFrame(f: TraceFrame): string {
  const selector = typeof f.input === 'string' && f.input.length >= 10 ? f.input.slice(0, 10) : '(no selector)';
  const data =
    typeof f.output === 'string' && f.output.startsWith('0x') && f.output.length > 2
      ? decodeRevert(f.output as Hex)
      : 'no revert data';
  return (
    `${f.type ?? 'call'} to ${f.to ?? '?'} selector ${selector}: ${String(f.error)}, ${data}` +
    ` (gas ${f.gas ? BigInt(f.gas).toString() : '?'}, used ${f.gasUsed ? BigInt(f.gasUsed).toString() : '?'})`
  );
}

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
