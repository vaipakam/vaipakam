import { describe, expect, it } from 'vitest';
import { indexerPositionFlowReader, verdictOf } from './positionFlow';
import type { IndexerClient } from '../reads/world/indexerClient';

describe('#3205 position-flow verdict', () => {
  it('reads the indexer field three ways and never rounds an unknown', () => {
    expect(verdictOf({ positionFlow: { movedSinceOpened: true } })).toBe('moved');
    expect(verdictOf({ positionFlow: { movedSinceOpened: false } })).toBe('not-moved');
    expect(verdictOf({ positionFlow: { movedSinceOpened: null } })).toBe('unknown');
    expect(verdictOf({ positionFlow: null })).toBe('not-bound');
    // An older indexer build omits the field: unknown, not "not bound".
    expect(verdictOf({})).toBe('unknown');
    expect(verdictOf(null)).toBe('unknown');
  });

  it('a failed indexer read is unknown, never a verdict', async () => {
    const failing: IndexerClient = {
      origin: 'https://idx',
      getJson: async () => {
        throw new Error('down');
      },
    };
    expect(await indexerPositionFlowReader(failing, 84532)(5n)).toBe('unknown');
    const ok: IndexerClient = {
      origin: 'https://idx',
      getJson: async <T,>(path: string) => {
        expect(path).toBe('/offers/5?chainId=84532');
        return { positionFlow: { movedSinceOpened: true } } as T;
      },
    };
    expect(await indexerPositionFlowReader(ok, 84532)(5n)).toBe('moved');
  });
});
