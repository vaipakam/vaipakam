/**
 * One rule for what a failed `calculateHealthFactor` read means (src/hfRevert.ts).
 * The error shapes are the ones the machine runner logged on its first
 * disarmed tick (2026-10-15): loan 11 reverted with an undecoded `NoPriceFeed`
 * selector, loan 23 with a decoded `IlliquidLoanNoRiskMath`.
 */
import { describe, expect, it } from 'vitest';
import { classifyHfReadFailure } from '../src/hfRevert';

describe('classifyHfReadFailure', () => {
  it('an illiquid loan is expected, by decoded name or by message', () => {
    expect(classifyHfReadFailure({ data: { errorName: 'IlliquidLoanNoRiskMath' } })).toBe('illiquid');
    expect(
      classifyHfReadFailure(
        new Error('ContractFunctionExecutionError: The contract function "calculateHealthFactor" reverted.\nError: IlliquidLoanNoRiskMath()'),
      ),
    ).toBe('illiquid');
  });

  it('a missing price feed is named even when the facet ABI could not decode it', () => {
    expect(
      classifyHfReadFailure(
        new Error(
          'ContractFunctionExecutionError: The contract function "calculateHealthFactor" reverted with the following signature:\n0xfb94c4ed\nUnable to decode signature "0xfb94c4ed"',
        ),
      ),
    ).toBe('noPriceFeed');
    expect(classifyHfReadFailure({ data: { errorName: 'NoPriceFeed' } })).toBe('noPriceFeed');
  });

  it('anything else is a gap, never silently skipped', () => {
    expect(classifyHfReadFailure(new Error('HTTP request failed: 503'))).toBe('other');
    expect(classifyHfReadFailure(undefined)).toBe('other');
    expect(classifyHfReadFailure(new Error('reverted with the following signature: 0x12345678'))).toBe('other');
  });
});
