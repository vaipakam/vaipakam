import { describe, expect, it } from 'vitest';
import {
  INDEX_STALE_AFTER_SEC,
  indexReadingOf,
  parseIngestReplay,
  type IngestReplay,
} from './ingestReplay';

const NOW = 1_800_000_000;
const notReplaying: IngestReplay = {
  replaying: false,
  reason: null,
  lagBlocks: 10,
  caughtUpWithinBlocks: 2000,
};

describe('parseIngestReplay', () => {
  it('reads the envelope the indexer sends', () => {
    expect(
      parseIngestReplay({
        chainId: 84532,
        replaying: true,
        reason: 'rebuild',
        cursorBlock: 1,
        safeHead: 9,
        safeHeadObservedAt: 5,
        lagBlocks: 8,
        caughtUpWithinBlocks: 2000,
      }),
    ).toEqual({ replaying: true, reason: 'rebuild', lagBlocks: 8, caughtUpWithinBlocks: 2000 });
  });

  it('an absent or malformed field is not stated, never "not replaying"', () => {
    expect(parseIngestReplay(undefined)).toBeNull();
    expect(parseIngestReplay(null)).toBeNull();
    expect(parseIngestReplay([1])).toBeNull();
    expect(parseIngestReplay({ replaying: 'yes', lagBlocks: 'x' })).toEqual({
      replaying: null,
      reason: null,
      lagBlocks: null,
      caughtUpWithinBlocks: null,
    });
  });

  it('drops a reason the indexer gave without a replay, and an unknown reason', () => {
    expect(parseIngestReplay({ replaying: false, reason: 'deployment' })?.reason).toBeNull();
    expect(parseIngestReplay({ replaying: true, reason: 'reorg' })?.reason).toBeNull();
  });
});

describe('indexReadingOf', () => {
  it('a stated replay outranks a young cursor', () => {
    expect(
      indexReadingOf({ ...notReplaying, replaying: true, reason: 'deployment', lagBlocks: 40_000 }, NOW - 5, NOW),
    ).toEqual({ kind: 'rebuilding', reason: 'deployment', lagBlocks: 40_000 });
  });

  it('a replay with no cursor yet (a reset just cleared it) is still rebuilding', () => {
    expect(indexReadingOf({ ...notReplaying, replaying: true, reason: 'rebuild', lagBlocks: null }, null, NOW).kind).toBe(
      'rebuilding',
    );
  });

  it('a block gap beyond the caught-up cut is behind, whatever the age', () => {
    expect(indexReadingOf({ ...notReplaying, lagBlocks: 2001 }, NOW - 5, NOW)).toEqual({
      kind: 'behind-blocks',
      lagBlocks: 2001,
    });
    expect(indexReadingOf({ ...notReplaying, lagBlocks: 2000 }, NOW - 5, NOW).kind).toBe('current');
  });

  it('an unmeasured gap falls back to the age rule', () => {
    expect(indexReadingOf({ ...notReplaying, lagBlocks: null }, NOW - INDEX_STALE_AFTER_SEC, NOW)).toEqual({
      kind: 'stale',
      ageSec: INDEX_STALE_AFTER_SEC,
    });
  });

  it('current is up to date only when the indexer said it is not rebuilding', () => {
    expect(indexReadingOf(notReplaying, NOW - 60, NOW)).toEqual({ kind: 'current', ageSec: 60, replayKnown: true });
    expect(indexReadingOf(null, NOW - 60, NOW)).toEqual({ kind: 'current', ageSec: 60, replayKnown: false });
    expect(indexReadingOf({ ...notReplaying, replaying: null }, NOW - 60, NOW)).toMatchObject({
      replayKnown: false,
    });
  });

  it('no cursor and no replay is unknown', () => {
    expect(indexReadingOf(null, null, NOW)).toEqual({ kind: 'unknown' });
    expect(indexReadingOf(notReplaying, null, NOW)).toEqual({ kind: 'unknown' });
  });

  it('a future cursor stamp reads as age 0, not negative', () => {
    expect(indexReadingOf(notReplaying, NOW + 30, NOW)).toMatchObject({ kind: 'current', ageSec: 0 });
  });
});
