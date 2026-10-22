import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Abi,
} from 'viem';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { copy } from '../content/copy';
import {
  knownRefinanceTarget,
  lenderCollateralLine,
  readRefinanceRequestLive,
  refinanceRequestOf,
  sameRefinanceReview,
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

describe('sameRefinanceReview (Codex #2668 r2)', () => {
  const reviewed = { targetLoanId: 22n, carryOver: true, standing: takeable };
  it('holds when the fresh read says what was reviewed', () => {
    expect(sameRefinanceReview(reviewed, { ...reviewed })).toBe(true);
    expect(sameRefinanceReview(null, null)).toBe(true);
  });
  it('refuses when the request has since become untakeable', () => {
    expect(
      sameRefinanceReview(reviewed, {
        ...reviewed,
        standing: { kind: 'blocked', reason: 'Closed.' },
      }),
    ).toBe(false);
  });
  it('refuses on a different target, collateral decision or a vanished tag', () => {
    expect(sameRefinanceReview(reviewed, { ...reviewed, targetLoanId: 23n })).toBe(false);
    expect(sameRefinanceReview(reviewed, { ...reviewed, carryOver: false })).toBe(false);
    expect(sameRefinanceReview(reviewed, null)).toBe(false);
  });
});

describe('a cancelled (deleted) request (Codex #2668 r3)', () => {
  // A deleted offer reads back as the zeroed struct.
  const zeroed = {
    readContract: async () => ({
      creator: '0x0000000000000000000000000000000000000000',
      refinanceTargetLoanId: 0n,
      refinanceCarryOver: false,
    }),
  } as unknown as PublicClient;
  const diamond = '0x00000000000000000000000000000000000000d1';

  it('reads as blocked when the review knew it as a refinance', async () => {
    const info = await readRefinanceRequestLive(zeroed, diamond, 7n, 22n);
    expect(info).toEqual({
      targetLoanId: 22n,
      carryOver: false,
      standing: { kind: 'blocked', reason: copy.match.refinanceRequestGone },
    });
  });

  it('stays null for an offer nobody knew as a refinance', async () => {
    expect(await readRefinanceRequestLive(zeroed, diamond, 7n)).toBeNull();
    expect(await readRefinanceRequestLive(zeroed, diamond, 7n, 0n)).toBeNull();
  });

  it('takes the known target from the last answer, else the indexed tag', () => {
    const last = { targetLoanId: 22n, carryOver: true, standing: takeable };
    expect(knownRefinanceTarget(last, 9)).toBe(22n);
    expect(knownRefinanceTarget(undefined, 9)).toBe(9n);
    expect(knownRefinanceTarget(null, null)).toBe(0n);
    expect(knownRefinanceTarget(undefined, 0)).toBe(0n);
  });
});

describe('the recorded-request check (Codex #2668 r4)', () => {
  const diamond = '0x00000000000000000000000000000000000000d1';
  const offer = {
    creator: '0x00000000000000000000000000000000000000b0',
    refinanceTargetLoanId: 22n,
    refinanceCarryOver: true,
  };
  const missingAbi = [{ type: 'error', name: 'FunctionDoesNotExist', inputs: [] }] as const;
  /** A client whose views answer per function name. */
  function client(recorded: bigint | 'missing'): PublicClient {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getOfferDetails') return offer;
        if (functionName === 'checkRefinanceRequest') return undefined;
        if (functionName === 'getRefinanceRequest') {
          if (recorded === 'missing') {
            throw revertWith(missingAbi, 'FunctionDoesNotExist', []);
          }
          return [recorded, true] as const;
        }
        throw new Error(`unexpected ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  it('is takeable only when the offer is the loan’s recorded request', async () => {
    const info = await readRefinanceRequestLive(client(7n), diamond, 7n);
    expect(info?.standing).toEqual(takeable);
  });

  it('is blocked when another request (or none) is recorded', async () => {
    for (const recorded of [9n, 0n]) {
      const info = await readRefinanceRequestLive(client(recorded), diamond, 7n);
      expect(info?.standing.kind).toBe('blocked');
      if (info?.standing.kind !== 'blocked') return;
      expect(info.standing.reason).toMatch(/not the loan's current request/);
    }
  });

  it('is unchecked on a Diamond without the record view', async () => {
    const info = await readRefinanceRequestLive(client('missing'), diamond, 7n);
    expect(info?.standing).toEqual({ kind: 'unchecked' });
  });
});
