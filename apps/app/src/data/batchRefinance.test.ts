/**
 * #126 slice 3 — what a "Refinance all" batch reports per loan, and how it
 * packs the calls. Posted only when the transaction's own logs say so; a
 * pending send never reads as "no request"; the approval is set back only
 * when no request was posted; and a loan's guardrail write is never sent
 * apart from its request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type AbiItem,
  type AbiParameter,
  type Log,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { LoanStatus } from '../lib/types';

const reads = vi.hoisted(() => ({
  status: {} as Record<number, number | 'unreadable'>,
  simulate: null as unknown,
  blocks: [] as (bigint | undefined)[],
}));

vi.mock('../contracts/loanLive', () => ({
  LOAN_STATUS_ACTIVE: 0,
  readLoanLive: vi.fn(async (_c: unknown, _d: unknown, loanId: number, block?: bigint) => {
    reads.blocks.push(block);
    const status = reads.status[loanId];
    if (status === 'unreadable') throw new Error('rpc down');
    return { status };
  }),
}));

import {
  LOANS_PER_REFINANCE_SEND,
  chunkRefinanceLoans,
  noRequestPosted,
  readBackRequests,
  refinanceSendCalls,
  refinanceTotals,
  requestsInLogs,
} from './batchRefinance';
import type { RefinanceCtx, RefinanceRequestReady } from './refinancePlan';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const OTHER = '0x000000000000000000000000000000000000beef' as const;
const HOLDER = '0x00000000000000000000000000000000000000b0' as const;
const TOKEN = '0x00000000000000000000000000000000000000a1' as const;
const ctx: RefinanceCtx = {
  publicClient: {
    simulateContract: async () => {
      if (reads.simulate) throw reads.simulate;
      return { result: undefined };
    },
  } as unknown as PublicClient,
  diamond: DIAMOND,
  holder: HOLDER,
};

const plan = (loanId: number, opts: { caps?: boolean; approval?: bigint; topUp?: bigint } = {}) =>
  ({
    kind: 'ready',
    loanId,
    liveLoan: { principalAsset: TOKEN },
    approval: opts.approval ?? 100n,
    topUp: opts.topUp ?? 10n,
    caps: opts.caps ? { rateBps: 900, maxNewExpiry: 5n } : null,
    payload: { loanId },
  }) as unknown as RefinanceRequestReady;

const CREATED_EVENT = (DIAMOND_ABI_VIEM as readonly AbiItem[]).find(
  (x): x is AbiEvent => x.type === 'event' && x.name === 'OfferCreatedDetails',
)!;
const FIELDS_TYPE = CREATED_EVENT.inputs.find((i) => i.name === 'fields')! as AbiParameter;

function createdLog(
  address: `0x${string}`,
  offerId: bigint,
  creator: `0x${string}`,
  refinanceTargetLoanId: bigint,
): Log {
  const components = (FIELDS_TYPE as unknown as { components: readonly AbiParameter[] }).components;
  const fields = Object.fromEntries(
    components.map((c) => [
      c.name,
      c.name === 'refinanceTargetLoanId'
        ? refinanceTargetLoanId
        : c.type === 'address'
          ? OTHER
          : c.type === 'bool'
            ? false
            : 0n,
    ]),
  );
  // uint8 fields decode as numbers; encode accepts bigint 0 for them too.
  return {
    address,
    topics: encodeEventTopics({
      abi: DIAMOND_ABI_VIEM,
      eventName: 'OfferCreatedDetails',
      args: { offerId, creator, lendingAsset: TOKEN },
    } as never),
    data: encodeAbiParameters([FIELDS_TYPE], [fields as never] as never),
    blockNumber: 9n,
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: `0x${'cd'.repeat(32)}`,
    blockHash: `0x${'ef'.repeat(32)}`,
    removed: false,
  } as unknown as Log;
}

beforeEach(() => {
  reads.status = {};
  reads.simulate = null;
  reads.blocks = [];
});

describe('requestsInLogs', () => {
  it('maps each refinanced loan to its request, from this wallet’s Diamond logs only', () => {
    const found = requestsInLogs(
      [
        createdLog(DIAMOND, 40n, HOLDER, 4n),
        createdLog(OTHER, 50n, HOLDER, 5n),
        createdLog(DIAMOND, 60n, OTHER, 6n),
        createdLog(DIAMOND, 70n, HOLDER, 0n),
        createdLog(DIAMOND, 80n, HOLDER, 8n),
      ],
      DIAMOND,
      HOLDER,
    );
    expect([...found.entries()]).toEqual([
      [4, '40'],
      [8, '80'],
    ]);
  });
});

describe('readBackRequests', () => {
  it('reports posted from the logs, and reads the rest at the transaction’s block', async () => {
    reads.status = { 5: LoanStatus.Repaid, 6: LoanStatus.Active };
    reads.simulate = new Error('RefinanceRequestExists');
    const out = await readBackRequests(ctx, [plan(4), plan(5), plan(6)], {
      block: 9n,
      logs: [createdLog(DIAMOND, 40n, HOLDER, 4n)],
    });
    expect(out[0]).toEqual({ loanId: 4, kind: 'posted', offerId: '40' });
    expect(out[1]).toEqual({ loanId: 5, kind: 'changed' });
    expect(out[2]).toMatchObject({ loanId: 6, kind: 'open' });
    expect(reads.blocks).toEqual([9n, 9n]);
  });

  it('says a skipped loan can take its request now when the request would pass', async () => {
    reads.status = { 6: LoanStatus.Active };
    const out = await readBackRequests(ctx, [plan(6)], { block: 9n, logs: [] });
    expect(out).toEqual([{ loanId: 6, kind: 'open', reason: copy.batchRefinance.skippedRetry }]);
  });

  it('is pending for every loan behind a pending send, without reading its status', async () => {
    reads.status = { 6: LoanStatus.Active, 7: LoanStatus.Defaulted };
    const out = await readBackRequests(ctx, [plan(6), plan(7)], { pending: true });
    expect(out).toEqual([
      { loanId: 6, kind: 'pending' },
      { loanId: 7, kind: 'pending' },
    ]);
    expect(reads.blocks).toEqual([]);
  });

  it('carries the failure of a send that did not run, and is unknown when unreadable', async () => {
    reads.status = { 6: LoanStatus.Active, 7: 'unreadable', 8: LoanStatus.Repaid };
    const out = await readBackRequests(ctx, [plan(6), plan(7), plan(8)], {
      failure: 'rejected',
    });
    expect(out).toEqual([
      { loanId: 6, kind: 'open', reason: 'rejected' },
      { loanId: 7, kind: 'unknown' },
      { loanId: 8, kind: 'changed' },
    ]);
  });
});

describe('noRequestPosted', () => {
  it('holds only when every sent loan is established as not posted', () => {
    expect(
      noRequestPosted([
        { loanId: 1, kind: 'open', reason: 'x' },
        { loanId: 2, kind: 'changed' },
      ]),
    ).toBe(true);
    expect(noRequestPosted([{ loanId: 1, kind: 'pending' }])).toBe(false);
    expect(noRequestPosted([{ loanId: 1, kind: 'unknown' }])).toBe(false);
    expect(noRequestPosted([{ loanId: 1, kind: 'posted', offerId: '9' }])).toBe(false);
  });
});

describe('packing', () => {
  it('keeps each loan’s guardrail write right before its request', () => {
    expect(refinanceSendCalls([plan(1, { caps: true }), plan(2)]).map((c) => c.functionName)).toEqual(
      ['setAutoRefinanceCaps', 'createOffer', 'createOffer'],
    );
  });

  it('sends at most 15 loans per transaction, so a pair is never split', () => {
    expect(LOANS_PER_REFINANCE_SEND).toBe(15);
    const chunks = chunkRefinanceLoans(Array.from({ length: 31 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([15, 15, 1]);
  });

  it('sums the approvals and the spare amounts per token', () => {
    expect(
      refinanceTotals([plan(1, { approval: 100n, topUp: 7n }), plan(2, { approval: 50n, topUp: 3n })]),
    ).toEqual([{ token: TOKEN, approval: 150n, topUp: 10n }]);
  });
});
