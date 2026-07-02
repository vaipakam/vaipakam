import { describe, expect, it } from 'vitest';
import { resolveIndexerOrigin } from '../src/lib/indexerOrigin';
import { filterActiveOffersByCreator } from '@vaipakam/defi-client';
import type { IndexedOffer } from '@vaipakam/defi-client';

describe('resolveIndexerOrigin', () => {
  it('uses explicit env value when set', () => {
    expect(resolveIndexerOrigin('https://custom.example/')).toBe('https://custom.example');
  });

  it('falls back in dev when unset', () => {
    expect(resolveIndexerOrigin(undefined)).toBe('https://indexer.vaipakam.com');
  });
});

describe('filterActiveOffersByCreator', () => {
  it('keeps only active offers', () => {
    const offers = [
      { status: 'active' },
      { status: 'cancelled' },
      { status: 'active' },
    ] as IndexedOffer[];
    expect(filterActiveOffersByCreator(offers)).toHaveLength(2);
  });
});