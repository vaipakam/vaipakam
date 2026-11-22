/**
 * explain-tx (#3917): the operator command around the transaction explainer.
 *
 *   pnpm --filter @vaipakam/lib explain-tx --chain 84532 --tx 0x…
 *   pnpm --filter @vaipakam/lib explain-tx --chain 84532 \
 *     --from 0x… --to 0x… --data 0x… [--value 0] --block 123
 *
 * The node endpoint is read from the environment variable EXPLAIN_RPC_URL
 * (or the one named by --rpc-env), never from an argument, so it stays out of
 * shell history; it is never printed. Options:
 *
 *   --json <path>   also write the explanation as data, for the case file
 *   --no-rebuild    do not start a local copy when the node gives no trace
 *   --anvil <path>  the anvil binary (default: anvil on PATH)
 *
 * Where the trace comes from, in order:
 *   1. the node's own trace (`debug_traceTransaction`, call tracer);
 *   2. a local copy (anvil) of the chain from the PARENT block's state, with
 *      the block's earlier transactions applied in their order and then this
 *      one (anvil's `--fork-transaction-hash`). The rebuilt receipt is
 *      compared with the chain's: success, gas used and every event. A
 *      mismatch makes the output an approximate replay, headed as such;
 *   3. nothing: the receipt only, and the Diamond's routes at the start and
 *      end of the block for the called function.
 * An attempt that was never sent is traced with `debug_traceCall` on the
 * node, else on a local copy at the block.
 *
 * It sends nothing to the chain and holds no key.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createPublicClient, http, parseAbi, type Abi, type Hex, type PublicClient } from 'viem';
import * as abis from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  codeNamesFromDeployment,
  compareWithReceipt,
  explainTransaction,
  renderExplanation,
  type AttemptSubject,
  type CallFrame,
  type ExplainInput,
  type ReceiptFacts,
  type TransactionSubject,
} from '../src/txExplainer';

const TRACER = { tracer: 'callTracer', tracerConfig: { withLog: true } } as const;

/**
 * The outside interfaces a platform transaction routinely calls: tokens and
 * price feeds. Only what decoding needs; the platform's own ABIs come first.
 */
const OUTSIDE_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

/** Every ABI the platform ships (the Diamond union and each standalone
 *  contract), then the outside interfaces. Built once. */
let cachedAbis: Abi[] | undefined;
function platformAbis(): Abi[] {
  cachedAbis ??= [abis.DIAMOND_ABI_VIEM]
    .concat(Object.entries(abis).filter(([k, v]) => k.endsWith('ABI') && Array.isArray(v)).map(([, v]) => v as unknown as Abi))
    .concat([OUTSIDE_ABI as Abi]);
  return cachedAbis;
}

/** A failure described without the request (viem's long message carries the URL). */
function bounded(e: unknown): string {
  const short = (e as { shortMessage?: unknown })?.shortMessage;
  if (typeof short === 'string') return short;
  return e instanceof Error ? e.name : 'an unknown failure';
}

function receiptFacts(r: { status: string; gasUsed: bigint; logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }> }): ReceiptFacts {
  return {
    status: r.status === 'success' ? 'success' : 'reverted',
    gasUsed: r.gasUsed,
    logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface LocalCopy {
  client: PublicClient;
  stop: () => void;
}

/** Start a local copy of the chain. Its output is discarded: it can echo the endpoint. */
async function startLocalCopy(anvil: string, rpcUrl: string, forkArgs: string[]): Promise<LocalCopy> {
  const port = await freePort();
  const child: ChildProcess = spawn(anvil, ['--fork-url', rpcUrl, ...forkArgs, '--port', String(port), '--silent', '--no-storage-caching'], {
    stdio: 'ignore',
  });
  let exited = false;
  // A spawn failure (anvil missing, not executable) arrives as an 'error'
  // event. Unheard, Node prints it with the spawn arguments, which carry the
  // endpoint; heard, it becomes a plain refusal and the fallback runs.
  let spawnFailure: string | undefined;
  child.once('error', (e: NodeJS.ErrnoException) => {
    spawnFailure = `the local copy could not be started (${e.code ?? 'spawn failed'})`;
    exited = true;
  });
  child.once('exit', () => {
    exited = true;
  });
  const stop = () => {
    if (!exited) child.kill('SIGTERM');
  };
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 120_000 }) });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (spawnFailure) throw new Error(spawnFailure);
    if (exited) throw new Error('the local copy exited while starting (the node may not keep the state of that block)');
    try {
      await client.getChainId();
      return { client, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  stop();
  throw new Error('the local copy did not start within two minutes');
}

async function trace(client: PublicClient, method: 'debug_traceTransaction' | 'debug_traceCall', params: unknown[]): Promise<CallFrame> {
  return (await client.request({ method: method as never, params: params as never })) as CallFrame;
}

async function routesAround(client: PublicClient, diamond: Hex, selector: Hex, block: bigint): Promise<ExplainInput['routes']> {
  // A failed read is UNKNOWN (pruned state, a node error), never "no route":
  // an absent route is the loupe answering the zero address.
  const read = async (at: bigint): Promise<string | null | undefined> => {
    try {
      const a = (await client.readContract({ address: diamond, abi: abis.DIAMOND_ABI_VIEM, functionName: 'facetAddress', args: [selector], blockNumber: at })) as string;
      return /^0x0{40}$/i.test(a) ? null : a;
    } catch {
      return undefined;
    }
  };
  const routes: NonNullable<ExplainInput['routes']> = { selector };
  const start = await read(block - 1n);
  const end = await read(block);
  if (start !== undefined) routes.atBlockStart = start;
  if (end !== undefined) routes.atBlockEnd = end;
  return routes;
}

interface Args {
  chain: number;
  tx?: Hex;
  from?: Hex;
  to?: Hex;
  data?: Hex;
  value?: bigint;
  block?: bigint;
  json?: string;
  rebuild: boolean;
  anvil: string;
  rpcEnv: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = Number(get('--chain'));
  if (!Number.isInteger(chain) || chain <= 0) throw new Error('--chain <id> is required');
  const a: Args = { chain, rebuild: !argv.includes('--no-rebuild'), anvil: get('--anvil') ?? 'anvil', rpcEnv: get('--rpc-env') ?? 'EXPLAIN_RPC_URL' };
  const tx = get('--tx');
  if (tx) a.tx = tx as Hex;
  for (const k of ['from', 'to', 'data'] as const) {
    const v = get(`--${k}`);
    if (v) a[k] = v as Hex;
  }
  const value = get('--value');
  if (value) a.value = BigInt(value);
  const block = get('--block');
  if (block) a.block = BigInt(block);
  const json = get('--json');
  if (json) a.json = json;
  if (!a.tx && !(a.from && a.to && a.data && a.block !== undefined)) {
    throw new Error('give --tx <hash>, or an attempt: --from --to --data --block [--value]');
  }
  return a;
}

async function explainTx(a: Args, rpcUrl: string, client: PublicClient, nameOf: ExplainInput['nameOf']): Promise<ExplainInput> {
  const hash = a.tx!;
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const subject: TransactionSubject = {
    kind: 'transaction',
    hash,
    chainId: a.chain,
    blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex,
    from: tx.from,
    to: tx.to ?? null,
    gasLimit: tx.gas,
  };
  const chainReceipt = receiptFacts(receipt);
  const base = { subject, receipt: chainReceipt, abis: platformAbis(), nameOf };

  try {
    return { ...base, source: 'node-trace', trace: await trace(client, 'debug_traceTransaction', [hash, TRACER]) };
  } catch (e) {
    const nodeReason = `The node gave no trace (${bounded(e)}).`;
    if (a.rebuild) {
      let copy: LocalCopy | undefined;
      try {
        copy = await startLocalCopy(a.anvil, rpcUrl, ['--fork-transaction-hash', hash]);
        const local = await copy.client.getTransactionReceipt({ hash });
        const differences = compareWithReceipt(chainReceipt, receiptFacts(local));
        if (local.blockHash === receipt.blockHash) {
          differences.push("the local copy answered with the chain's own receipt, so this transaction was not run locally");
        }
        const t = await trace(copy.client, 'debug_traceTransaction', [hash, TRACER]);
        return { ...base, source: 'rebuilt', trace: t, rebuildDifferences: differences };
      } catch (e2) {
        const reason = `${nodeReason} A local rebuild was not possible (${e2 instanceof Error && !(e2 as { shortMessage?: unknown }).shortMessage ? e2.message : bounded(e2)}).`;
        return withRoutes({ ...base, source: 'none', noTraceReason: reason }, client, tx.to, tx.input, receipt.blockNumber);
      } finally {
        copy?.stop();
      }
    }
    return withRoutes({ ...base, source: 'none', noTraceReason: `${nodeReason} A local rebuild was not asked for.` }, client, tx.to, tx.input, receipt.blockNumber);
  }
}

async function withRoutes(input: ExplainInput, client: PublicClient, to: Hex | null, data: Hex, block: bigint): Promise<ExplainInput> {
  const dep = getDeployment(input.subject.chainId);
  if (dep && to && to.toLowerCase() === dep.diamond.toLowerCase() && data.length >= 10) {
    const routes = await routesAround(client, dep.diamond as Hex, data.slice(0, 10) as Hex, block);
    if (routes) input.routes = routes;
  }
  return input;
}

async function explainAttempt(a: Args, rpcUrl: string, client: PublicClient, nameOf: ExplainInput['nameOf']): Promise<ExplainInput> {
  const subject: AttemptSubject = { kind: 'attempt', chainId: a.chain, from: a.from!, to: a.to!, data: a.data!, blockNumber: a.block! };
  if (a.value !== undefined) subject.value = a.value;
  const call = { from: a.from, to: a.to, data: a.data, value: a.value !== undefined ? `0x${a.value.toString(16)}` : undefined };
  const base = { subject, abis: platformAbis(), nameOf };
  try {
    return { ...base, source: 'attempt', trace: await trace(client, 'debug_traceCall', [call, `0x${a.block!.toString(16)}`, TRACER]) };
  } catch (e) {
    const nodeReason = `The node gave no trace of the attempt (${bounded(e)}).`;
    if (!a.rebuild) return { ...base, source: 'none', noTraceReason: nodeReason };
    let copy: LocalCopy | undefined;
    try {
      copy = await startLocalCopy(a.anvil, rpcUrl, ['--fork-block-number', a.block!.toString()]);
      return { ...base, source: 'attempt', trace: await trace(copy.client, 'debug_traceCall', [call, 'latest', TRACER]) };
    } catch (e2) {
      return { ...base, source: 'none', noTraceReason: `${nodeReason} A local copy was not possible (${bounded(e2)}).` };
    } finally {
      copy?.stop();
    }
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env[a.rpcEnv];
  if (!rpcUrl) throw new Error(`set ${a.rpcEnv} to the node endpoint (it is never printed)`);
  const dep = getDeployment(a.chain);
  if (!dep) process.stderr.write(`No deployment record for chain ${a.chain}: code will be shown by address only.\n`);
  const nameOf = dep ? codeNamesFromDeployment(dep as unknown as Parameters<typeof codeNamesFromDeployment>[0]) : () => undefined;
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 60_000 }) });
  // The endpoint must be the chain asked about: every name and label below is
  // that chain's, so a mistaken endpoint would be explained confidently wrong.
  const served = await client.getChainId();
  if (served !== a.chain) throw new Error(`the endpoint in ${a.rpcEnv} serves chain ${served}, not chain ${a.chain}`);

  const input = a.tx ? await explainTx(a, rpcUrl, client, nameOf) : await explainAttempt(a, rpcUrl, client, nameOf);
  const explanation = explainTransaction(input);
  process.stdout.write(`${renderExplanation(explanation)}\n`);
  if (a.json) {
    writeFileSync(a.json, `${JSON.stringify(explanation, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`explain-tx: ${e instanceof Error && !(e as { shortMessage?: unknown }).shortMessage ? e.message : bounded(e)}\n`);
  process.exit(1);
});
