/**
 * The transaction explainer (#3917): what a transaction, or an attempt that
 * was never sent, did, in plain words and as data.
 *
 * This module is the PURE half. It takes a call trace (the node's
 * `callTracer` output, or the same output from a local rebuild of the moment)
 * and the chain's receipt, and returns:
 *
 *   - each function entered, in order and by depth, with its decoded
 *     arguments and the gas it used;
 *   - each event emitted, decoded, in the order it was emitted, with the
 *     events a failed call undid marked as undone;
 *   - where it stopped: the error, its values, and the error catalogue's
 *     meaning, who can act on it and whether it should be impossible;
 *   - where the trace came from, and, for a rebuild, whether it matched the
 *     receipt.
 *
 * It sends nothing, holds no key and names no endpoint. Fetching the trace
 * (the node's tracer, else a local copy of the chain rebuilt from the parent
 * block) is the operator command's job (`packages/lib/bin/explain-tx.ts`).
 *
 * WHICH CODE RAN is read from the trace, never from a route lookup: each call
 * the Diamond forwards appears as a delegate call to the address of the code
 * it was forwarded to, and that address is what ran. A refresh later in the
 * same block cannot change it. `nameOf` turns the address into a name (and a
 * build, once the facet history exists); an address it does not know is
 * shown as an address and said to be unknown, never guessed.
 */

import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from 'viem';
import { errorBySelector, type ErrorActor } from '@vaipakam/contracts/error-catalogue';

// ─── Inputs ──────────────────────────────────────────────────────────────

/** One log as a `callTracer` with `withLog` reports it. */
export interface TraceLog {
  address: string;
  topics: string[];
  data: string;
  /** The number of child calls made before this log, within its frame. */
  position?: string | number;
}

/** One frame of a `callTracer` trace (geth and anvil share this shape). */
export interface CallFrame {
  type: string;
  from: string;
  to?: string;
  input?: string;
  output?: string;
  value?: string;
  gas?: string;
  gasUsed?: string;
  /** Present when the frame failed: "execution reverted", "out of gas", ... */
  error?: string;
  calls?: CallFrame[];
  logs?: TraceLog[];
}

/** The receipt facts the explainer reads and compares. */
export interface ReceiptFacts {
  status: 'success' | 'reverted';
  gasUsed: bigint;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** What an address is, as far as the caller knows. */
export interface CodeName {
  name: string;
  /** The build that code came from, once a facet history can say. */
  build?: string;
  /** A proxy forwards its calls by delegate call (the Diamond). */
  kind?: 'proxy' | 'code';
}

export type TraceSource =
  /** The node's own trace of the mined transaction. */
  | 'node-trace'
  /** A local copy rebuilt from the parent block, earlier transactions applied. */
  | 'rebuilt'
  /** An attempt that was never sent, traced at a block. */
  | 'attempt'
  /** Neither a trace nor a rebuild was possible. */
  | 'none';

export interface TransactionSubject {
  kind: 'transaction';
  hash: string;
  chainId: number;
  blockNumber?: bigint;
  transactionIndex?: number;
  from?: string;
  to?: string | null;
  gasLimit?: bigint;
}

export interface AttemptSubject {
  kind: 'attempt';
  chainId: number;
  from: string;
  to: string;
  data: string;
  value?: bigint;
  /** The attempt runs on the state at the END of this block. */
  blockNumber: bigint;
}

export interface ExplainInput {
  subject: TransactionSubject | AttemptSubject;
  source: TraceSource;
  /** The trace, when `source` is not `none`. */
  trace?: CallFrame;
  /** The chain's receipt (a transaction), when it could be read. */
  receipt?: ReceiptFacts;
  /**
   * For a rebuild: what differed from the chain's receipt, as
   * {@link compareWithReceipt} lists it, plus anything that could not be
   * applied. Non-empty makes the explanation an approximate replay.
   */
  rebuildDifferences?: string[];
  /** Why there is no trace, when `source` is `none`. */
  noTraceReason?: string;
  /**
   * With no trace, the code each route pointed at, at the start and at the
   * end of the block, for the top-level selector. Shown only; never read as
   * the code that ran.
   */
  routes?: { selector: string; atBlockStart?: string; atBlockEnd?: string };
  /** ABIs to decode calls and events with (the Diamond union and the platform's
   *  standalone contracts). Errors are decoded from the error catalogue. */
  abis: readonly Abi[];
  /** Turns a code address into a name. */
  nameOf: (address: string) => CodeName | undefined;
}

// ─── Output ──────────────────────────────────────────────────────────────

export interface ExplainedCode {
  address: string;
  /** Undefined when the address is not one the caller could name. */
  name?: string;
  build?: string;
}

export interface CallStep {
  kind: 'call';
  depth: number;
  /** CALL, STATICCALL, DELEGATECALL, CREATE, ... */
  callType: string;
  /** The code that ran. For a call through the Diamond, the facet. */
  code: ExplainedCode;
  /** The proxy the call went through, when it was forwarded. */
  via?: ExplainedCode;
  from: string;
  selector?: string;
  /** Decoded, where an ABI knows the selector. */
  function?: { name: string; signature: string; args: Record<string, unknown> };
  value?: string;
  gasUsed?: string;
  failed: boolean;
  /** The node's word for the failure ("execution reverted", "out of gas"). */
  failure?: string;
}

export interface EventStep {
  kind: 'event';
  depth: number;
  address: string;
  emitter?: string;
  /** Decoded, where an ABI knows the event. */
  event?: { name: string; signature: string; args: Record<string, unknown> };
  topics: string[];
  data: string;
  /** Emitted inside a call that failed, so it never happened on chain. */
  undone: boolean;
}

export type Step = CallStep | EventStep;

export interface DecodedError {
  selector: string;
  name: string;
  signature: string;
  args: Record<string, unknown>;
  /** The catalogue's plain meaning, where one is written. */
  meaning?: string;
  actor?: ErrorActor;
  /** The catalogue marks it as should-be-impossible. */
  internal?: boolean;
  /** For a Panic, the code's meaning. */
  panic?: string;
}

export interface StopPoint {
  /** What the transaction returned, decoded. Undefined for empty revert data. */
  error?: DecodedError;
  /** Raw revert data, when it could not be decoded. */
  rawData?: string;
  /** The node's word for the failure. */
  failure?: string;
  /** The innermost failed call: where the failure began. */
  origin?: { depth: number; code: ExplainedCode; function?: string };
  /**
   * The innermost call's own error when it differs from what the
   * transaction returned (a caller turned it into another error).
   */
  originError?: DecodedError;
  /** A plain sentence for empty revert data. */
  emptyRevert?: string;
}

export interface Explanation {
  subject: TransactionSubject | AttemptSubject;
  source: TraceSource;
  /** One line that says what this output can be trusted for. */
  heading: string;
  /** True when this is not what happened on chain. */
  approximate: boolean;
  outcome: 'succeeded' | 'failed' | 'unknown';
  gasUsed?: string;
  steps: Step[];
  stop?: StopPoint;
  /** For a rebuild: what differed from the receipt. */
  differences: string[];
  notes: string[];
}

// ─── Decoding tables ─────────────────────────────────────────────────────

const PANIC_CODES: Readonly<Record<number, string>> = {
  0x00: 'a generic compiler panic',
  0x01: 'an assertion failed',
  0x11: 'an arithmetic overflow or underflow',
  0x12: 'a division or modulo by zero',
  0x21: 'a value out of range for its enum',
  0x22: 'a corrupt storage byte array',
  0x31: 'a pop from an empty array',
  0x32: 'an array index out of bounds',
  0x41: 'too much memory allocated',
  0x51: 'a call to an uninitialised function',
};

const paramSig = (p: AbiParameter): string => {
  if (!p.type.startsWith('tuple')) return p.type;
  const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
  return `(${comps.map(paramSig).join(',')})${p.type.slice('tuple'.length)}`;
};
const signatureOf = (item: AbiFunction | AbiEvent): string => `${item.name}(${item.inputs.map(paramSig).join(',')})`;

interface Tables {
  functions: Map<string, AbiFunction[]>;
  events: Map<string, AbiEvent[]>;
}

const tableCache = new WeakMap<readonly Abi[], Tables>();

function tablesFor(abis: readonly Abi[]): Tables {
  const cached = tableCache.get(abis);
  if (cached) return cached;
  const functions = new Map<string, AbiFunction[]>();
  const events = new Map<string, AbiEvent[]>();
  const seen = new Set<string>();
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== 'function' && item.type !== 'event') continue;
      const sig = signatureOf(item);
      const key = `${item.type}:${sig}:${item.type === 'event' ? item.inputs.map((i) => (i.indexed ? 1 : 0)).join('') : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.type === 'function') {
        const sel = toFunctionSelector(sig).toLowerCase();
        functions.set(sel, [...(functions.get(sel) ?? []), item]);
      } else {
        const topic = toEventSelector(sig).toLowerCase();
        events.set(topic, [...(events.get(topic) ?? []), item]);
      }
    }
  }
  const t = { functions, events };
  tableCache.set(abis, t);
  return t;
}

/** A decoded value made JSON-safe: big integers as decimal strings. */
export function plainValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plainValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainValue(x)]));
  return v;
}

function namedArgs(inputs: readonly AbiParameter[], values: readonly unknown[] | Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!values) return out;
  inputs.forEach((p, i) => {
    const key = p.name && p.name.length > 0 ? p.name : `arg${i}`;
    const v = Array.isArray(values) ? values[i] : (values as Record<string, unknown>)[p.name ?? ''];
    out[key] = plainValue(v);
  });
  return out;
}

function decodeCall(input: string | undefined, t: Tables): CallStep['function'] | undefined {
  if (!input || input.length < 10) return undefined;
  const candidates = t.functions.get(input.slice(0, 10).toLowerCase()) ?? [];
  for (const fn of candidates) {
    try {
      const d = decodeFunctionData({ abi: [fn], data: input as Hex });
      return { name: fn.name, signature: signatureOf(fn), args: namedArgs(fn.inputs, d.args as readonly unknown[] | undefined) };
    } catch {
      /* another candidate */
    }
  }
  return undefined;
}

function decodeLog(log: { topics: string[]; data: string }, t: Tables): EventStep['event'] | undefined {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return undefined;
  for (const ev of t.events.get(topic0) ?? []) {
    try {
      const d = decodeEventLog({ abi: [ev], topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      return { name: ev.name, signature: signatureOf(ev), args: namedArgs(ev.inputs, d.args as readonly unknown[] | Record<string, unknown>) };
    } catch {
      /* another layout */
    }
  }
  return undefined;
}

/**
 * Revert data decoded through the error catalogue: the error's name, values,
 * meaning, who can act and whether it is internal. Undefined for empty or
 * unknown data.
 */
export function decodeRevert(data: string | undefined): DecodedError | undefined {
  if (!data || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  const row = errorBySelector(selector);
  if (!row) return undefined;
  let args: Record<string, unknown> = {};
  try {
    const values = decodeAbiParameters(row.inputs as readonly AbiParameter[], `0x${data.slice(10)}` as Hex);
    args = namedArgs(row.inputs as readonly AbiParameter[], values);
  } catch {
    args = { undecodable: data };
  }
  const out: DecodedError = { selector, name: row.name, signature: row.signature, args };
  if (row.message) out.meaning = row.message;
  if (row.actor) out.actor = row.actor;
  if (row.internal) out.internal = true;
  if (row.name === 'Panic') {
    const code = Number(Object.values(args)[0] ?? NaN);
    out.panic = PANIC_CODES[code] ?? `panic code ${Object.values(args)[0]}`;
  }
  return out;
}

// ─── The walk ────────────────────────────────────────────────────────────

const lower = (a: string | undefined): string => (a ?? '').toLowerCase();
const hexToDec = (h: string | undefined): string | undefined => {
  if (h === undefined) return undefined;
  try {
    return BigInt(h).toString();
  } catch {
    return undefined;
  }
};

function codeOf(address: string, nameOf: ExplainInput['nameOf']): ExplainedCode {
  const n = nameOf(lower(address));
  const out: ExplainedCode = { address: lower(address) };
  if (n) {
    out.name = n.name;
    if (n.build) out.build = n.build;
  }
  return out;
}

/** The innermost failed frame, following the last failed child each time:
 *  the call its parent was running when it gave up. */
function innermostFailure(frame: CallFrame, depth = 0): { frame: CallFrame; depth: number } {
  const failed = (frame.calls ?? []).filter((c) => typeof c.error === 'string');
  const last = failed[failed.length - 1];
  return last ? innermostFailure(last, depth + 1) : { frame, depth };
}

interface WalkContext {
  t: Tables;
  nameOf: ExplainInput['nameOf'];
  steps: Step[];
  /** Each frame's step (a merged proxy frame and its delegate share one). */
  stepOf: Map<CallFrame, CallStep>;
}

/**
 * Flatten a trace into steps. A call to a proxy whose only work is to
 * delegate the same input on is shown as ONE step: the code it forwarded to,
 * "via" the proxy. Its children then sit one level below that step.
 */
function walk(frame: CallFrame, depth: number, undone: boolean, ctx: WalkContext): void {
  const failed = typeof frame.error === 'string';
  const isUndone = undone || failed;
  let run = frame;
  let via: ExplainedCode | undefined;
  const callee = frame.to ? ctx.nameOf(lower(frame.to)) : undefined;
  const first = frame.calls?.[0];
  if (
    callee?.kind === 'proxy' &&
    first &&
    first.type === 'DELEGATECALL' &&
    lower(first.input) === lower(frame.input) &&
    (frame.calls ?? []).length === 1
  ) {
    via = codeOf(frame.to!, ctx.nameOf);
    run = first;
  }
  const fn = decodeCall(run.input, ctx.t);
  const step: CallStep = {
    kind: 'call',
    depth,
    callType: frame.type,
    code: codeOf(run.to ?? '', ctx.nameOf),
    from: lower(frame.from),
    failed,
  };
  if (via) step.via = via;
  if (run.input && run.input.length >= 10) step.selector = run.input.slice(0, 10).toLowerCase();
  if (fn) step.function = fn;
  if (frame.value && frame.value !== '0x0' && BigInt(frame.value) !== 0n) step.value = BigInt(frame.value).toString();
  const gas = hexToDec(frame.gasUsed);
  if (gas !== undefined) step.gasUsed = gas;
  if (frame.error !== undefined) step.failure = frame.error;
  ctx.steps.push(step);
  ctx.stepOf.set(frame, step);
  ctx.stepOf.set(run, step);

  // Interleave the frame's logs and child calls in emission order. A merged
  // proxy step reads the forwarded frame's logs and calls, plus any log the
  // proxy itself emitted after forwarding (position > 0).
  const frames = via ? [run, frame] : [frame];
  const children: CallFrame[] = via ? (run.calls ?? []) : (frame.calls ?? []);
  const logsAt = new Map<number, TraceLog[]>();
  for (const f of frames) {
    for (const l of f.logs ?? []) {
      // A proxy's own log after its one forward is placed after every child.
      const pos = f === run ? Number(l.position ?? 0) : children.length;
      logsAt.set(pos, [...(logsAt.get(pos) ?? []), l]);
    }
  }
  const runFailed = isUndone || typeof run.error === 'string';
  const emit = (pos: number) => {
    for (const l of logsAt.get(pos) ?? []) {
      const ev = decodeLog(l, ctx.t);
      const e: EventStep = {
        kind: 'event',
        depth: depth + 1,
        address: lower(l.address),
        topics: l.topics,
        data: l.data,
        undone: runFailed,
      };
      const emitter = ctx.nameOf(lower(l.address));
      if (emitter) e.emitter = emitter.name;
      if (ev) e.event = ev;
      ctx.steps.push(e);
    }
  };
  children.forEach((c, i) => {
    emit(i);
    walk(c, depth + 1, runFailed, ctx);
  });
  emit(children.length);
}

/**
 * What differs between the chain's receipt and a rebuilt run's receipt:
 * success, gas used, and the events (count, then each address, topics and
 * data in order). Empty when they agree.
 */
export function compareWithReceipt(chain: ReceiptFacts, rebuilt: ReceiptFacts): string[] {
  const out: string[] = [];
  if (chain.status !== rebuilt.status) out.push(`on chain it ${chain.status === 'success' ? 'succeeded' : 'failed'}; the rebuild ${rebuilt.status === 'success' ? 'succeeded' : 'failed'}`);
  if (chain.gasUsed !== rebuilt.gasUsed) out.push(`gas used on chain ${chain.gasUsed}; in the rebuild ${rebuilt.gasUsed}`);
  if (chain.logs.length !== rebuilt.logs.length) {
    out.push(`events on chain ${chain.logs.length}; in the rebuild ${rebuilt.logs.length}`);
  } else {
    chain.logs.forEach((l, i) => {
      const r = rebuilt.logs[i]!;
      const same =
        lower(l.address) === lower(r.address) &&
        lower(l.data) === lower(r.data) &&
        l.topics.length === r.topics.length &&
        l.topics.every((t, j) => lower(t) === lower(r.topics[j]));
      if (!same) out.push(`event ${i + 1} differs (on chain from ${lower(l.address)}, in the rebuild from ${lower(r.address)})`);
    });
  }
  return out;
}

/** Explain a transaction or an attempt from its trace and receipt. */
export function explainTransaction(input: ExplainInput): Explanation {
  const t = tablesFor(input.abis);
  const steps: Step[] = [];
  const notes: string[] = [];
  const differences = input.rebuildDifferences ?? [];
  const approximate = input.source === 'rebuilt' && differences.length > 0;

  let heading: string;
  switch (input.source) {
    case 'node-trace':
      heading = "From the node's trace of the mined transaction.";
      break;
    case 'rebuilt':
      heading = approximate
        ? 'Approximate replay: what happened on chain is not shown here.'
        : 'Rebuilt from the parent block with the earlier transactions of the block applied, and matching the receipt.';
      break;
    case 'attempt':
      heading = `A simulation of an attempt that was never sent, on the state at the end of block ${input.subject.blockNumber}. It is not a record of anything that happened.`;
      break;
    default:
      heading = 'No trace: only the receipt is shown. The functions that ran and the code that ran are not known.';
  }

  let outcome: Explanation['outcome'] = 'unknown';
  let gasUsed: string | undefined;
  let stop: StopPoint | undefined;

  if (input.trace && input.source !== 'none') {
    const stepOf = new Map<CallFrame, CallStep>();
    walk(input.trace, 0, false, { t, nameOf: input.nameOf, steps, stepOf });
    const topFailed = typeof input.trace.error === 'string';
    outcome = topFailed ? 'failed' : 'succeeded';
    gasUsed = input.receipt && input.source !== 'attempt' ? input.receipt.gasUsed.toString() : hexToDec(input.trace.gasUsed);
    if (topFailed) {
      const inner = innermostFailure(input.trace);
      const s: StopPoint = {};
      if (input.trace.error !== undefined) s.failure = input.trace.error;
      const err = decodeRevert(input.trace.output);
      if (err) s.error = err;
      else if (input.trace.output && input.trace.output !== '0x') s.rawData = input.trace.output;
      else s.emptyRevert = emptyRevertSentence(inner.frame);
      const originStep = stepOf.get(inner.frame);
      if (originStep) {
        s.origin = { depth: originStep.depth, code: originStep.code };
        if (originStep.function) s.origin.function = originStep.function.name;
      }
      if (lower(inner.frame.output) !== lower(input.trace.output)) {
        const oe = decodeRevert(inner.frame.output);
        if (oe) s.originError = oe;
      }
      stop = s;
    }
    if (input.source === 'node-trace' && input.receipt && (input.receipt.status === 'reverted') !== topFailed) {
      notes.push("The node's trace and its receipt disagree on whether the transaction failed.");
    }
  } else {
    if (input.noTraceReason) notes.push(input.noTraceReason);
    if (input.receipt) {
      outcome = input.receipt.status === 'success' ? 'succeeded' : 'failed';
      gasUsed = input.receipt.gasUsed.toString();
      for (const l of input.receipt.logs) {
        const e: EventStep = { kind: 'event', depth: 0, address: lower(l.address), topics: l.topics, data: l.data, undone: false };
        const ev = decodeLog(l, t);
        const emitter = input.nameOf(lower(l.address));
        if (emitter) e.emitter = emitter.name;
        if (ev) e.event = ev;
        steps.push(e);
      }
      if (outcome === 'failed') notes.push('A receipt does not carry the error; without a trace the error is not known.');
    }
    const r = input.routes;
    if (r && (r.atBlockStart || r.atBlockEnd)) {
      const show = (a: string | undefined) => (a ? describeCode(codeOf(a, input.nameOf)) : 'no route');
      if (lower(r.atBlockStart) !== lower(r.atBlockEnd)) {
        notes.push(`The route for ${r.selector} changed within the block: ${show(r.atBlockStart)} at its start, ${show(r.atBlockEnd)} at its end. Which of them ran is not known.`);
      } else {
        notes.push(`The route for ${r.selector} pointed at ${show(r.atBlockStart)} at both the start and the end of the block. That is the route in force, not a record of the code that ran.`);
      }
    }
  }

  if (input.source === 'rebuilt' && approximate) {
    notes.push('The rebuild ran under the same block number and time, on a local copy whose base fee and block producer may differ from the chain.');
  }
  const unknown = steps.filter((s): s is CallStep => s.kind === 'call' && !s.code.name && s.code.address !== '');
  if (unknown.length > 0) {
    notes.push(`Code at ${[...new Set(unknown.map((s) => s.code.address))].join(', ')} is not in the deployment record this explanation was given; it may be code a later refresh replaced, or a contract outside the platform.`);
  }

  const undecodedCalls = steps.filter((s) => s.kind === 'call' && !s.function && s.selector).length;
  const undecodedEvents = steps.filter((s) => s.kind === 'event' && !s.event).length;
  if (undecodedCalls + undecodedEvents > 0) {
    notes.push(
      `${undecodedCalls} call(s) and ${undecodedEvents} event(s) match no ABI this explanation was given. For the platform's own code that means the code that ran was built from a different version than these ABIs; for outside code, its interface is not known here.`,
    );
  }

  const out: Explanation = { subject: input.subject, source: input.source, heading, approximate, outcome, steps, differences, notes };
  if (gasUsed !== undefined) out.gasUsed = gasUsed;
  if (stop) out.stop = stop;
  return out;
}

function emptyRevertSentence(frame: CallFrame): string {
  const err = lower(frame.error);
  if (err.includes('out of gas')) return 'The innermost call ran out of gas.';
  if (frame.type === 'CALL' && (!frame.input || frame.input === '0x')) return 'A plain value transfer was refused.';
  return 'It stopped with no error data: a bare revert, a refused call to code with no matching function, or a failure the caller passed on without a reason.';
}

// ─── Rendering ───────────────────────────────────────────────────────────

function describeCode(c: ExplainedCode): string {
  if (!c.name) return `unknown code at ${c.address}`;
  return c.build ? `${c.name} (${c.address}, build ${c.build})` : `${c.name} (${c.address})`;
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${formatValue(x)}`).join(', ')}}`;
  return String(v);
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(', ');
}

function formatError(e: DecodedError): string[] {
  const lines = [`${e.name}(${formatArgs(e.args)})`];
  if (e.panic) lines.push(`  A Solidity panic: ${e.panic}.`);
  if (e.internal) lines.push('  Marked as should-be-impossible: a fault of the platform, not of the caller.');
  if (e.meaning) lines.push(`  Meaning: ${e.meaning}`);
  else if (!e.panic) lines.push('  No meaning is written for this error yet.');
  if (e.actor) lines.push(`  Who can act on it: ${e.actor === 'nobody' ? 'nobody (report it)' : e.actor === 'operator' ? 'an operator' : 'the user'}`);
  return lines;
}

/** The explanation as plain text, for an operator's terminal or a case file. */
export function renderExplanation(e: Explanation): string {
  const lines: string[] = [];
  const s = e.subject;
  if (s.kind === 'transaction') {
    const where = s.blockNumber !== undefined ? `, block ${s.blockNumber}${s.transactionIndex !== undefined ? ` (position ${s.transactionIndex})` : ''}` : '';
    lines.push(`Transaction ${s.hash} on chain ${s.chainId}${where}`);
  } else {
    lines.push(`Attempt by ${s.from} to ${s.to} on chain ${s.chainId}, at the end of block ${s.blockNumber}`);
  }
  lines.push(e.approximate ? `*** ${e.heading} ***` : e.heading);
  if (e.differences.length > 0) {
    lines.push('What differed from the chain:');
    for (const d of e.differences) lines.push(`  - ${d}`);
  }
  const gasLimit = s.kind === 'transaction' && s.gasLimit !== undefined ? ` of ${s.gasLimit}` : '';
  const outcome = e.outcome === 'unknown' ? 'not known' : e.outcome;
  lines.push(`Outcome: ${outcome}${e.gasUsed !== undefined ? `, gas used ${e.gasUsed}${gasLimit}` : ''}`);

  if (e.steps.length > 0) {
    lines.push('', e.steps.some((x) => x.kind === 'call') ? 'Steps:' : 'Events (from the receipt):');
    for (const st of e.steps) {
      const pad = '  '.repeat(st.depth + 1);
      if (st.kind === 'call') {
        const what = st.function ? `${st.function.name}(${formatArgs(st.function.args)})` : st.selector ? `function ${st.selector}` : st.callType.startsWith('CREATE') ? 'contract creation' : 'plain transfer';
        const who = st.code.name ? `${st.code.name}.` : `unknown code at ${st.code.address}: `;
        const via = st.via ? ` via ${st.via.name ?? st.via.address}` : '';
        const kind = st.callType === 'STATICCALL' ? ' (read)' : st.callType === 'DELEGATECALL' && !st.via ? ' (delegated)' : '';
        const value = st.value ? `, value ${st.value} wei` : '';
        const gas = st.gasUsed !== undefined ? `, gas ${st.gasUsed}` : '';
        const fail = st.failed ? `  FAILED (${st.failure})` : '';
        lines.push(`${pad}${who}${what}${via}${kind}${value}${gas}${fail}`);
      } else {
        const name = st.event ? `${st.event.name}(${formatArgs(st.event.args)})` : `undecoded event ${st.topics[0] ?? '(no topic)'}`;
        const from = st.emitter ?? st.address;
        lines.push(`${pad}event ${name} from ${from}${st.undone ? '  (undone: its call failed)' : ''}`);
      }
    }
  }

  if (e.stop) {
    lines.push('', 'Where it stopped:');
    const st = e.stop;
    if (st.error) lines.push(...formatError(st.error).map((l) => `  ${l}`));
    else if (st.rawData) lines.push(`  Undecoded error data ${st.rawData}`);
    else if (st.emptyRevert) lines.push(`  ${st.emptyRevert}`);
    if (st.failure) lines.push(`  The node reported: ${st.failure}`);
    if (st.origin) {
      lines.push(`  It began in ${describeCode(st.origin.code)}${st.origin.function ? `.${st.origin.function}` : ''}, at depth ${st.origin.depth}.`);
    }
    if (st.originError) {
      lines.push('  There it was first raised as:');
      lines.push(...formatError(st.originError).map((l) => `    ${l}`));
    }
  }

  if (e.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of e.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}

// ─── Names from a deployment record ──────────────────────────────────────

const SPECIAL_NAMES: Readonly<Record<string, string>> = {
  diamond: 'VaipakamDiamond',
  vaultImpl: 'VaipakamVaultImplementation',
};

/**
 * A name for every address a deployment record holds: each facet by its
 * contract name, the Diamond as the proxy, the other keys by their key in
 * PascalCase. The record names the CURRENT code only, so code a refresh
 * replaced is unknown to it; the facet history (#3921) will name that too.
 */
export function codeNamesFromDeployment(dep: {
  facets?: Readonly<Record<string, string | undefined>>;
  [key: string]: unknown;
}): (address: string) => CodeName | undefined {
  const byAddress = new Map<string, CodeName>();
  const pascal = (k: string) => SPECIAL_NAMES[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
  for (const [k, v] of Object.entries(dep)) {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    byAddress.set(v.toLowerCase(), { name: pascal(k), kind: k === 'diamond' ? 'proxy' : 'code' });
  }
  for (const [k, v] of Object.entries(dep.facets ?? {})) {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) byAddress.set(v.toLowerCase(), { name: pascal(k), kind: 'code' });
  }
  return (address) => byAddress.get(address.toLowerCase());
}
