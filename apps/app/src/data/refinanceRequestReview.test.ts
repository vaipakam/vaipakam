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
  lenderCollateralLine,
  readRefinanceRequestLive,
  sameRefinanceReview,
  standingFromCheckError,
  type RefinanceReviewRead,
} from './refinanceRequestReview';

const takeable = { kind: 'takeable' } as const;

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

describe('sameRefinanceReview (Codex #2668 r2/r5)', () => {
  const reviewed: RefinanceReviewRead = {
    kind: 'refinance',
    info: { targetLoanId: 22n, carryOver: true, standing: takeable },
  };
  const withInfo = (patch: object): RefinanceReviewRead => ({
    kind: 'refinance',
    info: { ...(reviewed as { info: object }).info, ...patch } as never,
  });
  it('holds when the fresh read says what was reviewed', () => {
    expect(sameRefinanceReview(reviewed, withInfo({}))).toBe(true);
    expect(sameRefinanceReview({ kind: 'ordinary' }, { kind: 'ordinary' })).toBe(true);
  });
  it('refuses when the request has since become untakeable', () => {
    expect(
      sameRefinanceReview(reviewed, withInfo({ standing: { kind: 'blocked', reason: 'Closed.' } })),
    ).toBe(false);
  });
  it('refuses on a different target or collateral decision, or a deleted offer', () => {
    expect(sameRefinanceReview(reviewed, withInfo({ targetLoanId: 23n }))).toBe(false);
    expect(sameRefinanceReview(reviewed, withInfo({ carryOver: false }))).toBe(false);
    expect(sameRefinanceReview(reviewed, { kind: 'gone' })).toBe(false);
    expect(sameRefinanceReview({ kind: 'ordinary' }, { kind: 'gone' })).toBe(false);
  });
});

const diamond = '0x00000000000000000000000000000000000000d1';
const missingAbi = [{ type: 'error', name: 'FunctionDoesNotExist', inputs: [] }] as const;

/** A client whose views answer per function name, recording the block each
 *  read was pinned to. */
function client(
  offer: { creator: string; refinanceTargetLoanId: bigint; refinanceCarryOver: boolean },
  recorded: readonly [bigint, boolean] | 'missing' = [7n, true],
): PublicClient & { blocks: (bigint | undefined)[] } {
  const blocks: (bigint | undefined)[] = [];
  return {
    blocks,
    getBlockNumber: async () => 100n,
    readContract: async ({
      functionName,
      blockNumber,
    }: {
      functionName: string;
      blockNumber?: bigint;
    }) => {
      blocks.push(blockNumber);
      if (functionName === 'getOfferDetails') return offer;
      if (functionName === 'checkRefinanceRequest') return undefined;
      if (functionName === 'getRefinanceRequest') {
        if (recorded === 'missing') throw revertWith(missingAbi, 'FunctionDoesNotExist', []);
        return recorded;
      }
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient & { blocks: (bigint | undefined)[] };
}
const creator = '0x00000000000000000000000000000000000000b0';
const tagged = { creator, refinanceTargetLoanId: 22n, refinanceCarryOver: true };

describe('readRefinanceRequestLive (#2421, Codex #2668 r3-r5)', () => {
  it('tells a deleted offer, an ordinary offer and a refinance request apart', async () => {
    const zero = '0x0000000000000000000000000000000000000000';
    expect(
      await readRefinanceRequestLive(
        client({ creator: zero, refinanceTargetLoanId: 0n, refinanceCarryOver: false }),
        diamond,
        7n,
      ),
    ).toEqual({ kind: 'gone' });
    expect(
      await readRefinanceRequestLive(
        client({ creator, refinanceTargetLoanId: 0n, refinanceCarryOver: true }),
        diamond,
        7n,
      ),
    ).toEqual({ kind: 'ordinary' });
    expect(await readRefinanceRequestLive(client(tagged), diamond, 7n)).toEqual({
      kind: 'refinance',
      info: { targetLoanId: 22n, carryOver: true, standing: takeable },
    });
  });

  it('pins every view to one block', async () => {
    const c = client(tagged);
    await readRefinanceRequestLive(c, diamond, 7n);
    expect(c.blocks).toEqual([100n, 100n, 100n]);
  });

  it('is blocked when another request (or none) is recorded', async () => {
    for (const recorded of [
      [9n, true],
      [0n, false],
    ] as const) {
      const read = await readRefinanceRequestLive(client(tagged, recorded), diamond, 7n);
      expect(read.kind === 'refinance' && read.info.standing.kind).toBe('blocked');
      if (read.kind !== 'refinance' || read.info.standing.kind !== 'blocked') return;
      expect(read.info.standing.reason).toMatch(/not the loan's current request/);
    }
  });

  it('honours the record’s own live verdict', async () => {
    const read = await readRefinanceRequestLive(client(tagged, [7n, false]), diamond, 7n);
    expect(read.kind === 'refinance' && read.info.standing.kind).toBe('blocked');
    if (read.kind !== 'refinance' || read.info.standing.kind !== 'blocked') return;
    expect(read.info.standing.reason).toMatch(/can no longer be accepted/);
  });

  it('is unchecked on a Diamond without the record view', async () => {
    const read = await readRefinanceRequestLive(client(tagged, 'missing'), diamond, 7n);
    expect(read).toEqual({
      kind: 'refinance',
      info: { targetLoanId: 22n, carryOver: true, standing: { kind: 'unchecked' } },
    });
  });
});
