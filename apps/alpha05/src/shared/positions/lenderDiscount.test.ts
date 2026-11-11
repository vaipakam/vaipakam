import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, encodeErrorResult, parseAbi, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { holdStanding, readLenderDiscount, type LenderHoldView } from './lenderDiscount';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;

const NO_ROUTE = parseAbi(['error FunctionDoesNotExist()']);
const noRoute = (functionName: string) =>
  new ContractFunctionRevertedError({ abi: NO_ROUTE, data: encodeErrorResult({ abi: NO_ROUTE, errorName: 'FunctionDoesNotExist' }), functionName });
const outage = (functionName: string) =>
  new ContractFunctionExecutionError(new HttpRequestError({ url: 'https://rpc.example', status: 429 }), { abi: [], functionName });

function client(answers: Record<string, unknown | ((fn: string) => Error)>): PublicClient {
  return {
    getBlockNumber: async () => 7n,
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      expect(blockNumber).toBe(7n);
      const a = answers[functionName];
      if (typeof a === 'function') throw (a as (fn: string) => Error)(functionName);
      return a;
    },
  } as unknown as PublicClient;
}

const VIEW = { entryHolder: ME, entryTier: 0, entryBps: 0, enteredAt: 1_800_000_000n, nowTier: 1, nowBps: 1000, holdBps: 0 };
const ANSWERS = {
  lenderHoldDiscountView: VIEW,
  getVPFIDiscountConsent: true,
  getVPFIDiscountConfig: [0n, ZERO],
  getFeeEntitlement: { lenderMode: 2, borrowerMode: 0 },
};

const view = (v: Partial<LenderHoldView>): LenderHoldView => ({
  entryHolder: ME,
  entryTier: 0,
  entryBps: 0,
  enteredAt: 1,
  nowTier: 0,
  nowBps: 0,
  holdBps: 0,
  ...v,
});

describe('readLenderDiscount', () => {
  it('reads the protocol’s view, the setting, the delivery mode and the tariff at one block', async () => {
    await expect(readLenderDiscount(client(ANSWERS), DIAMOND, 3n, ME)).resolves.toEqual({
      hold: { entryHolder: ME, entryTier: 0, entryBps: 0, enteredAt: 1_800_000_000, nowTier: 1, nowBps: 1000, holdBps: 0 },
      consent: true,
      mode: 'direct',
      fullTariff: true,
    });
  });

  it('reports a network whose contracts predate the view as absent, never as a zero discount', async () => {
    const r = await readLenderDiscount(client({ ...ANSWERS, lenderHoldDiscountView: noRoute }), DIAMOND, 3n, ME);
    expect(r.hold).toBe('absent');
  });

  it('throws when the view cannot be read, so the page says unknown', async () => {
    await expect(readLenderDiscount(client({ ...ANSWERS, lenderHoldDiscountView: outage }), DIAMOND, 3n, ME)).rejects.toThrow();
  });

  it('states each side figure as unread when it alone fails', async () => {
    const r = await readLenderDiscount(
      client({ ...ANSWERS, getVPFIDiscountConsent: outage, getVPFIDiscountConfig: outage, getFeeEntitlement: outage }),
      DIAMOND,
      3n,
      ME,
    );
    expect(r).toMatchObject({ consent: null, mode: null, fullTariff: null });
    expect(r.hold).not.toBe('absent');
  });
});

describe('holdStanding', () => {
  it('is capped when the entry figure is below the discount now', () => {
    expect(holdStanding(view({ entryTier: 1, entryBps: 1000, nowTier: 2, nowBps: 1500, holdBps: 1000 }), ME)).toMatchObject({ kind: 'capped', bps: 1000 });
  });

  it('follows the discount now when it is at or below the entry figure', () => {
    expect(holdStanding(view({ entryTier: 2, entryBps: 1500, nowTier: 1, nowBps: 1000, holdBps: 1000 }), ME)).toMatchObject({ kind: 'follows', bps: 1000 });
    expect(holdStanding(view({ entryTier: 1, entryBps: 1000, nowTier: 1, nowBps: 1000, holdBps: 1000 }), ME)).toMatchObject({ kind: 'follows', bps: 1000 });
  });

  it('is unrecorded when the entry names another holder or none', () => {
    expect(holdStanding(view({ entryHolder: OTHER, nowTier: 1, nowBps: 1000 }), ME)).toEqual({ kind: 'unrecorded', nowTier: 1, nowBps: 1000 });
    expect(holdStanding(view({ entryHolder: ZERO }), ME).kind).toBe('unrecorded');
  });

  it('compares the holder without regard to letter case', () => {
    expect(holdStanding(view({ entryHolder: ME.toUpperCase().replace('0X', '0x') as Hex }), ME).kind).toBe('follows');
  });
});
