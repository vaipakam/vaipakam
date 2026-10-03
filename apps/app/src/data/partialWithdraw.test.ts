/**
 * UX3-009 — the take-back-extra-collateral rules. What the page may say
 * about the live ceiling, and when a typed amount may be sent, are pure
 * functions pinned here; the reads behind the ceiling are driven with a
 * fake client so each failure shape lands where it should.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  classifyMaxWithdrawable,
  swapToRepayOrderState,
  withdrawPreflightBlock,
  readMaxWithdrawable,
  withdrawAmountProblem,
} from './partialWithdraw';

const DIAMOND = '0x00000000000000000000000000000000000000dd' as const;
const WETH = '0x00000000000000000000000000000000000000e1';
const VPFI = '0x00000000000000000000000000000000000000f1';

const revert = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], functionName: 'x' }),
    { abi: [], functionName: 'x' },
  );

type Reads = Record<string, unknown | (() => unknown)>;
function client(reads: Reads): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads)) throw new Error(`unexpected read ${functionName}`);
      const r = reads[functionName];
      return typeof r === 'function' ? (r as () => unknown)() : r;
    },
  } as unknown as PublicClient;
}

describe('classifyMaxWithdrawable', () => {
  it('never reports a failed read as zero', () => {
    expect(classifyMaxWithdrawable({ data: undefined, isError: true })).toEqual({
      kind: 'unconfirmed',
    });
    // Even when stale data from an earlier poll is still in hand.
    expect(
      classifyMaxWithdrawable({
        data: { max: 0n, illiquid: false, isVpfi: false },
        isError: true,
      }),
    ).toEqual({ kind: 'unconfirmed' });
  });

  it('is loading until the first answer', () => {
    expect(classifyMaxWithdrawable({ data: undefined, isError: false })).toEqual({
      kind: 'loading',
    });
  });

  it('states a positive ceiling as an amount', () => {
    expect(
      classifyMaxWithdrawable({
        data: { max: 5n, illiquid: false, isVpfi: false },
        isError: false,
      }),
    ).toEqual({ kind: 'some', max: 5n });
  });

  it('names the reason for a zero ceiling only when it was determined', () => {
    const zero = (illiquid: boolean | undefined) =>
      classifyMaxWithdrawable({ data: { max: 0n, illiquid, isVpfi: false }, isError: false });
    expect(zero(true)).toEqual({ kind: 'none-unpriced' });
    expect(zero(false)).toEqual({ kind: 'none-needed' });
    expect(zero(undefined)).toEqual({ kind: 'none-unknown' });
  });
});

describe('withdrawAmountProblem', () => {
  const some = { kind: 'some', max: 100n } as const;
  it('accepts an amount up to and including the ceiling', () => {
    expect(withdrawAmountProblem({ inputWei: 1n, state: some })).toBeNull();
    expect(withdrawAmountProblem({ inputWei: 100n, state: some })).toBeNull();
  });
  it('refuses an amount over the ceiling', () => {
    expect(withdrawAmountProblem({ inputWei: 101n, state: some })).toBe('over-max');
  });
  it('refuses an empty or zero amount', () => {
    expect(withdrawAmountProblem({ inputWei: null, state: some })).toBe('invalid');
    expect(withdrawAmountProblem({ inputWei: 0n, state: some })).toBe('invalid');
  });
  it('refuses any amount while there is no confirmed positive ceiling', () => {
    for (const state of [
      { kind: 'loading' },
      { kind: 'unconfirmed' },
      { kind: 'none-needed' },
      { kind: 'none-unpriced' },
      { kind: 'none-unknown' },
    ] as const) {
      expect(withdrawAmountProblem({ inputWei: 1n, state })).toBe('no-ceiling');
    }
  });
});

describe('readMaxWithdrawable', () => {
  const base = { diamondAddress: DIAMOND, loanId: 9n, collateralAsset: WETH };

  it('returns the ceiling with both explanatory facts', async () => {
    const r = await readMaxWithdrawable({
      ...base,
      publicClient: client({
        calculateMaxWithdrawable: 42n,
        checkLiquidity: 0,
        getVPFIToken: VPFI,
      }),
    });
    expect(r).toEqual({ max: 42n, illiquid: false, isVpfi: false });
  });

  it('recognises VPFI collateral', async () => {
    const r = await readMaxWithdrawable({
      ...base,
      collateralAsset: VPFI.toUpperCase().replace('0X', '0x'),
      publicClient: client({
        calculateMaxWithdrawable: 1n,
        checkLiquidity: 0,
        getVPFIToken: VPFI,
      }),
    });
    expect(r.isVpfi).toBe(true);
  });

  it('marks unpriceable collateral', async () => {
    const r = await readMaxWithdrawable({
      ...base,
      publicClient: client({
        calculateMaxWithdrawable: 0n,
        checkLiquidity: 1,
        getVPFIToken: VPFI,
      }),
    });
    expect(r.illiquid).toBe(true);
  });

  it('degrades the explanatory reads to unknown rather than guessing', async () => {
    const r = await readMaxWithdrawable({
      ...base,
      publicClient: client({
        calculateMaxWithdrawable: 0n,
        checkLiquidity: () => {
          throw new Error('rpc down');
        },
        getVPFIToken: () => {
          throw new Error('rpc down');
        },
      }),
    });
    expect(r).toEqual({ max: 0n, illiquid: undefined, isVpfi: undefined });
  });

  it('fails the whole answer when the ceiling itself cannot be read', async () => {
    await expect(
      readMaxWithdrawable({
        ...base,
        publicClient: client({
          calculateMaxWithdrawable: () => {
            throw new Error('rpc down');
          },
          checkLiquidity: 0,
          getVPFIToken: VPFI,
        }),
      }),
    ).rejects.toThrow('rpc down');
  });
});

/** The contract's own "no order stored" revert, decoded the way viem
 *  surfaces it from a real read. */
const noCommitRevert = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getIntentCommit',
      data: encodeErrorResult({
        abi: DIAMOND_ABI_VIEM,
        errorName: 'IntentNoCommit',
        args: [1n],
      }),
    }),
    { abi: DIAMOND_ABI_VIEM, functionName: 'getIntentCommit', args: [1n] },
  );

describe('swapToRepayOrderState', () => {
  const read = (getIntentCommit: unknown) =>
    swapToRepayOrderState({
      publicClient: client({ getIntentCommit }),
      diamondAddress: DIAMOND,
      loanId: 1n,
    });
  it('is live when the loan has a stored order', async () => {
    expect(await read({ maker: DIAMOND })).toBe('live');
  });
  it('is none only on the contract’s IntentNoCommit revert', async () => {
    expect(
      await read(() => {
        throw noCommitRevert();
      }),
    ).toBe('none');
  });
  it('is unknown on any other revert — never read as "no order" (#2389 r1)', async () => {
    expect(
      await read(() => {
        throw revert();
      }),
    ).toBe('unknown');
  });
  it('is unknown on a transport failure (#2389 r1)', async () => {
    expect(
      await read(() => {
        throw new Error('rpc down');
      }),
    ).toBe('unknown');
  });
});

describe('withdrawPreflightBlock (#2389 r2)', () => {
  const ok = { saleState: 'none' as const, swapOrder: 'none' as const, liveMax: 100n, wei: 50n };
  it('sends when every check answered clear and the amount fits', () => {
    expect(withdrawPreflightBlock(ok)).toBeNull();
  });
  it('blocks on a linked sale listing in any of its states', () => {
    for (const saleState of ['live', 'clearable', 'accepted'] as const) {
      expect(withdrawPreflightBlock({ ...ok, saleState }), saleState).toBe('sale-listed');
    }
  });
  it('blocks when the sale-listing check could not answer', () => {
    expect(withdrawPreflightBlock({ ...ok, saleState: 'unknown' })).toBe('sale-unchecked');
  });
  it('blocks on a stored swap order, and when that check could not answer', () => {
    expect(withdrawPreflightBlock({ ...ok, swapOrder: 'live' })).toBe('swap-order');
    expect(withdrawPreflightBlock({ ...ok, swapOrder: 'unknown' })).toBe('swap-unchecked');
  });
  it('blocks an amount over the live limit, naming whether any is left', () => {
    expect(withdrawPreflightBlock({ ...ok, wei: 101n })).toBe('over-max');
    expect(withdrawPreflightBlock({ ...ok, liveMax: 0n, wei: 1n })).toBe('none-left');
    expect(withdrawPreflightBlock({ ...ok, wei: 100n })).toBeNull();
  });
});
