import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Log } from 'viem';
import { CALM, calmCheckCall, calmLogs, calmPaused, calmStatusOf } from './calmCheck';
import { calmConsequences, calmRowValue } from './autoLendReview';

type Hex = `0x${string}`;
const USDC: Hex = '0x00000000000000000000000000000000000000a1';
const WETH: Hex = '0x00000000000000000000000000000000000000b2';
const ME: Hex = '0x00000000000000000000000000000000000000c3';
const DIAMOND: Hex = '0x00000000000000000000000000000000000000e5';

const copy = { text: (k: string) => k, format: (k: string, v: Record<string, string>) => `${k}#${v.state ?? ''}` } as never;

describe('calmStatusOf', () => {
  it('reads the slot statuses and nothing an offer alone can answer', () => {
    expect([0, 2, 4, 5, 6].map(calmStatusOf)).toEqual(['off', 'clear', 'no-checkpoint', 'moving', 'unpriced']);
    expect(calmStatusOf(1)).toBeNull();
    expect(calmStatusOf(3)).toBeNull();
    expect(calmStatusOf(9)).toBeNull();
  });
  it('counts as paused only a status that holds fills back', () => {
    expect((['off', 'clear', 'no-checkpoint', 'moving', 'unpriced'] as const).map(calmPaused)).toEqual([false, false, true, true, true]);
  });
});

describe('calmCheckCall', () => {
  it('sends the pair, the slot and the setting', () => {
    const call = calmCheckCall(USDC, WETH, 3, false);
    const data = encodeFunctionData({ abi: CALM, functionName: call.functionName, args: call.args });
    const args = decodeFunctionData({ abi: CALM, data }).args as readonly unknown[];
    expect(args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).toEqual([USDC, WETH, 3, false]);
  });
});

describe('calmLogs', () => {
  const log = (owner: Hex, slot: number, on: boolean): Log => {
    const topics = (encodeEventTopics as (p: unknown) => Hex[])({ abi: CALM, eventName: 'IntentCalmCheckSet', args: { owner, lendingAsset: USDC, collateralAsset: WETH } });
    return { address: DIAMOND, topics, data: encodeAbiParameters([{ type: 'uint8' }, { type: 'bool' }], [slot, on]) } as unknown as Log;
  };
  it('reads the setting this transaction recorded for this slot only', () => {
    expect(calmLogs([log(ME, 1, false)], DIAMOND, ME, USDC, WETH, 1)).toBe(false);
    expect(calmLogs([log(ME, 1, true)], DIAMOND, ME, USDC, WETH, 1)).toBe(true);
    expect(calmLogs([log(ME, 2, false)], DIAMOND, ME, USDC, WETH, 1)).toBeNull();
    expect(calmLogs([log(USDC, 1, false)], DIAMOND, ME, USDC, WETH, 1)).toBeNull();
  });
});

describe('calmConsequences', () => {
  it('states the pause as on, and why fills would wait now', () => {
    expect(calmConsequences('clear', copy)).toEqual(['autoLend.calmSetupOn']);
    expect(calmConsequences('no-checkpoint', copy)).toEqual(['autoLend.calmSetupOn', 'autoLend.calmSetupNoCheckpoint']);
    expect(calmConsequences('moving', copy)).toEqual(['autoLend.calmSetupOn', 'autoLend.calmSetupMoving']);
    expect(calmConsequences('unpriced', copy)).toEqual(['autoLend.calmSetupOn', 'autoLend.calmSetupUnpriced']);
  });
  it('keeps a switched-off pause as it is, and says when it could not be read', () => {
    expect(calmConsequences('off', copy)).toEqual(['autoLend.calmSetupKept#autoLend.calmRowOff', 'autoLend.calmLoseOff']);
    expect(calmConsequences(null, copy)).toEqual(['autoLend.calmSetupUnread']);
  });
});

describe('the receipt pause row (Codex round 8 on #3767)', () => {
  const c = { text: (k: string) => k, format: (k: string) => k } as never;
  it('is unknown on a change whose setting could not be read, never "On"', () => {
    expect(calmRowValue(null, true, c)).toEqual({ kind: 'unknown', why: 'autoLend.calmRowUnread' });
  });
  it('is On for a new Auto-lend, which starts with it on', () => {
    expect(calmRowValue(null, false, c)).toEqual({ kind: 'text', text: 'autoLend.calmRowOn' });
  });
  it('says Off where the owner switched it off', () => {
    expect(calmRowValue('off', true, c)).toEqual({ kind: 'text', text: 'autoLend.calmRowOff' });
  });
});
