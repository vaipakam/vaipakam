import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { PRICE_GUARD } from '../offers/priceGuard';
import { guardConsequences, guardPostLeg, guardRows, postCall } from './guardPost';
import { CREATE_ABI } from './postReview';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
} as unknown as Parameters<typeof guardRows>[1];

/** A createOffer argument as the ABI encodes it: every field zero. */
function zeroParams(): Record<string, unknown> {
  const fn = CREATE_ABI.find((i) => i.type === 'function' && i.name === 'createOffer') as unknown as {
    inputs: { components: { name: string; type: string }[] }[];
  };
  const zero = (t: string): unknown =>
    t === 'address' ? '0x0000000000000000000000000000000000000000' : t === 'bool' ? false : t.startsWith('bytes') ? '0x' : 0n;
  return Object.fromEntries(fn.inputs[0]!.components.map((c) => [c.name, zero(c.type)]));
}

describe('postCall', () => {
  it('posts with createOffer alone when no guard is armed', () => {
    const call = postCall(CREATE_ABI, zeroParams(), null);
    expect(call.functionName).toBe('createOffer');
    expect(call.abi).toBe(CREATE_ABI);
  });

  it('arms the guard first, then posts, in one batch that fails whole', () => {
    const params = zeroParams();
    const call = postCall(CREATE_ABI, params, 500);
    expect(call.functionName).toBe('multicall');
    const [calls] = call.args as unknown as [{ callData: Hex; allowFailure: boolean }[]];
    expect(calls.map((c) => c.allowFailure)).toEqual([false, false]);
    const arm = decodeFunctionData({ abi: PRICE_GUARD, data: calls[0]!.callData });
    expect(arm).toMatchObject({ functionName: 'armOfferPriceGuard', args: [500] });
    expect(decodeFunctionData({ abi: CREATE_ABI, data: calls[1]!.callData }).functionName).toBe('createOffer');
    // Both steps' refusals stay nameable through the batch, each once.
    const errors = (call.abi as Abi).filter((i) => i.type === 'error').map((i) => (i as { name: string }).name);
    expect(errors).toContain('OfferPriceGuardUnpriced');
    expect(errors).toContain('ParameterOutOfRange');
    expect(errors).toContain('AmountMustBePositive');
    expect(new Set(errors).size).toBe(errors.length);
  });
});

describe('receipt and outcome', () => {
  it('says nothing without a guard, and states the limit and what it refuses with one', () => {
    expect(guardRows({ guardBps: null }, copy)).toEqual([]);
    expect(guardConsequences({ guardBps: null }, copy)).toEqual([]);
    expect(guardRows({ guardBps: 250 }, copy)[0]).toMatchObject({
      label: 'priceGuard.rowLimit',
      binding: true,
      value: { text: 'request.guardRow:{"limit":"2.5%"}' },
    });
    expect(guardConsequences({ guardBps: 250 }, copy)).toEqual([
      'request.guardWhat:{"limit":"2.5%"}',
      'priceGuard.setCalm',
      'priceGuard.setRecorded',
      'priceGuard.setCheckpoints',
      'priceGuard.setOnlyRefuses',
    ]);
  });

  const log = (offerId: bigint, bps: number): Log =>
    ({
      address: DIAMOND,
      topics: encodeEventTopics({ abi: PRICE_GUARD, eventName: 'OfferPriceGuardSet', args: { offerId, creator: ME } } as never),
      data: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint256' }, { type: 'uint256' }], [bps, 1n, 1n]),
    }) as unknown as Log;

  it('reads the guard the post recorded for the offer it made', () => {
    expect(guardPostLeg({ guardBps: null }, [], DIAMOND, 7n, copy)).toEqual([]);
    expect(guardPostLeg({ guardBps: 500 }, [log(7n, 500)], DIAMOND, 7n, copy)[0]).toMatchObject({ status: 'done' });
    expect(guardPostLeg({ guardBps: 500 }, [log(7n, 400)], DIAMOND, 7n, copy)[0]).toMatchObject({ status: 'not-done', reason: 'priceGuard.legMissing' });
    expect(guardPostLeg({ guardBps: 500 }, [log(7n, 500)], DIAMOND, null, copy)[0]).toMatchObject({ status: 'not-done' });
  });
});
