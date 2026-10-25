// #2841 — the drives' chain reads go through the app's answer-shape rule.
// Each case runs the same answer through a plain viem client and the
// checked one: where the shape matches, the two must agree exactly (value,
// error class and cause); where it does not, the checked one must refuse
// to decode and record why. The record is module state, so each case
// imports a fresh module.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import * as rule from '@vaipakam/lib/staticReturn';

const DIAMOND = '0x1111111111111111111111111111111111111111';
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = parseAbi([
  'function bundle() view returns (uint256 a, uint256 b, bool c)',
  'function names() view returns (string[])',
  'function over(uint256 x) view returns (uint256)',
  'function over(uint256 x, uint256 y) view returns (uint256, uint256)',
  'function boom() view returns (uint256)',
]);
const word = (n) => n.toString(16).padStart(64, '0');
const BUNDLE_3 = `0x${word(7n)}${word(9n)}${word(1n)}`;
// The answer a different build gives: one word more, so viem's positional
// decode would read it without an error.
const BUNDLE_4 = `0x${word(7n)}${word(1n)}${word(0n)}${word(1n)}`;
// not-a-source-region: drops the 0x prefix of an encoded revert reason
const REVERT = `0x08c379a0${encodeAbiParameters([{ type: 'string' }], ['no']).slice(2)}`;

/** A transport answering eth_call from `answers`, keyed by selector (a
 *  function returns the answer, or throws a revert). */
function transport(answers) {
  return custom({
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x14a34';
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const { to, data } = params[0];
      // not-a-source-region: the 4-byte selector of a call's data
      const answer = to.toLowerCase() === MC.toLowerCase() ? answers.aggregate3 : answers[data.slice(0, 10)];
      if (answer === REVERT) throw Object.assign(new Error('execution reverted: no'), { code: 3, data: REVERT });
      return answer;
    },
  });
}
const sel = (sig) => toFunctionSelector(sig);

let mod;
beforeEach(async () => {
  vi.resetModules();
  mod = await import('./shapeCheckedClient.mjs');
});
const clients = (answers, loadRule = async () => rule) => {
  const plain = createPublicClient({ transport: transport(answers) });
  return { plain, checked: mod.shapeChecked(createPublicClient({ transport: transport(answers) }), loadRule) };
};
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

describe('readContract through the answer-shape rule', () => {
  it('decodes an answer of the shape this ABI describes exactly as viem does', async () => {
    const { plain, checked } = clients({ [sel('bundle()')]: BUNDLE_3 });
    const q = { address: DIAMOND, abi: ABI, functionName: 'bundle' };
    expect(await checked.readContract(q)).toEqual(await plain.readContract(q));
    expect(mod.shapeBlock()).toBeNull();
  });

  it('refuses a longer answer viem would have decoded by position, and records why', async () => {
    const { plain, checked } = clients({ [sel('bundle()')]: BUNDLE_4 });
    const q = { address: DIAMOND, abi: ABI, functionName: 'bundle', blockNumber: 12n };
    // The defect being closed: viem reads the neighbour without an error.
    expect(await plain.readContract(q)).toEqual([7n, 1n, false]);
    const { error } = await settle(checked.readContract(q));
    expect(error).toBeInstanceOf(mod.LiveShapeMismatchError);
    expect(error.name).toBe('LiveShapeMismatchError');
    const why = rule.describeShapeMismatch('bundle', { gotBytes: 128, expectedBytes: 96 });
    expect(error.message).toBe(`${why} (${DIAMOND} at block 12)`);
    expect(mod.shapeBlock()).toBe(error.message);
  });

  it('refuses a shorter answer too, and keeps the FIRST reason it saw', async () => {
    const { checked } = clients({ [sel('bundle()')]: `0x${word(7n)}${word(9n)}` });
    const first = await settle(checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'bundle' }));
    expect(first.error).toBeInstanceOf(mod.LiveShapeMismatchError);
    await settle(checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'bundle', blockNumber: 1n }));
    expect(mod.shapeBlock()).toBe(first.error.message);
  });

  it('picks the overload the arguments name', async () => {
    const two = `0x${word(3n)}${word(4n)}`;
    const { checked } = clients({ [sel('over(uint256,uint256)')]: two, [sel('over(uint256)')]: `0x${word(5n)}` });
    expect(await checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'over', args: [1n, 2n] })).toEqual([
      3n,
      4n,
    ]);
    expect(await checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'over', args: [1n] })).toBe(5n);
    expect(mod.shapeBlock()).toBeNull();
  });

  it('leaves a dynamic-output getter to viem: its length is not fixed', async () => {
    const answer = encodeFunctionResult({ abi: ABI, functionName: 'names', result: ['x', 'yz'] });
    const { plain, checked } = clients({ [sel('names()')]: answer });
    const q = { address: DIAMOND, abi: ABI, functionName: 'names' };
    expect(await checked.readContract(q)).toEqual(await plain.readContract(q));
  });

  it('fails an empty answer and a revert with the error viem raises', async () => {
    const { plain, checked } = clients({ [sel('bundle()')]: '0x', [sel('boom()')]: REVERT });
    for (const functionName of ['bundle', 'boom']) {
      const q = { address: DIAMOND, abi: ABI, functionName };
      const a = await settle(plain.readContract(q));
      const b = await settle(checked.readContract(q));
      expect(b.error?.name).toBe(a.error?.name);
      expect(b.error?.cause?.name).toBe(a.error?.cause?.name);
      expect(b.error?.shortMessage).toBe(a.error?.shortMessage);
    }
    expect(mod.shapeBlock()).toBeNull();
  });

  it('refuses a parameter it does not implement instead of dropping it', async () => {
    const { checked } = clients({ [sel('bundle()')]: BUNDLE_3 });
    await expect(
      checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'bundle', blockTag: 'safe' }),
    ).rejects.toThrow(/unsupported parameter\(s\) blockTag/);
    expect(mod.shapeBlock()).toBeNull();
  });

  it('records a rule that cannot be loaded as the reason the run cannot verify', async () => {
    const { checked } = clients({ [sel('bundle()')]: BUNDLE_3 }, async () => {
      throw new Error('no tsx');
    });
    const { error } = await settle(checked.readContract({ address: DIAMOND, abi: ABI, functionName: 'bundle' }));
    expect(error).toBeInstanceOf(mod.LiveShapeMismatchError);
    expect(mod.shapeBlock()).toMatch(/cannot load the answer-shape rule .*no tsx/);
  });
});

describe('readRaw through the answer-shape rule', () => {
  it('returns the bytes of an answer that has its shape, and 0x for an empty one', async () => {
    const { checked } = clients({ [sel('bundle()')]: BUNDLE_3, [sel('boom()')]: '0x' });
    expect(await checked.readRaw({ address: DIAMOND, abi: ABI, functionName: 'bundle', blockNumber: 2n })).toBe(BUNDLE_3);
    expect(await checked.readRaw({ address: DIAMOND, abi: ABI, functionName: 'boom' })).toBe('0x');
    expect(mod.shapeBlock()).toBeNull();
  });

  it('refuses the bytes of an answer of another shape, and records why', async () => {
    const { checked } = clients({ [sel('bundle()')]: BUNDLE_4 });
    const { error } = await settle(checked.readRaw({ address: DIAMOND, abi: ABI, functionName: 'bundle', blockNumber: 2n }));
    expect(error).toBeInstanceOf(mod.LiveShapeMismatchError);
    expect(mod.shapeBlock()).toMatch(/^bundle answered 4 words, .* at block 2\)$/);
  });
});

describe('multicall through the answer-shape rule', () => {
  const aggregate = (entries) =>
    encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: entries });
  const contracts = [
    { address: DIAMOND, abi: ABI, functionName: 'bundle' },
    { address: DIAMOND, abi: ABI, functionName: 'boom' },
  ];

  it('returns what viem returns when every answer has its shape', async () => {
    const answers = {
      aggregate3: aggregate([
        { success: true, returnData: BUNDLE_3 },
        { success: false, returnData: REVERT },
      ]),
    };
    const { plain, checked } = clients(answers);
    const q = { allowFailure: true, multicallAddress: MC, blockNumber: 3n, contracts };
    const a = await plain.multicall(q);
    const b = await checked.multicall(q);
    expect(b[0]).toEqual(a[0]);
    expect(b[1].status).toBe(a[1].status);
    expect(b[1].error.name).toBe(a[1].error.name);
    expect(b[1].error.shortMessage).toBe(a[1].error.shortMessage);
    expect(mod.shapeBlock()).toBeNull();
  });

  it('refuses the whole call when one answer has another shape, rather than a failed slot', async () => {
    const answers = {
      aggregate3: aggregate([
        { success: true, returnData: BUNDLE_4 },
        { success: false, returnData: REVERT },
      ]),
    };
    const { checked } = clients(answers);
    const { error } = await settle(
      checked.multicall({ allowFailure: true, multicallAddress: MC, blockNumber: 3n, contracts }),
    );
    expect(error).toBeInstanceOf(mod.LiveShapeMismatchError);
    expect(mod.shapeBlock()).toMatch(/^bundle answered 4 words, .* \(0x1111111111111111111111111111111111111111 at block 3\)$/);
  });

  it('needs the multicall address named', async () => {
    const { checked } = clients({});
    await expect(checked.multicall({ contracts })).rejects.toThrow(/multicallAddress is required/);
  });
});
