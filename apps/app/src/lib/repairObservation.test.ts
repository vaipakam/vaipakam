import { describe, expect, it } from 'vitest';
import { coalesceByTx } from './activityView';
import { mergeFeed, readRepairObservations } from './repairObservation';
import type { IndexedActivityEvent } from '../data/indexer';

// The indexer's own base for an observation's log index
// (`REPAIR_OBSERVATION_LOG_INDEX_BASE`): above every real log index.
const BASE = 1_000_000_000;

const entry = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  loanId: 7,
  observedStatus: 'repaid',
  observedBlock: 500,
  observedAt: 1_792_000_000,
  feedLogIndex: BASE + 7,
  provenance: 'reconciliation',
  ...over,
});

const ev = (blockNumber: number, logIndex: number, txHash: string): IndexedActivityEvent => ({
  chainId: 84532,
  blockNumber,
  logIndex,
  txHash,
  kind: 'LoanRepaid',
  loanId: 1,
  offerId: null,
  actor: null,
  args: {},
  blockAt: 0,
});

describe('readRepairObservations', () => {
  it('reads well-formed entries, with or without a checked time', () => {
    const got = readRepairObservations([entry(), entry({ loanId: 8, feedLogIndex: BASE + 8, observedAt: null })], 84532);
    expect(got).toEqual([
      {
        chainId: 84532,
        loanId: 7,
        observedStatus: 'repaid',
        observedBlock: 500,
        observedAt: 1_792_000_000,
        feedLogIndex: BASE + 7,
      },
      {
        chainId: 84532,
        loanId: 8,
        observedStatus: 'repaid',
        observedBlock: 500,
        observedAt: null,
        feedLogIndex: BASE + 8,
      },
    ]);
  });

  it('an empty list is a known "none"', () => {
    expect(readRepairObservations([], 84532)).toEqual([]);
  });

  it('null and absent are NOT KNOWN, never "none"', () => {
    expect(readRepairObservations(null, 84532)).toBeNull();
    expect(readRepairObservations(undefined, 84532)).toBeNull();
    expect(readRepairObservations({}, 84532)).toBeNull();
  });

  it('one malformed entry makes the whole field unknown, not a partial list', () => {
    const bad = [
      entry({ provenance: 'event' }),
      entry({ chainId: 1 }),
      entry({ loanId: -1 }),
      entry({ loanId: '7' }),
      entry({ observedBlock: 1.5 }),
      entry({ feedLogIndex: undefined }),
      entry({ observedStatus: '' }),
      entry({ observedStatus: 3 }),
      entry({ observedAt: 'yesterday' }),
      null,
      'repaid',
    ];
    for (const b of bad) {
      expect(readRepairObservations([entry(), b], 84532)).toBeNull();
    }
  });
});

describe('mergeFeed', () => {
  it('orders rows and observations newest first, by block then log index', () => {
    const rows = coalesceByTx([ev(600, 2, '0xa'), ev(400, 1, '0xb'), ev(500, 3, '0xc')]);
    const obs = readRepairObservations(
      [entry({ observedBlock: 550, loanId: 4, feedLogIndex: BASE + 4 }), entry()],
      84532,
    )!;
    const order = mergeFeed(rows, obs).map((i) =>
      i.type === 'tx' ? `tx@${i.row.event.blockNumber}` : `obs@${i.observation.observedBlock}#${i.observation.loanId}`,
    );
    expect(order).toEqual(['tx@600', 'obs@550#4', 'obs@500#7', 'tx@500', 'tx@400']);
  });

  it('at a shared block an observation comes before the block\'s events, as in the indexer\'s page', () => {
    const rows = coalesceByTx([ev(500, 9, '0xc')]);
    const obs = readRepairObservations([entry()], 84532)!;
    expect(mergeFeed(rows, obs).map((i) => i.type)).toEqual(['observation', 'tx']);
  });

  it('gives each observation its own key', () => {
    const obs = readRepairObservations(
      [entry(), entry({ loanId: 8, feedLogIndex: BASE + 8 })],
      84532,
    )!;
    const keys = mergeFeed([], obs).map((i) => i.key);
    expect(new Set(keys).size).toBe(2);
  });
});
