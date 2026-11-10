import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi } from 'viem';
import { readRevertCause, revertSentence, type RevertReader } from './revertCause';

const HASH = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const FROM = ('0x' + '1'.repeat(40)) as `0x${string}`;
const TO = ('0x' + '2'.repeat(40)) as `0x${string}`;
const receipt = { transactionHash: HASH, blockNumber: 100n, gasUsed: 50_000n };
const tx = { from: FROM, to: TO, input: '0x1234' as `0x${string}`, value: 0n, gas: 200_000n };

function reader(over: Partial<RevertReader> = {}): RevertReader & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getTransaction: async () => tx,
    call: async (args) => {
      calls.push(args);
      return '0x';
    },
    ...over,
  };
}

function protocolRevert(): Error {
  const abi = parseAbi(['error OfferExpired()']);
  const data = encodeErrorResult({ abi, errorName: 'OfferExpired' });
  return new BaseError('call reverted', { cause: new ContractFunctionRevertedError({ abi, data, functionName: 'acceptOffer' }) });
}

const format = (key: string, vars: Record<string, string>) => `${key}|${JSON.stringify(vars)}`;

describe('readRevertCause', () => {
  it('reads a spent gas allowance as out of gas, without replaying', async () => {
    const r = reader();
    const cause = await readRevertCause(r, { ...receipt, gasUsed: 200_000n });
    expect(cause).toEqual({ kind: 'out-of-gas', gasLimit: 200_000n });
    expect(r.calls).toHaveLength(0);
  });
  it('replays the call on the state just before its block, as sent', async () => {
    const r = reader({ call: async () => Promise.reject(protocolRevert()) });
    const calls: unknown[] = [];
    const spy: RevertReader = { ...r, call: async (args) => (calls.push(args), r.call(args)) };
    const cause = await readRevertCause(spy, receipt);
    expect(calls[0]).toEqual({ account: FROM, to: TO, data: '0x1234', value: 0n, gas: 200_000n, blockNumber: 99n });
    expect(cause.kind).toBe('refused');
    expect(cause.kind === 'refused' && cause.reason).toMatch(/^The protocol refused this step: /);
  });
  it('says the block changed things when the replay goes through', async () => {
    expect(await readRevertCause(reader(), receipt)).toEqual({ kind: 'replay-passes' });
  });
  it('names a replay that could not run as unread, never as a reason', async () => {
    const cause = await readRevertCause(reader({ call: async () => Promise.reject(new Error('missing trie node')) }), receipt);
    expect(cause).toEqual({ kind: 'unread', reason: 'the replay failed: missing trie node' });
  });
  it('keeps an unnamed revert the node reports as a refusal', async () => {
    const cause = await readRevertCause(reader({ call: async () => Promise.reject(new Error('execution reverted')) }), receipt);
    expect(cause.kind).toBe('refused');
  });
  it('names an unreadable transaction as unread', async () => {
    const cause = await readRevertCause(reader({ getTransaction: async () => Promise.reject(new Error('timeout')) }), receipt);
    expect(cause).toEqual({ kind: 'unread', reason: 'the transaction could not be read: timeout' });
  });
});

describe('revertSentence', () => {
  it('writes the gas allowance exact, and every reason as a sentence', () => {
    expect(revertSentence({ kind: 'out-of-gas', gasLimit: 1_234_567n }, format)).toBe('flow.revertOutOfGas|{"gas":"1,234,567"}');
    expect(revertSentence({ kind: 'refused', reason: 'The protocol refused this step: offer expired' }, format)).toBe(
      'flow.revertRefused|{"reason":"The protocol refused this step: offer expired."}',
    );
    expect(revertSentence({ kind: 'unread', reason: 'timeout.' }, format)).toBe('flow.revertUnread|{"reason":"timeout."}');
    expect(revertSentence({ kind: 'replay-passes' }, format)).toBe('flow.revertReplayPasses|{}');
  });
});
