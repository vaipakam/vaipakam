import { describe, expect, it, vi } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { fallbackGateNotice, readFallbackGate } from './fallbackGate';

const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;

describe('fallbackGateNotice (#3538)', () => {
  const gate = (failedSales: bigint, fallbackOpensAt: bigint) => ({ failedSales, firstFailAt: 100n, fallbackOpensAt });
  it('says nothing when no failed sale is recorded', () => {
    expect(fallbackGateNotice(null, 500n)).toEqual({ kind: 'none' });
    expect(fallbackGateNotice(gate(0n, 0n), 500n)).toEqual({ kind: 'none' });
  });
  it('names the chain’s opening time while the span runs, then says it can open now', () => {
    expect(fallbackGateNotice(gate(1n, 700n), 500n)).toEqual({ kind: 'opensAt', opensAt: 700 });
    expect(fallbackGateNotice(gate(2n, 700n), 700n)).toEqual({ kind: 'openNow' });
  });
});

describe('readFallbackGate (#3538)', () => {
  it('reads the gate, treats a Diamond without it as none, and throws otherwise', async () => {
    const ok = { readContract: vi.fn(async () => [1n, 100n, 700n]) };
    await expect(readFallbackGate(ok as never, DIAMOND, 7n)).resolves.toEqual({
      failedSales: 1n,
      firstFailAt: 100n,
      fallbackOpensAt: 700n,
    });
    const missing = {
      readContract: vi.fn(async () => {
        // The Diamond's fallback reverts FunctionDoesNotExist() for a
        // selector no facet hosts, as viem reports it.
        const cause = new ContractFunctionRevertedError({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getFallbackGate',
          data: '0xa9ad62f8',
        });
        throw new ContractFunctionExecutionError(cause, {
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getFallbackGate',
          args: [7n],
          contractAddress: DIAMOND,
        });
      }),
    };
    await expect(readFallbackGate(missing as never, DIAMOND, 7n)).resolves.toBeNull();
    const down = { readContract: vi.fn(async () => { throw new Error('rpc down'); }) };
    await expect(readFallbackGate(down as never, DIAMOND, 7n)).rejects.toThrow('rpc down');
  });
});
