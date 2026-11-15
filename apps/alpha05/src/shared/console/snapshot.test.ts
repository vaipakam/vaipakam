/**
 * RW-77 — the index's settings snapshot is read by its shape, and a shape
 * this app cannot read is a failure, never an empty snapshot.
 */
import { describe, expect, it } from 'vitest';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { snapshotFrom } from './snapshot';

const body = {
  chainId: 84532,
  available: true,
  values: { treasuryFeeBps: '200', partialFillEnabled: true, tierThresholds: ['1', '2'], graceBuckets: [] },
  unreported: ['priceGuard'],
  sourceBlock: 58_846_468,
  updatedAt: 1_794_691_245,
};

describe('snapshotFrom', () => {
  it('reads a labelled snapshot', () => {
    expect(snapshotFrom(body, 84532)).toEqual({
      available: true,
      values: body.values,
      unreported: ['priceGuard'],
      bundleUnreported: null,
      sourceBlock: 58_846_468,
      updatedAt: 1_794_691_245,
      stale: false,
      staleAtBlock: null,
    });
  });
  it('reads a stale snapshot with no labels', () => {
    const out = snapshotFrom(
      { chainId: 84532, available: true, bundleUnreported: 'code changed', sourceBlock: '10', updatedAt: 0, stale: true, staleAtBlock: 12 },
      84532,
    );
    expect(out).toMatchObject({ values: null, unreported: null, bundleUnreported: 'code changed', stale: true, staleAtBlock: 12, sourceBlock: 10 });
  });
  it('reads the index holding no snapshot', () => {
    expect(snapshotFrom({ chainId: 84532, available: false }, 84532)).toEqual({ available: false });
  });
  it('refuses another network, an unstated availability and values of an unknown kind', () => {
    expect(() => snapshotFrom({ ...body, chainId: 1 }, 84532)).toThrow(IndexerUnavailable);
    expect(() => snapshotFrom({ ...body, available: undefined }, 84532)).toThrow(/whether a snapshot exists/);
    expect(() => snapshotFrom({ ...body, values: { x: 5 } }, 84532)).toThrow(/unknown kind/);
    expect(() => snapshotFrom({ ...body, unreported: [1] }, 84532)).toThrow(/malformed/);
    expect(() => snapshotFrom({ ...body, sourceBlock: -1 }, 84532)).toThrow(IndexerUnavailable);
  });
});
