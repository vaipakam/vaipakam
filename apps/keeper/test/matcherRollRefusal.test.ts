import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { LenderIntentFacetABI } from '@vaipakam/contracts/abis';
import { rollEstimateRefusal } from '../src/matcher';

/** An estimate that reverts with `errorName`, the way viem surfaces one. */
function revert(errorName: string): Error {
  const inner = new ContractFunctionRevertedError({
    abi: LenderIntentFacetABI as never,
    functionName: 'rollIntentLoan',
    data: '0x',
  });
  (inner as { data?: unknown }).data = { errorName, args: [] };
  return new BaseError(`reverted: ${errorName}`, { cause: inner });
}

describe('roll estimate refusals (#2914)', () => {
  it('leaves a VPFI loan to its owner\'s claim', () => {
    expect(rollEstimateRefusal(revert('LenderIntentVpfiRollUnsupported'))).toBe('leftToClaim');
  });

  it('leaves every loan the roll refuses to the normal claim', () => {
    for (const name of ['LenderIntentLoanNotRollable', 'LenderIntentPositionTransferred', 'LenderIntentNothingToRoll']) {
      expect(rollEstimateRefusal(revert(name))).toBe('leftToClaim');
    }
  });

  it('marks an undelegated owner as unauthorized', () => {
    expect(rollEstimateRefusal(revert('KeeperAccessRequired'))).toBe('unauthorized');
  });

  it('reports any other failure as a failed estimate', () => {
    expect(rollEstimateRefusal(revert('EnforcedPause'))).toBe('failed');
    expect(rollEstimateRefusal(new Error('rpc down'))).toBe('failed');
  });
});
