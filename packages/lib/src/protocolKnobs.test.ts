/**
 * #2071 / #2074 — the knob registry is pinned to the compiled Diamond ABI,
 * and the shared reader turns one batched read into named values plus an
 * explicit list of what the chain did not answer.
 */
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  PROTOCOL_KNOB_GETTERS,
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
