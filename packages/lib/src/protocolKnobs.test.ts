/**
 * #2071 / #2074 — the knob registry is pinned to the compiled Diamond ABI,
 * and the shared reader turns one batched read into named values plus an
 * explicit list of what the chain did not answer.
 */
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  EVENTLESS_PROTOCOL_KNOBS,
  PROTOCOL_KNOB_GETTERS,
  PROTOCOL_KNOB_SETTER_EVENTS,
  abiDescribesGetterAt,
  abiOutputNames,
  readProtocolKnobGetters,
} from './protocolKnobs';

type AbiFn = {
  type: string;
  name: string;
  stateMutability?: string;
  inputs?: readonly unknown[];
  outputs?: readonly { name?: string }[];
};

const fns = (DIAMOND_ABI_VIEM as readonly AbiFn[]).filter((e) => e.type === 'function');

describe('PROTOCOL_KNOB_GETTERS', () => {
  it('names each key and each getter once', () => {
    const keys = PROTOCOL_KNOB_GETTERS.map((k) => k.key);
    const getters = PROTOCOL_KNOB_GETTERS.map((k) => k.getter);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(getters).size).toBe(getters.length);
  });

  it('backs every key with a no-argument, single-output view the Diamond routes', () => {
    for (const k of PROTOCOL_KNOB_GETTERS) {
      const entry = fns.filter((f) => f.name === k.getter);
      expect(entry, k.getter).toHaveLength(1);
      expect(['view', 'pure'], k.getter).toContain(entry[0].stateMutability);
      expect(entry[0].inputs ?? [], k.getter).toHaveLength(0);
      expect(entry[0].outputs ?? [], k.getter).toHaveLength(1);
    }
  });

  it('never reuses a name the configuration bundle already publishes', () => {
    const bundle = abiOutputNames(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle') ?? [];
    expect(bundle.length).toBeGreaterThan(0);
    for (const k of PROTOCOL_KNOB_GETTERS) expect(bundle).not.toContain(k.key);
  });

  it('marks exactly the settings that can change without an event (Codex #2683 r3, #2685, #2815 r1)', () => {
    // #2685 gave the last two (`sequencerUptimeFeed`, `ethNumeraireFeed`)
    // their events, so no published setting changes silently any more and
    // the console's disclosure shows on no row. A setting added later that
    // has a silent setter must be marked here, by name.
    expect([...EVENTLESS_PROTOCOL_KNOBS].sort()).toEqual([]);
  });

  it('names a setter event for every setting that is not eventless, each one an event the Diamond declares (Codex #2815 r1)', () => {
    const events = new Set(
      (DIAMOND_ABI_VIEM as readonly { type: string; name?: string }[])
        .filter((e) => e.type === 'event')
        .map((e) => e.name),
    );
    for (const k of PROTOCOL_KNOB_GETTERS) {
      if (!('eventless' in k)) expect(k.setterEvents.length, k.key).toBeGreaterThan(0);
      for (const name of k.setterEvents) expect(events.has(name), `${k.key}: ${name}`).toBe(true);
    }
    expect(PROTOCOL_KNOB_SETTER_EVENTS.has('MinIntentFillNumeraireSet')).toBe(true);
  });

  it('refreshes the auto-pause cooldown and the time it ends on every event that moves them (#2843)', () => {
    const events = (key: string) => [...(PROTOCOL_KNOB_GETTERS.find((k) => k.key === key)?.setterEvents ?? [])].sort();
    expect(events('autoPauseCooldownSeconds')).toEqual(['AutoPauseCooldownSet']);
    // A recorded time, not a setting: the window that freezes a live
    // protocol records it, and a new cooldown applies to the one running.
    expect(events('autoPauseAvailableAt')).toEqual(['AutoPauseCooldownSet', 'AutoPaused']);
  });
});

describe('readProtocolKnobGetters', () => {
  it('reads every getter at one block and lists what the chain did not answer', async () => {
    let asked: { blockNumber?: bigint; count: number } = { count: 0 };
    const client = {
      multicall: async (args: {
        contracts: readonly { functionName: string }[];
        blockNumber?: bigint;
      }) => {
        asked = { blockNumber: args.blockNumber, count: args.contracts.length };
        return args.contracts.map((c) => {
          switch (c.functionName) {
            case 'getMinHealthFactor':
              return { status: 'success', result: 15n * 10n ** 17n };
            case 'getPreNotifyDays':
              return { status: 'success', result: 3 };
            case 'getAutoLendEnabled':
              return { status: 'success', result: false };
            case 'getPythOracle':
              return { status: 'success', result: '0x00000000000000000000000000000000000000aa' };
            default:
              return { status: 'failure', error: new Error('FunctionDoesNotExist') };
          }
        });
      },
    } as unknown as PublicClient;
    const r = await readProtocolKnobGetters({
      client,
      diamond: '0x00000000000000000000000000000000000000dd',
      abi: DIAMOND_ABI_VIEM,
      blockNumber: 42n,
    });
    expect(asked).toEqual({ blockNumber: 42n, count: PROTOCOL_KNOB_GETTERS.length });
    expect(r.values).toEqual({
      minHealthFactor: '1500000000000000000',
      preNotifyDays: '3',
      autoLendEnabled: false,
      pythOracle: '0x00000000000000000000000000000000000000aa',
    });
    expect(r.unreported).toHaveLength(PROTOCOL_KNOB_GETTERS.length - 4);
    expect(r.unreported).not.toContain('minHealthFactor');
    expect(r.unreported).toContain('treasury');
  });

  it('throws when the batch itself fails, leaving the meaning to the caller', async () => {
    const client = {
      multicall: async () => {
        throw new Error('rpc down');
      },
    } as unknown as PublicClient;
    await expect(
      readProtocolKnobGetters({
        client,
        diamond: '0x00000000000000000000000000000000000000dd',
        abi: DIAMOND_ABI_VIEM,
        blockNumber: 1n,
      }),
    ).rejects.toThrow('rpc down');
  });
});

describe('abiDescribesGetterAt (Codex #2683 r1)', () => {
  const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
  const HOST = '0x00000000000000000000000000000000000000AA';
  function client(answer: () => unknown, seen: { block?: bigint; fn?: string }[] = []) {
    return {
      readContract: async (args: { functionName: string; blockNumber?: bigint }) => {
        seen.push({ block: args.blockNumber, fn: args.functionName });
        return answer();
      },
    } as unknown as PublicClient;
  }
  const base = { diamond: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName: 'getProtocolConfigBundle', blockNumber: 7n };

  it('holds only when the loupe host AT THE READ BLOCK is the artifact host', async () => {
    const seen: { block?: bigint; fn?: string }[] = [];
    await expect(
      abiDescribesGetterAt({ ...base, client: client(() => HOST.toLowerCase(), seen), expectedHost: HOST }),
    ).resolves.toBe(true);
    expect(seen).toEqual([{ block: 7n, fn: 'facetAddress' }]);
  });

  it('cannot establish it with another host, no artifact host, or a failed loupe read', async () => {
    const other = client(() => '0x00000000000000000000000000000000000000bb');
    await expect(abiDescribesGetterAt({ ...base, client: other, expectedHost: HOST })).resolves.toBe(false);
    await expect(
      abiDescribesGetterAt({ ...base, client: client(() => HOST), expectedHost: undefined }),
    ).resolves.toBe(false);
    const failing = client(() => {
      throw new Error('rpc down');
    });
    await expect(abiDescribesGetterAt({ ...base, client: failing, expectedHost: HOST })).resolves.toBe(false);
  });
});
