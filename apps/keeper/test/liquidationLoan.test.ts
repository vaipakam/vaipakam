/**
 * #2733 — the liquidator reads the loan by field name, and every field it reads
 * is pinned here to the compiled `getLoanDetails` ABI. A rename, a removal or a
 * type change on the contract side fails this test instead of shifting what the
 * partial-liquidation sizer is fed.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeFunctionResult, type AbiParameter } from 'viem';
import { LoanFacetABI } from '@vaipakam/contracts/abis';
import { LIQUIDATION_LOAN_FIELDS, parseLiquidationLoan } from '../src/liquidationLoan';

type Component = AbiParameter & { components?: readonly Component[] };
const getLoanDetails = (LoanFacetABI as readonly { type: string; name?: string; outputs?: readonly Component[] }[]).find(
  (e) => e.type === 'function' && e.name === 'getLoanDetails',
)!;
const components = getLoanDetails.outputs![0].components!;

/** The JavaScript type viem decodes a Solidity scalar type to. */
const jsKind = (solType: string): string => {
  if (solType === 'address') return 'address';
  const m = /^u?int(\d+)$/.exec(solType);
  if (m) return Number(m[1]) <= 48 ? 'number' : 'bigint';
  return solType;
};

/** A sample value for every field of the struct, by its Solidity type. */
const sample = (solType: string, i: number): unknown => {
  if (solType === 'address') return `0x${(i + 1).toString(16).padStart(40, '0')}`;
  if (solType === 'bool') return false;
  const m = /^u?int(\d+)$/.exec(solType);
  if (m) return Number(m[1]) <= 48 ? i + 1 : BigInt(i + 1);
  throw new Error(`no sample for ${solType}`);
};

describe('#2733 liquidation loan fields', () => {
  it('names only fields getLoanDetails returns, with the types viem decodes them to', () => {
    for (const [name, kind] of Object.entries(LIQUIDATION_LOAN_FIELDS)) {
      const c = components.find((x) => x.name === name);
      expect(c, `getLoanDetails has no field ${name}`).toBeDefined();
      expect(jsKind(c!.type), name).toBe(kind);
    }
  });

  it('reads the stamped liquidation threshold the health factor uses, not another field', () => {
    const struct = Object.fromEntries(components.map((c, i) => [c.name!, sample(c.type, i)]));
    struct.liquidationLtvBpsAtInit = 8_000;
    const data = encodeFunctionResult({ abi: LoanFacetABI, functionName: 'getLoanDetails', result: struct } as never);
    const decoded = decodeFunctionResult({ abi: LoanFacetABI, functionName: 'getLoanDetails', data } as never);
    const loan = parseLiquidationLoan(decoded);
    expect(loan).not.toBeNull();
    expect(loan!.liquidationLtvBpsAtInit).toBe(8_000);
    expect(loan!.collateralAmount).toBe(struct.collateralAmount);
    expect(loan!.collateralAsset.toLowerCase()).toBe(String(struct.collateralAsset));
  });

  it('refuses a struct missing a field or carrying one of the wrong type', () => {
    const good = {
      collateralAsset: `0x${'1'.repeat(40)}`,
      collateralAmount: 1n,
      principalAsset: `0x${'2'.repeat(40)}`,
      status: 0,
      assetType: 0,
      startTime: 1n,
      durationDays: 30n,
      liquidationLtvBpsAtInit: 8_000,
    };
    expect(parseLiquidationLoan(good)).not.toBeNull();
    const { liquidationLtvBpsAtInit: _dropped, ...missing } = good;
    expect(parseLiquidationLoan(missing)).toBeNull();
    expect(parseLiquidationLoan({ ...good, liquidationLtvBpsAtInit: 8_000n })).toBeNull();
    expect(parseLiquidationLoan({ ...good, collateralAmount: 1 })).toBeNull();
    expect(parseLiquidationLoan({ ...good, collateralAsset: '0x12' })).toBeNull();
    expect(parseLiquidationLoan(null)).toBeNull();
  });
});
