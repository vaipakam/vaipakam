/**
 * The transaction explainer (#3917), from recorded traces in the shape a
 * node's call tracer returns. Acceptance test 1 of the troubleshooting design:
 * a revert three facets deep, the code that ran before a refresh, and a
 * rebuild that does not match its receipt.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Hex,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { ERROR_CATALOGUE } from '@vaipakam/contracts/error-catalogue';
import {
  codeNamesFromDeployment,
  compareWithReceipt,
  explainTransaction,
  renderExplanation,
  type CallFrame,
  type CallStep,
  type EventStep,
  type ExplainInput,
  type ReceiptFacts,
} from './txExplainer';

const DIAMOND = '0x00000000000000000000000000000000000d1a00';
const FACET_A = '0x00000000000000000000000000000000000000a1';
const FACET_B = '0x00000000000000000000000000000000000000b2';
const FACET_C = '0x00000000000000000000000000000000000000c3';
const OLD_C = '0x00000000000000000000000000000000000000c0';
const USER = '0x0000000000000000000000000000000000001234';

const nameOf = codeNamesFromDeployment({
  diamond: DIAMOND,
  facets: { offerAcceptFacet: FACET_A, loanFacet: FACET_B, riskFacet: FACET_C },
});

const abis: readonly Abi[] = [DIAMOND_ABI_VIEM];
const call = (functionName: string, args: readonly unknown[]): Hex =>
  encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName, args } as never);

const FLOOR = encodeErrorResult({
  abi: parseAbi(['error ListingFloorBelowReviewed(uint256 a, uint256 b)']),
  errorName: 'ListingFloorBelowReviewed',
  args: [5n, 7n],
});
const SEQUENCER_DOWN = encodeErrorResult({ abi: parseAbi(['error SequencerDown()']), errorName: 'SequencerDown' });

const EVENT_ABI = parseAbi(['event SignedOfferNonceBurned(address indexed maker, uint256 nonce)']);
const nonceLog = (nonce: bigint) => ({
  address: DIAMOND,
  topics: encodeEventTopics({ abi: EVENT_ABI, eventName: 'SignedOfferNonceBurned', args: { maker: USER } }) as string[],
  data: encodeAbiParameters([{ type: 'uint256' }], [nonce]),
});

/** A call through the Diamond: the proxy frame and its one delegate. */
function viaDiamond(from: string, facet: string, input: Hex, inner: Partial<CallFrame> = {}): CallFrame {
  const delegate: CallFrame = { type: 'DELEGATECALL', from: DIAMOND, to: facet, input, gasUsed: '0x100', ...inner };
  const outer: CallFrame = { type: 'CALL', from, to: DIAMOND, input, gasUsed: '0x110', calls: [delegate] };
  if (inner.error) {
    outer.error = inner.error;
    if (inner.output !== undefined) outer.output = inner.output;
  }
  return outer;
}

function threeDeep(cAddress: string): CallFrame {
  const inputA = call('repayLoan', [7n]);
  const inputB = call('repayPartial', [1n, 2n]);
  const inputC = call('triggerLiquidation', [1n, 0n, []]);
  const c = viaDiamond(DIAMOND, cAddress, inputC, { error: 'execution reverted', output: FLOOR });
  const b = viaDiamond(DIAMOND, FACET_B, inputB, { error: 'execution reverted', output: FLOOR, calls: [c] });
  return viaDiamond(USER, FACET_A, inputA, { error: 'execution reverted', output: FLOOR, calls: [b] });
}

const subject = { kind: 'transaction' as const, hash: '0xabc', chainId: 84532, blockNumber: 100n, transactionIndex: 2 };
const failedReceipt: ReceiptFacts = { status: 'reverted', gasUsed: 50_000n, logs: [] };
const base = (over: Partial<ExplainInput>): ExplainInput => ({ subject, source: 'node-trace', receipt: failedReceipt, abis, nameOf, ...over });
const calls = (steps: ReturnType<typeof explainTransaction>['steps']) => steps.filter((s): s is CallStep => s.kind === 'call');

describe('explainTransaction', () => {
  it('a revert three facets deep: the three functions in order, and the error with its values and meaning', () => {
    const e = explainTransaction(base({ trace: threeDeep(FACET_C) }));
    expect(e.outcome).toBe('failed');
    expect(calls(e.steps).map((s) => [s.depth, s.code.name, s.function?.name, s.via?.name])).toEqual([
      [0, 'OfferAcceptFacet', 'repayLoan', 'VaipakamDiamond'],
      [1, 'LoanFacet', 'repayPartial', 'VaipakamDiamond'],
      [2, 'RiskFacet', 'triggerLiquidation', 'VaipakamDiamond'],
    ]);
    expect(e.stop?.error?.name).toBe('ListingFloorBelowReviewed');
    expect(Object.values(e.stop!.error!.args)).toEqual(['5', '7']);
    expect(e.stop?.error?.meaning).toBe(ERROR_CATALOGUE[e.stop!.error!.selector]!.message);
    expect(e.stop?.origin?.code.name).toBe('RiskFacet');
    expect(e.stop?.origin?.depth).toBe(2);
    expect(e.stop?.originError).toBeUndefined();
    const text = renderExplanation(e);
    expect(text).toContain('RiskFacet.triggerLiquidation');
    expect(text).toContain('ListingFloorBelowReviewed(');
    expect(text).toContain('Meaning:');
  });

  it('names the code the trace shows ran, even when a refresh has since replaced it', () => {
    const before = (addr: string) =>
      addr.toLowerCase() === OLD_C ? { name: 'RiskFacet', build: 'v1' } : nameOf(addr);
    const e = explainTransaction(base({ trace: threeDeep(OLD_C), nameOf: before }));
    const c = calls(e.steps)[2]!;
    expect(c.code).toEqual({ address: OLD_C, name: 'RiskFacet', build: 'v1' });

    // A record that knows only the current code says it does not know the old one.
    const now = explainTransaction(base({ trace: threeDeep(OLD_C) }));
    expect(calls(now.steps)[2]!.code.name).toBeUndefined();
    expect(now.notes.join(' ')).toContain(OLD_C);
  });

  it('a rebuild that does not match its receipt is headed as an approximate replay', () => {
    const rebuilt: ReceiptFacts = { status: 'reverted', gasUsed: 50_100n, logs: [] };
    const differences = compareWithReceipt(failedReceipt, rebuilt);
    expect(differences).toEqual(['gas used on chain 50000; in the rebuild 50100']);
    const e = explainTransaction(base({ source: 'rebuilt', trace: threeDeep(FACET_C), rebuildDifferences: differences }));
    expect(e.approximate).toBe(true);
    expect(e.heading).toMatch(/^Approximate replay: what happened on chain is not shown here/);
    expect(renderExplanation(e)).toContain('*** Approximate replay');

    const matching = explainTransaction(base({ source: 'rebuilt', trace: threeDeep(FACET_C), rebuildDifferences: compareWithReceipt(failedReceipt, failedReceipt) }));
    expect(matching.approximate).toBe(false);
    expect(matching.heading).toContain('matching the receipt');
  });

  it('compares success and every event of a rebuild', () => {
    const ok: ReceiptFacts = { status: 'success', gasUsed: 1n, logs: [nonceLog(1n)] };
    expect(compareWithReceipt(ok, { ...ok, status: 'reverted', logs: [] })).toEqual([
      'on chain it succeeded; the rebuild failed',
      'events on chain 1; in the rebuild 0',
    ]);
    expect(compareWithReceipt(ok, { ...ok, logs: [nonceLog(2n)] })).toHaveLength(1);
  });

  it('places events in emission order and marks those a failed call undid', () => {
    const inner = viaDiamond(DIAMOND, FACET_B, call('repayPartial', [1n, 2n]), {
      error: 'execution reverted',
      output: SEQUENCER_DOWN,
      logs: [{ ...nonceLog(2n), position: '0x0' }],
    });
    const top = viaDiamond(USER, FACET_A, call('repayLoan', [7n]), {
      calls: [inner],
      logs: [
        { ...nonceLog(1n), position: '0x0' },
        { ...nonceLog(3n), position: '0x1' },
      ],
    });
    const e = explainTransaction(base({ trace: top, receipt: { status: 'success', gasUsed: 1n, logs: [] } }));
    expect(e.outcome).toBe('succeeded');
    expect(e.stop).toBeUndefined();
    const order = e.steps.map((s) => (s.kind === 'call' ? s.function?.name : `${(s as EventStep).event?.args.nonce}${(s as EventStep).undone ? ' undone' : ''}`));
    expect(order).toEqual(['repayLoan', '1', 'repayPartial', '2 undone', '3']);
  });

  it('shows where an error began when a caller turned it into another', () => {
    const c = viaDiamond(DIAMOND, FACET_C, call('triggerLiquidation', [1n, 0n, []]), { error: 'execution reverted', output: SEQUENCER_DOWN });
    const top = viaDiamond(USER, FACET_A, call('repayLoan', [7n]), { error: 'execution reverted', output: FLOOR, calls: [c] });
    const e = explainTransaction(base({ trace: top }));
    expect(e.stop?.error?.name).toBe('ListingFloorBelowReviewed');
    expect(e.stop?.originError?.name).toBe('SequencerDown');
    expect(e.stop?.origin?.code.name).toBe('RiskFacet');
  });

  it('reads a panic as a fault of the platform, and an empty revert in words', () => {
    const panic = encodeErrorResult({ abi: parseAbi(['error Panic(uint256 code)']), errorName: 'Panic', args: [0x11n] });
    const p = explainTransaction(base({ trace: viaDiamond(USER, FACET_A, call('repayLoan', [7n]), { error: 'execution reverted', output: panic }) }));
    expect(p.stop?.error?.internal).toBe(true);
    expect(p.stop?.error?.panic).toBe('an arithmetic overflow or underflow');

    const oog = viaDiamond(USER, FACET_A, call('repayLoan', [7n]), { error: 'out of gas', output: '0x' });
    const o = explainTransaction(base({ trace: oog }));
    expect(o.stop?.error).toBeUndefined();
    expect(o.stop?.emptyRevert).toBe('The innermost call ran out of gas.');
  });

  it('with no trace, shows the receipt and both routes, and never names the code that ran', () => {
    const e = explainTransaction(
      base({
        source: 'none',
        noTraceReason: 'The node gave no trace.',
        receipt: { status: 'success', gasUsed: 9n, logs: [nonceLog(4n)] },
        routes: { selector: '0x12345678', atBlockStart: OLD_C, atBlockEnd: FACET_C },
      }),
    );
    expect(e.outcome).toBe('succeeded');
    expect(calls(e.steps)).toEqual([]);
    expect((e.steps[0] as EventStep).event?.name).toBe('SignedOfferNonceBurned');
    expect(e.notes.join(' ')).toContain('changed within the block');
    expect(e.notes.join(' ')).toContain('Which of them ran is not known');
    expect(e.heading).toContain('code that ran are not known');
  });

  it('an attempt is headed as a simulation, never a record', () => {
    const e = explainTransaction({
      subject: { kind: 'attempt', chainId: 1, from: USER, to: DIAMOND, data: '0x', blockNumber: 5n },
      source: 'attempt',
      trace: threeDeep(FACET_C),
      abis,
      nameOf,
    });
    expect(e.heading).toContain('never sent');
    expect(e.heading).toContain('not a record');
  });

  it('writes data that survives JSON', () => {
    const e = explainTransaction(base({ trace: threeDeep(FACET_C) }));
    const json = JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(JSON.parse(json).stop.error.name).toBe('ListingFloorBelowReviewed');
  });
});
