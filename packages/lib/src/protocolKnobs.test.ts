/**
 * #2071 / #2074 — the knob registry is pinned to the compiled Diamond ABI,
 * and the shared reader turns one batched read into named values plus an
 * explicit list of what the chain did not answer.
 */
import { describe, expect, it } from 'vitest';
import { getAbiItem, toFunctionSelector, type Abi, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM, PriceGuardABI } from '@vaipakam/contracts/abis';
import {
  EVENTLESS_PROTOCOL_KNOBS,
  LABELLED_KNOB_GETTERS,
  LABELLED_KNOB_KEYS,
  PRICE_GUARD_KNOB_GETTERS,
  PROTOCOL_KNOB_GETTERS,
  PROTOCOL_KNOB_SETTER_EVENTS,
  abiDescribesGetterAt,
  abiOutputNames,
  readProtocolKnobGetters,
  structListFieldNames,
} from './protocolKnobs';

type AbiFn = {
  type: string;
  name: string;
  stateMutability?: string;
  inputs?: readonly unknown[];
  outputs?: readonly { name?: string }[];
};

const fns = (DIAMOND_ABI_VIEM as readonly AbiFn[]).filter((e) => e.type === 'function');
const GUARD_ABI = PriceGuardABI as Abi;
const guardFns = (GUARD_ABI as readonly AbiFn[]).filter((e) => e.type === 'function');

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
    // #3272 part 2 — the price guard the registry names, and every one of
    // the guard's settings: each changes in a transaction the guard or the
    // registry announces, from an address the snapshot does not hear. A
    // setting added later that has a silent setter must be marked here, by
    // name.
    expect([...EVENTLESS_PROTOCOL_KNOBS].sort()).toEqual(
      ['priceGuard', ...PRICE_GUARD_KNOB_GETTERS.map((k) => k.key)].sort(),
    );
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
            case 'getTreasury':
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
      guardAbi: GUARD_ABI,
      blockNumber: 42n,
      facets: undefined,
    });
    // Each labelled getter adds its loupe host and its answer.
    expect(asked).toEqual({
      blockNumber: 42n,
      count: PROTOCOL_KNOB_GETTERS.length + 2 * LABELLED_KNOB_GETTERS.length,
    });
    expect(r.values).toEqual({
      minHealthFactor: '1500000000000000000',
      preNotifyDays: '3',
      autoLendEnabled: false,
      treasury: '0x00000000000000000000000000000000000000aa',
    });
    // No artifact: no labelled getter can be bound, so all are unreported;
    // and no guard was named, so none of its settings were asked.
    expect(r.unreported).toHaveLength(
      PROTOCOL_KNOB_GETTERS.length - 4 + LABELLED_KNOB_KEYS.length + PRICE_GUARD_KNOB_GETTERS.length,
    );
    expect(r.unreported).not.toContain('minHealthFactor');
    expect(r.unreported).toContain('rewardGraceSeconds');
    expect(r.unreported).toContain('pythOracle');
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
        guardAbi: GUARD_ABI,
        blockNumber: 1n,
        facets: undefined,
      }),
    ).rejects.toThrow('rpc down');
  });
});

describe('LABELLED_KNOB_GETTERS (#2680)', () => {
  it('backs each getter with a no-argument view the Diamond routes, every output accounted for', () => {
    for (const g of LABELLED_KNOB_GETTERS) {
      const entry = fns.filter((f) => f.name === g.getter);
      expect(entry, g.getter).toHaveLength(1);
      expect(['view', 'pure'], g.getter).toContain(entry[0].stateMutability);
      expect(entry[0].inputs ?? [], g.getter).toHaveLength(0);
      if (g.kind === 'tuple') {
        // Every output is either published under a key or left out with a
        // reason on record, and no mapping names an output that is not there.
        const names = abiOutputNames(DIAMOND_ABI_VIEM, g.getter) ?? [];
        const accounted = [...Object.keys(g.fields), ...Object.keys('notPublished' in g ? g.notPublished : {})];
        expect([...accounted].sort(), g.getter).toEqual([...names].sort());
      } else {
        expect(structListFieldNames(DIAMOND_ABI_VIEM, g.getter), g.getter).not.toBeNull();
      }
    }
  });

  it('publishes each key once, never a name a single getter or the bundle publishes', () => {
    expect(new Set(LABELLED_KNOB_KEYS).size).toBe(LABELLED_KNOB_KEYS.length);
    const taken = new Set<string>([
      ...PROTOCOL_KNOB_GETTERS.map((k) => k.key),
      ...(abiOutputNames(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle') ?? []),
    ]);
    for (const k of LABELLED_KNOB_KEYS) expect(taken.has(k), k).toBe(false);
  });

  it('names setter events the Diamond declares, and refreshes on them', () => {
    const events = new Set(
      (DIAMOND_ABI_VIEM as readonly { type: string; name?: string }[])
        .filter((e) => e.type === 'event')
        .map((e) => e.name),
    );
    for (const g of LABELLED_KNOB_GETTERS) {
      for (const name of g.setterEvents) {
        expect(events.has(name), `${g.getter}: ${name}`).toBe(true);
        expect(PROTOCOL_KNOB_SETTER_EVENTS.has(name)).toBe(true);
      }
    }
  });
});

describe('readProtocolKnobGetters — multi-part settings (#2680)', () => {
  const HOSTS = {
    adminFacet: '0x00000000000000000000000000000000000000A1',
    configFacet: '0x00000000000000000000000000000000000000C1',
  } as const;
  const SELECTOR_HOST = new Map<string, string>(
    LABELLED_KNOB_GETTERS.map((g) => [
      toFunctionSelector(getAbiItem({ abi: DIAMOND_ABI_VIEM, name: g.getter }) as never),
      HOSTS[g.host as keyof typeof HOSTS],
    ]),
  );
  const ANSWERS: Record<string, unknown> = {
    getPartialLiquidationSizing: [12_000n, 9_500n, 0n],
    getTierLiqDiscountBps: [770, 600, 500],
    getNotificationFeeConfig: [5n * 10n ** 17n, 123n],
    getGraceBuckets: [
      { maxDurationDays: 7n, graceSeconds: 3600n },
      { maxDurationDays: 0n, graceSeconds: 2_592_000n },
    ],
  };
  function client(loupe: (selector: string) => string | undefined, answers = ANSWERS) {
    return {
      multicall: async (args: { contracts: readonly { functionName: string; args?: readonly unknown[] }[] }) =>
        args.contracts.map((c) => {
          if (c.functionName === 'facetAddress') {
            const h = loupe(String(c.args?.[0]));
            return h === undefined ? { status: 'failure', error: new Error('x') } : { status: 'success', result: h };
          }
          return c.functionName in answers
            ? { status: 'success', result: answers[c.functionName] }
            : { status: 'failure', error: new Error('FunctionDoesNotExist') };
        }),
    } as unknown as PublicClient;
  }
  const read = (c: PublicClient, facets: typeof HOSTS | null = HOSTS) =>
    readProtocolKnobGetters({
      client: c,
      diamond: '0x00000000000000000000000000000000000000dd',
      abi: DIAMOND_ABI_VIEM,
      guardAbi: GUARD_ABI,
      blockNumber: 9n,
      facets: facets ?? undefined,
    });

  it('publishes each part under its key when the loupe host is the artifact host', async () => {
    // Case-insensitive: the loupe answers checksummed text, the artifact may not.
    const r = await read(client((s) => SELECTOR_HOST.get(s)?.toLowerCase()));
    expect(r.values).toMatchObject({
      partialLiqTargetHfCeilingBps: '12000',
      partialLiqDeepUnderwaterHfBps: '9500',
      partialLiqDustFloorNumeraire: '0',
      tier1LiqDiscountBps: '770',
      tier2LiqDiscountBps: '600',
      tier3LiqDiscountBps: '500',
      notificationFeeVpfi: '500000000000000000',
      graceBuckets: [
        { maxDurationDays: '7', graceSeconds: '3600' },
        { maxDurationDays: '0', graceSeconds: '2592000' },
      ],
    });
    // A running total is not a setting and is never published.
    expect(Object.values(r.values)).not.toContain('123');
    expect(r.unreported.filter((k) => LABELLED_KNOB_KEYS.includes(k))).toEqual([]);
  });

  it('publishes an empty grace list as an empty list (none set), not as unreported', async () => {
    const r = await read(client((s) => SELECTOR_HOST.get(s), { ...ANSWERS, getGraceBuckets: [] }));
    expect(r.values.graceBuckets).toEqual([]);
    expect(r.unreported).not.toContain('graceBuckets');
  });

  it('reports a getter unreported, whole, when its host is not the artifact host', async () => {
    const tierSel = toFunctionSelector(getAbiItem({ abi: DIAMOND_ABI_VIEM, name: 'getTierLiqDiscountBps' }) as never);
    const r = await read(
      client((s) => (s === tierSel ? '0x00000000000000000000000000000000000000ee' : SELECTOR_HOST.get(s))),
    );
    for (const k of ['tier1LiqDiscountBps', 'tier2LiqDiscountBps', 'tier3LiqDiscountBps']) {
      expect(r.values[k], k).toBeUndefined();
      expect(r.unreported).toContain(k);
    }
    expect(r.values.notificationFeeVpfi).toBe('500000000000000000');
  });

  it('reports every part unreported when the loupe read fails, the answer fails, or there is no artifact', async () => {
    const noLoupe = await read(client(() => undefined));
    expect(noLoupe.unreported).toEqual(expect.arrayContaining([...LABELLED_KNOB_KEYS]));
    const noAnswer = await read(client((s) => SELECTOR_HOST.get(s), {}));
    expect(noAnswer.unreported).toEqual(expect.arrayContaining([...LABELLED_KNOB_KEYS]));
    const noArtifact = await read(client((s) => SELECTOR_HOST.get(s)), null);
    expect(noArtifact.unreported).toEqual(expect.arrayContaining([...LABELLED_KNOB_KEYS]));
  });

  it('never half-reports a getter whose answer is not the shape its ABI describes', async () => {
    const r = await read(
      client((s) => SELECTOR_HOST.get(s), { ...ANSWERS, getPartialLiquidationSizing: [12_000n, 9_500n] }),
    );
    expect(r.values.partialLiqTargetHfCeilingBps).toBeUndefined();
    expect(r.unreported).toEqual(
      expect.arrayContaining(['partialLiqTargetHfCeilingBps', 'partialLiqDeepUnderwaterHfBps', 'partialLiqDustFloorNumeraire']),
    );
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

describe('PRICE_GUARD_KNOB_GETTERS (#3272 part 2)', () => {
  it('names each key once, never a key the Diamond getters or the bundle publish', () => {
    const keys = PRICE_GUARD_KNOB_GETTERS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    const diamondKeys = new Set<string>([...PROTOCOL_KNOB_GETTERS.map((k) => k.key), ...LABELLED_KNOB_KEYS]);
    for (const k of keys) expect(diamondKeys.has(k), k).toBe(false);
    const bundle = abiOutputNames(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle') ?? [];
    for (const k of keys) expect(bundle).not.toContain(k);
  });

  it('backs every key with a no-argument, single-output view the guard declares', () => {
    for (const k of PRICE_GUARD_KNOB_GETTERS) {
      const entry = guardFns.filter((f) => f.name === k.getter);
      expect(entry, k.getter).toHaveLength(1);
      expect(['view', 'pure'], k.getter).toContain(entry[0].stateMutability);
      expect(entry[0].inputs ?? [], k.getter).toHaveLength(0);
      expect(entry[0].outputs ?? [], k.getter).toHaveLength(1);
    }
  });

  it('reads the guard the Diamond names, at the same block', async () => {
    const GUARD = '0x00000000000000000000000000000000000000Ab';
    const calls: { address: string; blockNumber?: bigint; names: string[] }[] = [];
    const client = {
      multicall: async (args: {
        contracts: readonly { address: string; functionName: string }[];
        blockNumber?: bigint;
      }) => {
        calls.push({
          address: args.contracts[0]?.address ?? '',
          blockNumber: args.blockNumber,
          names: args.contracts.map((c) => c.functionName),
        });
        return args.contracts.map((c) => {
          if (c.functionName === 'getPriceGuard') return { status: 'success', result: GUARD };
          if (c.address === GUARD && c.functionName === 'delay') return { status: 'success', result: 259_200n };
          if (c.address === GUARD && c.functionName === 'weth') {
            return { status: 'success', result: '0x00000000000000000000000000000000000000e7' };
          }
          return { status: 'failure', error: new Error('x') };
        });
      },
    } as unknown as PublicClient;
    const r = await readProtocolKnobGetters({
      client,
      diamond: '0x00000000000000000000000000000000000000dd',
      abi: DIAMOND_ABI_VIEM,
      guardAbi: GUARD_ABI,
      blockNumber: 77n,
      facets: undefined,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      address: GUARD,
      blockNumber: 77n,
      names: PRICE_GUARD_KNOB_GETTERS.map((k) => k.getter),
    });
    expect(r.values.priceGuard).toBe(GUARD);
    expect(r.values.priceGuardDelaySeconds).toBe('259200');
    expect(r.values.wethContract).toBe('0x00000000000000000000000000000000000000e7');
    expect(r.unreported).toContain('pythOracle');
    expect(r.unreported).not.toContain('wethContract');
  });

  it('asks the guard nothing, and reports its settings unreported, when the Diamond names none', async () => {
    let batches = 0;
    const client = {
      multicall: async (args: { contracts: readonly { functionName: string }[] }) => {
        batches++;
        return args.contracts.map((c) =>
          c.functionName === 'getPriceGuard'
            ? { status: 'success', result: '0x0000000000000000000000000000000000000000' }
            : { status: 'failure', error: new Error('x') },
        );
      },
    } as unknown as PublicClient;
    const r = await readProtocolKnobGetters({
      client,
      diamond: '0x00000000000000000000000000000000000000dd',
      abi: DIAMOND_ABI_VIEM,
      guardAbi: GUARD_ABI,
      blockNumber: 1n,
      facets: undefined,
    });
    expect(batches).toBe(1);
    expect(r.unreported).toEqual(expect.arrayContaining(PRICE_GUARD_KNOB_GETTERS.map((k) => k.key)));
  });
});
