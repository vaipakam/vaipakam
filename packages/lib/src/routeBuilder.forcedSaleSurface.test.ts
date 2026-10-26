import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi, toFunctionSelector, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  FORCED_SALE_SURFACE_SELECTORS,
  encodeTriggerDefault,
  encodeTriggerLiquidation,
  readForcedSaleSurface,
} from './routeBuilder';

const DIAMOND: Address = '0x00000000000000000000000000000000000000d1';
const HOST: Address = '0x00000000000000000000000000000000000000fa';
const WHOLE_ABI = parseAbi([
  'function triggerDefault(uint256 loanId, (uint256 adapterIdx, bytes data)[] adapterCalls)',
  'function triggerLiquidation(uint256 loanId, (uint256 adapterIdx, bytes data)[] adapterCalls)',
]);
const CALLS = [{ adapterIdx: 2n, data: '0xabcd' as Hex }];

/** A client whose loupe routes exactly `routed`. */
const loupe = (routed: readonly Hex[]) => {
  const asked: { selector: Hex; blockNumber?: bigint }[] = [];
  const client = {
    readContract: async (args: { functionName: string; args: readonly Hex[]; blockNumber?: bigint }) => {
      expect(args.functionName).toBe('facetAddress');
      asked.push({ selector: args.args[0], blockNumber: args.blockNumber });
      return routed.includes(args.args[0]) ? HOST : zeroAddress;
    },
  };
  return { client, asked };
};

const { sized, whole } = FORCED_SALE_SURFACE_SELECTORS;

describe('FORCED_SALE_SURFACE_SELECTORS', () => {
  it('names the sized surface the compiled Diamond carries', () => {
    const compiled = (DIAMOND_ABI_VIEM as Abi)
      .filter((x) => x.type === 'function')
      .map((f) => toFunctionSelector(f as never));
    expect(compiled).toEqual(expect.arrayContaining([sized.plan, sized.triggerDefault, sized.triggerLiquidation]));
    // The whole-collateral forms are gone from the source; they live only on
    // Diamonds deployed before #2796.
    expect(compiled).not.toContain(whole.triggerDefault);
    expect(compiled).not.toContain(whole.triggerLiquidation);
  });

  it('names the pre-#2796 whole-collateral forms', () => {
    expect(whole.triggerDefault).toBe(toFunctionSelector('triggerDefault(uint256,(uint256,bytes)[])'));
    expect(whole.triggerLiquidation).toBe(toFunctionSelector('triggerLiquidation(uint256,(uint256,bytes)[])'));
  });
});

describe('readForcedSaleSurface', () => {
  it('reads sized when the plan is routed, in one request at the given block', async () => {
    const { client, asked } = loupe([sized.plan]);
    await expect(readForcedSaleSurface({ client, diamond: DIAMOND, blockNumber: 7n })).resolves.toBe('sized');
    expect(asked).toEqual([{ selector: sized.plan, blockNumber: 7n }]);
  });

  it('reads whole when the plan is not routed', async () => {
    const { client, asked } = loupe([whole.triggerDefault, whole.triggerLiquidation]);
    await expect(readForcedSaleSurface({ client, diamond: DIAMOND })).resolves.toBe('whole');
    expect(asked).toHaveLength(1);
  });

  it('throws what a failed read throws', async () => {
    const client = { readContract: async () => Promise.reject(new Error('rpc down')) };
    await expect(readForcedSaleSurface({ client, diamond: DIAMOND })).rejects.toThrow('rpc down');
  });
});

describe('encodeTriggerDefault / encodeTriggerLiquidation', () => {
  it('sends the sale size on the sized surface', () => {
    const def = encodeTriggerDefault('sized', 5n, 1_010n, CALLS);
    const liq = encodeTriggerLiquidation('sized', 5n, 1_010n, CALLS);
    expect(def.slice(0, 10)).toBe(sized.triggerDefault);
    expect(liq.slice(0, 10)).toBe(sized.triggerLiquidation);
    expect(decodeFunctionData({ abi: DIAMOND_ABI_VIEM as Abi, data: def }).args).toEqual([5n, 1_010n, CALLS]);
    expect(decodeFunctionData({ abi: DIAMOND_ABI_VIEM as Abi, data: liq }).args).toEqual([5n, 1_010n, CALLS]);
  });

  it('sends no size on the whole surface', () => {
    const def = encodeTriggerDefault('whole', 5n, 1_010n, CALLS);
    const liq = encodeTriggerLiquidation('whole', 5n, 1_010n, CALLS);
    expect(decodeFunctionData({ abi: WHOLE_ABI, data: def })).toEqual({ functionName: 'triggerDefault', args: [5n, CALLS] });
    expect(decodeFunctionData({ abi: WHOLE_ABI, data: liq })).toEqual({ functionName: 'triggerLiquidation', args: [5n, CALLS] });
  });
});
