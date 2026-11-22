/**
 * One failed transaction, decoded while the node still holds its state, as
 * the record the indexer stores (#3919, TroubleshootingPictureDesign.md §4.3).
 *
 * The best source the node offers is taken, in order, and the record says
 * which:
 *   trace   the node's own trace (`debug_traceTransaction`, call tracer): the
 *           explainer's complete output;
 *   replay  the call replayed at the PARENT block (`eth_call`): the error and
 *           its values only, with what it cannot hold listed;
 *   none    the node no longer holds the block's state: the receipt's facts,
 *           and "state no longer reachable".
 * A local rebuild (the explainer's second source) needs a local copy of the
 * chain; an operator adds it through the same route, never this pass.
 *
 * A node that does not answer (as opposed to one that refuses) is never read
 * as a missing state: the failure goes up, and the pass holds and retries,
 * so a passing outage cannot downgrade a record that a trace could still
 * fill.
 */
import { decodeFunctionData, getContractAddress, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem';
import {
  decodeRevert,
  explainTransaction,
  plainValue,
  type CodeName,
  type DecodedError,
  type Explanation,
  type TransactionSubject,
} from '@vaipakam/lib/txExplainer';
import { CALL_TRACER, platformAbis, receiptFacts } from '@vaipakam/lib/txExplainerNode';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { MAX_ERROR_VALUES_BYTES, MAX_EXPLANATION_BYTES, jsonBytes } from '@vaipakam/lib/failedTxBounds';
import { RpcFailure, hex, num, stateGone, type Rpc } from './rpc';

export type FoundBy = 'keeper-send' | 'explorer-list' | 'audit' | 'trace-filter' | 'block-scan';
export type PassMode = 'trace-filter' | 'list-and-audit' | 'sends-and-audit' | 'block-scan';

/** The record as `POST /internal/failed-tx` takes it. */
export interface FailedTxRecord {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  blockTime: number;
  txIndex: number | null;
  sender: string;
  contract: string;
  functionSelector: string | null;
  functionName: string | null;
  loanId: string | null;
  offerId: string | null;
  errorSelector: string | null;
  errorName: string | null;
  errorValues: unknown;
  foundBy: FoundBy;
  mode: PassMode;
  source: 'trace' | 'replay' | 'none';
  explanation: unknown;
  explanationCut: boolean;
  unavailable: string[] | null;
  gasUsed: string;
  gasLimit: string;
  usedAllGas: boolean;
  notReproduced: boolean;
  stateUnreachable: boolean;
}

export { MAX_EXPLANATION_BYTES };
/** An argument value cut to fit keeps this many characters. */
const CUT_KEEP = 256;
export const CUT_MARK = '…[cut to fit the record]';

const REPLAY_LACKS = ['the call path', 'the arguments of inner calls', 'the events before the failure', 'the gas at each step'];
const NONE_LACKS = ['the error and its values', ...REPLAY_LACKS];

interface RawTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gas: string;
  blockNumber: string | null;
  transactionIndex: string | null;
  nonce: string;
}
interface RawReceipt {
  status: string;
  /** Set for a contract creation: the address it deployed, or would have. */
  contractAddress?: string | null;
  blockHash: string;
  blockNumber: string;
  transactionIndex: string;
  gasUsed: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

let fnTable: Map<string, AbiFunction> | undefined;
/** The top-level function a calldata names, decoded with the platform's ABIs. */
export function decodeCall(abis: readonly Abi[], input: string): { name: string; args: Record<string, unknown> } | null {
  if (!input || input.length < 10) return null;
  if (!fnTable) {
    fnTable = new Map();
    for (const abi of abis) {
      for (const item of abi) {
        if (item.type !== 'function') continue;
        const sel = toFunctionSelector(item);
        if (!fnTable.has(sel)) fnTable.set(sel, item);
      }
    }
  }
  const fn = fnTable.get(input.slice(0, 10).toLowerCase());
  if (!fn) return null;
  try {
    const d = decodeFunctionData({ abi: [fn], data: input as Hex });
    const args: Record<string, unknown> = {};
    fn.inputs.forEach((p, i) => {
      args[p.name || `arg${i}`] = plainValue((d.args ?? [])[i]);
    });
    return { name: fn.name, args };
  } catch {
    return { name: fn.name, args: {} };
  }
}

/** A loan or offer id the called function names by that name. */
function idArg(args: Record<string, unknown> | undefined, name: 'loanId' | 'offerId'): string | null {
  const v = args?.[name];
  return typeof v === 'string' && /^[0-9]+$/.test(v) ? v : null;
}

const size = jsonBytes;

/**
 * Cuts the longest string values in `value` (in place), each to CUT_KEEP
 * characters and a mark, until it fits `max`. `inArgs` says whether every
 * string counts or only those under an `args` object. Returns whether
 * anything was cut and whether the value now fits.
 */
function cutLongest(value: unknown, max: number, inArgs: boolean): { cut: boolean; fits: boolean } {
  if (size(value) <= max) return { cut: false, fits: true };
  const leaves: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number; len: number }> = [];
  const walk = (v: unknown, counted: boolean) => {
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'string' && counted ? leaves.push({ holder: v, key: i, len: x.length }) : walk(x, counted)));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'string' && counted) leaves.push({ holder: v as Record<string, unknown>, key: k, len: x.length });
        else walk(x, counted || k === 'args');
      }
    }
  };
  walk(value, inArgs);
  leaves.sort((a, b) => b.len - a.len);
  let cut = false;
  for (const l of leaves) {
    if (l.len <= CUT_KEEP + CUT_MARK.length) break;
    const h = l.holder as Record<string | number, string>;
    h[l.key] = `${h[l.key]!.slice(0, CUT_KEEP)}${CUT_MARK}`;
    cut = true;
    if (size(value) <= max) return { cut, fits: true };
  }
  return { cut, fits: false };
}

/**
 * An explanation bounded to the record's size: the longest argument values
 * are cut first, each with a mark; the call path, the error and the events
 * are kept. Returns the explanation and whether anything was cut.
 */
export function boundExplanation(e: unknown, max = MAX_EXPLANATION_BYTES): { value: unknown; cut: boolean; dropped: boolean } {
  const value = structuredClone(plainValue(e)) as Record<string, unknown>;
  const r = cutLongest(value, max, false);
  if (r.fits) return { value, cut: r.cut, dropped: false };
  // Still over: keep what the failure needs and say the call path is not stored.
  const kept = {
    subject: value.subject,
    source: value.source,
    heading: value.heading,
    approximate: value.approximate,
    outcome: value.outcome,
    gasUsed: value.gasUsed,
    stop: value.stop,
    steps: [],
    differences: value.differences,
    notes: [...((value.notes as string[] | undefined) ?? []), 'The call path was over the record size bound even with argument values cut, so it is not stored.'],
  };
  return { value: kept, cut: true, dropped: true };
}

/**
 * The decoded error values bounded to their own field limit (shared with the
 * indexer's route): the longest values are cut with a mark, and values still
 * over it are not stored, which the record's `unavailable` list says.
 */
export function boundErrorValues(args: unknown, max = MAX_ERROR_VALUES_BYTES): { value: unknown; cut: boolean; dropped: boolean } {
  if (args === null || args === undefined) return { value: null, cut: false, dropped: false };
  const value = structuredClone(args);
  const r = cutLongest(value, max, true);
  return r.fits ? { value, cut: r.cut, dropped: false } : { value: null, cut: true, dropped: true };
}

/**
 * A record fitted to the route's field bounds before it is written: the one
 * place every record passes, whatever its source. The explanation (a trace's
 * already cut by `boundExplanation`, a replay's raw revert data, a fallback's
 * kept error) is cut again over every string value if it is still over, and
 * replaced by a statement that it is not stored if even that does not fit;
 * the error values are cut to their own bound. Whatever is not stored is
 * named in `unavailable`. A record over a bound would be refused by the route
 * on every run, since the cursor moves only after the records are stored.
 */
export function fitRecord(r: FailedTxRecord): FailedTxRecord {
  let out = r;
  const unavailable = [...(r.unavailable ?? [])];
  if (r.explanation !== null && r.explanation !== undefined && size(r.explanation) > MAX_EXPLANATION_BYTES) {
    const value = structuredClone(r.explanation);
    const cut = cutLongest(value, MAX_EXPLANATION_BYTES, true);
    if (cut.fits) out = { ...out, explanation: value, explanationCut: true };
    else {
      out = {
        ...out,
        explanation: { notStored: 'The explanation was over the record size bound even with every value cut, so it is not stored.' },
        explanationCut: true,
      };
      unavailable.push('the explanation (over the record size bound)');
    }
  }
  const ev = boundErrorValues(out.errorValues);
  if (ev.cut) {
    out = { ...out, errorValues: ev.value as FailedTxRecord['errorValues'], explanationCut: true };
    if (ev.dropped) unavailable.push('the error values (over the record size bound; the explanation keeps them where it can)');
  }
  return out === r ? r : { ...out, unavailable: unavailable.length ? unavailable : null };
}

export interface RecordContext {
  rpc: Rpc;
  chainId: number;
  mode: PassMode;
  nameOf: (address: string) => CodeName | undefined;
  abis?: readonly Abi[];
}

/**
 * The record of `txHash`, or null when it did not fail (a trace filter lists
 * transactions with any failed inner call, and a caught one does not fail
 * the transaction). Throws on a node that does not answer.
 */
/** Stated on the record of a contract creation, whose `contract` is not a called address. */
export const CREATION_NOTE = 'the called contract (a contract creation: `contract` is the address it would have deployed, and no function was called)';

export async function recordFor(ctx: RecordContext, txHash: string, foundBy: FoundBy): Promise<FailedTxRecord | null> {
  const seen = { creation: false };
  const r = await recordUnfitted(ctx, txHash, foundBy, seen);
  if (!r) return null;
  // A creation (found through a failing call its constructor made into a
  // watched contract) has no top-level `to`: the record names the address it
  // would have deployed and says so, rather than an empty address.
  return fitRecord(seen.creation ? { ...r, unavailable: [...(r.unavailable ?? []), CREATION_NOTE] } : r);
}

async function recordUnfitted(ctx: RecordContext, txHash: string, foundBy: FoundBy, seen: { creation: boolean }): Promise<FailedTxRecord | null> {
  const { rpc } = ctx;
  const abis = ctx.abis ?? platformAbis();
  const [tx, receipt] = await Promise.all([
    rpc.call<RawTx | null>('eth_getTransactionByHash', [txHash]),
    rpc.call<RawReceipt | null>('eth_getTransactionReceipt', [txHash]),
  ]);
  if (!tx || !receipt) throw new RpcFailure('transient', null, `transaction ${txHash} is not yet known to the node`);
  if (num(receipt.status) !== 0) return null;
  const block = await rpc.call<{ timestamp: string } | null>('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block) throw new RpcFailure('transient', null, `block ${num(receipt.blockNumber)} is not yet known to the node`);

  const blockNumber = num(receipt.blockNumber);
  const gasUsed = BigInt(receipt.gasUsed);
  const gasLimit = BigInt(tx.gas);
  seen.creation = !tx.to;
  const call = tx.to ? decodeCall(abis, tx.input) : undefined;
  const contract = tx.to ?? receipt.contractAddress ?? getContractAddress({ from: tx.from as `0x${string}`, nonce: BigInt(tx.nonce) });
  const base = {
    txHash: txHash.toLowerCase(),
    blockHash: receipt.blockHash.toLowerCase(),
    blockNumber,
    blockTime: num(block.timestamp),
    txIndex: receipt.transactionIndex ? num(receipt.transactionIndex) : null,
    sender: tx.from.toLowerCase(),
    contract: contract.toLowerCase(),
    functionSelector: tx.to && tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null,
    functionName: call?.name ?? null,
    loanId: idArg(call?.args, 'loanId'),
    offerId: idArg(call?.args, 'offerId'),
    foundBy,
    mode: ctx.mode,
    gasUsed: gasUsed.toString(),
    gasLimit: gasLimit.toString(),
    usedAllGas: gasUsed >= gasLimit,
  };
  const errorFields = (err: DecodedError | undefined) => ({
    errorSelector: err?.selector ?? null,
    errorName: err?.name ?? null,
    errorValues: err ? err.args : null,
  });

  // 1. The node's trace.
  let traceRefusal: unknown;
  try {
    const trace = await rpc.call<Record<string, unknown>>('debug_traceTransaction', [txHash, CALL_TRACER]);
    const subject: TransactionSubject = {
      kind: 'transaction',
      hash: base.txHash,
      chainId: ctx.chainId,
      blockNumber: BigInt(blockNumber),
      from: base.sender,
      to: tx.to ? base.contract : null,
      gasLimit,
    };
    if (base.txIndex !== null) subject.transactionIndex = base.txIndex;
    const explanation: Explanation = explainTransaction({
      subject,
      source: 'node-trace',
      trace: trace as never,
      receipt: receiptFacts({ status: receipt.status, gasUsed, logs: receipt.logs }),
      abis,
      nameOf: ctx.nameOf,
    });
    const bounded = boundExplanation(explanation);
    return {
      ...base,
      ...errorFields(explanation.stop?.error),
      source: 'trace',
      explanation: bounded.value,
      explanationCut: bounded.cut,
      unavailable: bounded.dropped ? ['the call path (over the record size bound)'] : null,
      notReproduced: false,
      stateUnreachable: false,
    };
  } catch (e) {
    if (!(e instanceof RpcFailure) || e.kind === 'transient') throw e;
    traceRefusal = e;
  }

  // 2. A replay of the call at the parent block.
  const parent = hex(blockNumber - 1);
  const callObj: Record<string, string> = { from: tx.from, data: tx.input, gas: tx.gas };
  if (tx.to) callObj.to = tx.to;
  if (tx.value && tx.value !== '0x0') callObj.value = tx.value;
  try {
    await rpc.call<string>('eth_call', [callObj, parent]);
    // The replay succeeded where the transaction failed.
    return {
      ...base,
      ...errorFields(undefined),
      source: 'replay',
      explanation: { kind: 'replay', atBlock: blockNumber - 1, succeeded: true, traceRefused: describeFailure(traceRefusal) },
      explanationCut: false,
      unavailable: REPLAY_LACKS,
      notReproduced: true,
      stateUnreachable: false,
    };
  } catch (e) {
    if (!(e instanceof RpcFailure) || e.kind === 'transient') throw e;
    if (!stateGone(e)) {
      const err = decodeRevert(e.data);
      return {
        ...base,
        ...errorFields(err),
        source: 'replay',
        explanation: {
          kind: 'replay',
          atBlock: blockNumber - 1,
          succeeded: false,
          error: err ? plainValue(err) : null,
          rawData: err ? undefined : (e.data ?? null),
          nodeMessage: describeFailure(e),
          traceRefused: describeFailure(traceRefusal),
        },
        explanationCut: false,
        unavailable: REPLAY_LACKS,
        notReproduced: false,
        stateUnreachable: false,
      };
    }
  }

  // 3. The node no longer holds that block's state.
  return {
    ...base,
    ...errorFields(undefined),
    source: 'none',
    explanation: null,
    explanationCut: false,
    unavailable: NONE_LACKS,
    notReproduced: false,
    stateUnreachable: true,
  };
}
