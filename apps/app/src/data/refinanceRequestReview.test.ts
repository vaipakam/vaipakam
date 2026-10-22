import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Abi,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import {
  lenderCollateralLine,
  refinanceRequestOf,
  standingFromCheckError,
} from './refinanceRequestReview';

const takeable = { kind: 'takeable' } as const;

describe('refinanceRequestOf (#2421)', () => {
  it('is null for an untagged offer, whatever the carry-over slot holds', () => {
    expect(refinanceRequestOf({ refinanceTargetLoanId: 0n, refinanceCarryOver: false })).toBeNull();
    expect(refinanceRequestOf({ refinanceTargetLoanId: 0n, refinanceCarryOver: true })).toBeNull();
  });
  it('names the target loan and the recorded carry-over decision', () => {
    expect(refinanceRequestOf({ refinanceTargetLoanId: 22n, refinanceCarryOver: true })).toEqual({
      targetLoanId: 22n,
      carryOver: true,
      standing: takeable,
    });
  });
});

/** A viem revert carrying `data` under a call error, the shape `readContract`
 *  throws. */
function revertWith(abi: Abi, errorName: string, args: readonly unknown[]): BaseError {
  const data = encodeErrorResult({ abi, errorName, args });
  const inner = new ContractFunctionRevertedError({
    abi,
    data,
    functionName: 'checkRefinanceRequest',
  });
  return new BaseError('The contract function "checkRefinanceRequest" reverted.', {
    cause: inner,
  });
}

describe('standingFromCheckError (Codex #2668 r1)', () => {
  const abi = [
    {
      type: 'error',
      name: 'RefinanceRequestNotLive',
      inputs: [
        { name: 'loanId', type: 'uint256' },
        { name: 'offerId', type: 'uint256' },
      ],
    },
    { type: 'error', name: 'FunctionDoesNotExist', inputs: [] },
  ] as const satisfies Abi;

  it('reads the acceptance check refusing as blocked, with a readable reason', () => {
    const standing = standingFromCheckError(
      revertWith(abi, 'RefinanceRequestNotLive', [22n, 7n]),
    );
    expect(standing.kind).toBe('blocked');
    if (standing.kind !== 'blocked') return;
    expect(standing.reason).toMatch(/can no longer be accepted/);
  });

  it('reads a Diamond without the view as unchecked, not as a refusal', () => {
    expect(standingFromCheckError(revertWith(abi, 'FunctionDoesNotExist', []))).toEqual({
      kind: 'unchecked',
    });
  });

  it('rethrows a failure that is not a contract answer, so the review retries', () => {
    const transport = new Error('fetch failed');
    expect(() => standingFromCheckError(transport)).toThrow(transport);
    const http = new BaseError('HTTP request failed.');
    expect(() => standingFromCheckError(http)).toThrow(http);
  });
});

describe('lenderCollateralLine (#2421)', () => {
  it('keeps the plain line for a fresh borrow request', () => {
    expect(lenderCollateralLine(null, '100 tCOL')).toBe(
      copy.offerFlow.receipts.lenderCollateralLock('100 tCOL'),
    );
  });
  it('says carried-over collateral is already locked, never a new pledge', () => {
    const line = lenderCollateralLine(
      { targetLoanId: 22n, carryOver: true, standing: takeable },
      '100 tCOL',
    );
    expect(line).toBe(copy.offerFlow.receipts.lenderCollateralCarriedOver('100 tCOL', '22'));
    expect(line).toContain('#22');
    expect(line).not.toBe(copy.offerFlow.receipts.lenderCollateralLock('100 tCOL'));
  });
  it('says a fresh pledge is new, and that the old loan’s collateral goes back', () => {
    expect(lenderCollateralLine(
        { targetLoanId: 22n, carryOver: false, standing: takeable },
        '100 tCOL',
      )).toBe(
      copy.offerFlow.receipts.lenderCollateralFreshPledge('100 tCOL', '22'),
    );
  });
});
