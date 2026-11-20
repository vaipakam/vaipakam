import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { INSTANT } from './preset';
import { instantSlotCall, offersInstant, type InstantCardFacts } from './instantCard';

type Hex = `0x${string}`;
const USDC: Hex = '0x00000000000000000000000000000000000000a1';
const WETH: Hex = '0x00000000000000000000000000000000000000b2';
const open = { acceptsProRata: true, requiresKeeperAuth: false };
const facts = (p: Partial<InstantCardFacts['record']> = {}, availability: InstantCardFacts['availability'] = 'available'): InstantCardFacts => ({
  record: { fills: false, renewal: false, takeover: false, setAt: 0n, ...p },
  availability,
});

describe('offersInstant', () => {
  it('offers the line on an active slot with no consent, on a pair the market takes', () => {
    expect(offersInstant(open, true, facts())).toBe(true);
  });
  it('offers nothing where a consent is set, the slot is not lending, or the market cannot take it', () => {
    expect(offersInstant(open, true, facts({ fills: true }))).toBe(false);
    expect(offersInstant(open, false, facts())).toBe(false);
    expect(offersInstant(open, true, facts({}, 'market-off'))).toBe(false);
    expect(offersInstant(open, true, facts({}, 'unknown'))).toBe(false);
    expect(offersInstant({ ...open, acceptsProRata: false }, true, facts())).toBe(false);
    expect(offersInstant({ ...open, requiresKeeperAuth: true }, true, facts())).toBe(false);
    expect(offersInstant(open, true, null)).toBe(false);
  });
});

describe('instantSlotCall', () => {
  it('sends the choices with renewal off and the consent flag', () => {
    const call = instantSlotCall(USDC, WETH, 2, { fills: true, takeover: false }, 99n);
    const data = encodeFunctionData({ abi: INSTANT, functionName: call.functionName, args: call.args });
    expect(decodeFunctionData({ abi: INSTANT, data }).args!.slice(2)).toEqual([2, true, false, false, true, 99n]);
  });
});
