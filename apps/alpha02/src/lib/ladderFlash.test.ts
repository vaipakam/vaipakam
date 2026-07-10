/**
 * #1131 phase 3 — book delta detection: flash exactly the levels
 * whose size changed (or newly appeared) within the SAME (pair,
 * tenor) market; never flash on a market switch or first population.
 */
import { describe, expect, it } from 'vitest';
import type { IndexedOffer } from '../data/indexer';
import type { DeskLadder, LadderLevel } from '../data/desk';
import {
  ladderFlashIds,
  ladderMarketKey,
  levelFlashId,
  snapshotLadder,
  type LadderSnapshot,
} from './ladderFlash';

const CHAIN = 84532;

function offer(p: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    lendingAsset: '0xAaAa000000000000000000000000000000000001',
    collateralAsset: '0xBbBb000000000000000000000000000000000002',
    durationDays: 30,
    ...p,
  } as IndexedOffer;
}

function level(
  rateBps: number,
  size: bigint,
  o: IndexedOffer = offer(),
): LadderLevel {
  return { rateBps, size, cumulative: size, offers: [o], own: false };
}

function ladder(asks: LadderLevel[], bids: LadderLevel[]): DeskLadder {
  return {
    asks,
    bids,
    bestAskBps: asks[0]?.rateBps ?? null,
    bestBidBps: bids[0]?.rateBps ?? null,
    midBps: null,
    spreadBps: null,
  };
}

const EMPTY: LadderSnapshot = { marketKey: null, sizes: new Map() };

describe('ladderMarketKey', () => {
  it('derives chain:pair:tenor from the first row, case-folded', () => {
    const l = ladder([level(900, 5n)], []);
    expect(ladderMarketKey(l, CHAIN)).toBe(
      `${CHAIN}:0xaaaa000000000000000000000000000000000001:0xbbbb000000000000000000000000000000000002:30`,
    );
  });

  it('is null for an absent or empty ladder', () => {
    expect(ladderMarketKey(null, CHAIN)).toBeNull();
    expect(ladderMarketKey(ladder([], []), CHAIN)).toBeNull();
  });

  it('falls back to the bid side on a one-sided book', () => {
    expect(ladderMarketKey(ladder([], [level(600, 1n)]), CHAIN)).not.toBeNull();
  });
});

describe('ladderFlashIds', () => {
  it('never flashes on the first population of a market', () => {
    const l = ladder([level(900, 5n), level(950, 2n)], [level(600, 3n)]);
    expect(ladderFlashIds(EMPTY, l, CHAIN).size).toBe(0);
  });

  it('flashes exactly the level whose size changed', () => {
    const a = ladder([level(900, 5n), level(950, 2n)], [level(600, 3n)]);
    const b = ladder([level(900, 4n), level(950, 2n)], [level(600, 3n)]);
    const flash = ladderFlashIds(snapshotLadder(a, CHAIN), b, CHAIN);
    expect([...flash]).toEqual([levelFlashId('ask', 900)]);
  });

  it('flashes a newly appeared level, not its unchanged neighbours', () => {
    const a = ladder([level(900, 5n)], [level(600, 3n)]);
    const b = ladder([level(900, 5n)], [level(600, 3n), level(550, 7n)]);
    const flash = ladderFlashIds(snapshotLadder(a, CHAIN), b, CHAIN);
    expect([...flash]).toEqual([levelFlashId('bid', 550)]);
  });

  it('side-scopes ids — an ask and a bid at the same rate are distinct', () => {
    const a = ladder([level(700, 5n)], [level(700, 5n)]);
    const b = ladder([level(700, 5n)], [level(700, 9n)]);
    const flash = ladderFlashIds(snapshotLadder(a, CHAIN), b, CHAIN);
    expect([...flash]).toEqual([levelFlashId('bid', 700)]);
  });

  it('skips the diff entirely on a market switch (pair change)', () => {
    const a = ladder([level(900, 5n)], []);
    const other = offer({ lendingAsset: '0xCcCc000000000000000000000000000000000003' });
    const b = ladder([level(900, 8n, other), level(950, 1n, other)], []);
    expect(ladderFlashIds(snapshotLadder(a, CHAIN), b, CHAIN).size).toBe(0);
  });

  it('skips the diff on a tenor switch — same pair, different market', () => {
    const a = ladder([level(900, 5n)], []);
    const b = ladder([level(900, 8n, offer({ durationDays: 7 }))], []);
    expect(ladderFlashIds(snapshotLadder(a, CHAIN), b, CHAIN).size).toBe(0);
  });

  it('a market that emptied then repopulates counts as fresh — no flash', () => {
    const a = ladder([level(900, 5n)], []);
    const emptied = snapshotLadder(ladder([], []), CHAIN); // marketKey null
    expect(emptied.marketKey).toBeNull();
    expect(ladderFlashIds(emptied, a, CHAIN).size).toBe(0);
  });

  it('returns nothing for an absent ladder', () => {
    const a = ladder([level(900, 5n)], []);
    expect(ladderFlashIds(snapshotLadder(a, CHAIN), null, CHAIN).size).toBe(0);
  });

  it('unchanged ladder diffs to an empty set (re-render is a no-op)', () => {
    const a = ladder([level(900, 5n)], [level(600, 3n)]);
    expect(ladderFlashIds(snapshotLadder(a, CHAIN), a, CHAIN).size).toBe(0);
  });
});
