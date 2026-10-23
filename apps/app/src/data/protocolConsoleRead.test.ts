/**
 * #2074 — which source the Protocol Console shows, and why.
 */
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_KNOB_GETTERS } from '@vaipakam/lib/protocolKnobs';
import {
  CONSOLE_SNAPSHOT_MAX_AGE_SEC,
  loadProtocolConsole,
  snapshotGap,
  type ChainConsoleRead,
} from './protocolConsoleRead';
import type { ProtocolKnobSnapshot, ProtocolKnobValues } from './indexer';

const NOW = 1_800_000_000;

function allKnobs(): Record<string, string> {
  return Object.fromEntries(PROTOCOL_KNOB_GETTERS.map((k) => [k.key, '1']));
}

function snapshot(over: Partial<ProtocolKnobSnapshot> = {}): ProtocolKnobSnapshot {
  return {
    values: { treasuryFeeBps: '200', ...allKnobs() } as ProtocolKnobValues,
    unreported: [],
    flags: {},
    sourceBlock: 100,
    updatedAt: NOW - 60,
    ...over,
  };
}

const CHAIN: ChainConsoleRead = {
  values: { treasuryFeeBps: '250' } as ProtocolKnobValues,
  unreported: [],
  blockNumber: 123n,
};

describe('snapshotGap', () => {
  it('accepts a dated, labelled, complete snapshot inside the refresh window', () => {
    expect(snapshotGap(snapshot(), NOW)).toBeNull();
  });

  it('names each way a snapshot falls short', () => {
    expect(snapshotGap(null, NOW)).toBe('missing');
    expect(snapshotGap(snapshot({ stale: true, updatedAt: 0 }), NOW)).toBe('known-stale');
    expect(snapshotGap(snapshot({ updatedAt: undefined }), NOW)).toBe('undated');
    expect(snapshotGap(snapshot({ updatedAt: 0 }), NOW)).toBe('undated');
    expect(snapshotGap(snapshot({ updatedAt: NOW + 3600 }), NOW)).toBe('undated');
    expect(snapshotGap(snapshot({ updatedAt: NOW - CONSOLE_SNAPSHOT_MAX_AGE_SEC }), NOW)).toBe('old');
    expect(snapshotGap(snapshot({ labelsUnavailable: true }), NOW)).toBe('unlabelled');
  });

  it('calls a snapshot incomplete when a setting is neither reported nor named unreported', () => {
    const values = { ...allKnobs() } as Record<string, string>;
    delete values.minHealthFactor;
    // An older indexer: no settings list at all.
    expect(snapshotGap(snapshot({ values: values as ProtocolKnobValues, unreported: undefined }), NOW)).toBe(
      'incomplete',
    );
    // Named as unreported by the chain: accounted for, so complete.
    expect(
      snapshotGap(snapshot({ values: values as ProtocolKnobValues, unreported: ['minHealthFactor'] }), NOW),
    ).toBeNull();
  });
});

describe('loadProtocolConsole', () => {
  it('shows a current snapshot without touching the chain', async () => {
    const readChain = vi.fn();
    const r = await loadProtocolConsole({
      fetchSnapshot: async () => snapshot(),
      readChain,
      nowSec: () => NOW,
    });
    expect(r.source).toBe('snapshot');
    expect(r.source === 'snapshot' && r.chainReadFailed).toBeUndefined();
    expect(readChain).not.toHaveBeenCalled();
  });

  it('reads the chain when the snapshot is old, and says why', async () => {
    const r = await loadProtocolConsole({
      fetchSnapshot: async () => snapshot({ updatedAt: NOW - 8 * 3600 }),
      readChain: async () => CHAIN,
      nowSec: () => NOW,
    });
    expect(r).toMatchObject({ source: 'chain', why: 'old', readAtSec: NOW, blockNumber: 123n });
    expect(r.source === 'chain' && r.values.treasuryFeeBps).toBe('250');
  });

  it('reads the chain when the indexer cannot be reached', async () => {
    const r = await loadProtocolConsole({
      fetchSnapshot: async () => {
        throw new Error('down');
      },
      readChain: async () => CHAIN,
      nowSec: () => NOW,
    });
    expect(r).toMatchObject({ source: 'chain', why: 'missing' });
  });

  it('falls back to a snapshot that is not current only when the chain read fails, and marks it', async () => {
    const r = await loadProtocolConsole({
      fetchSnapshot: async () => snapshot({ stale: true, updatedAt: 0 }),
      readChain: async () => {
        throw new Error('rpc down');
      },
      nowSec: () => NOW,
    });
    expect(r).toMatchObject({ source: 'snapshot', chainReadFailed: 'known-stale' });
  });

  it('throws when there is neither a snapshot nor a chain read', async () => {
    await expect(
      loadProtocolConsole({
        fetchSnapshot: async () => null,
        readChain: async () => {
          throw new Error('rpc down');
        },
        nowSec: () => NOW,
      }),
    ).rejects.toThrow('rpc down');
  });
});
