import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { LenderIntentFacetABI } from '@vaipakam/contracts/abis';
import { rollEstimateRefusal, rollStepFor, type RollableIntentLoan } from '../src/matcher';

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
    for (const name of ['LenderIntentLoanNotRollable', 'LenderIntentPositionTransferred', 'LenderIntentNothingToRoll', 'LenderIntentEnded']) {
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

describe('roll pass step per registry row (#3629)', () => {
  const row = (open: boolean, held: bigint): RollableIntentLoan => ({
    loanId: 1n,
    owner: '0x0000000000000000000000000000000000000001',
    lendingAsset: '0x0000000000000000000000000000000000000002',
    collateralAsset: '0x0000000000000000000000000000000000000003',
    amount: 10n,
    open,
    held,
  });

  it('rolls a repaid loan whether or not the re-commit step is armed', () => {
    expect(rollStepFor(row(false, 0n), false)).toBe('roll');
    expect(rollStepFor(row(false, 5n), true)).toBe('roll');
  });

  it('re-commits an open loan\'s held payments only when armed', () => {
    expect(rollStepFor(row(true, 5n), true)).toBe('recommit');
    expect(rollStepFor(row(true, 5n), false)).toBe('skip');
  });

  it('skips an open loan with nothing held', () => {
    expect(rollStepFor(row(true, 0n), true)).toBe('skip');
  });
});
