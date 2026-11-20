/**
 * #3858 — a network whose deployment record says Closed is no longer
 * scanned, and its stored rows are still served.
 *
 * The deployment bundle is mocked so one testnet reads as Closed; every
 * other chain keeps its real record.
 */
import { describe, expect, it, vi } from 'vitest';

const CLOSED = 84532;
const OPEN = 421614;

vi.mock('@vaipakam/contracts/deployments', async (importActual) => {
  const actual = await importActual<typeof import('@vaipakam/contracts/deployments')>();
  return {
    ...actual,
    getDeployment: (chainId: number) => {
      const dep = actual.getDeployment(chainId);
      return dep && chainId === CLOSED ? { ...dep, networkState: 'closed' as const } : dep;
    },
  };
});

const { getChainConfigs, getScanChainConfigs, configuredScanChains, configuredClosedChains, configuredServedChains } =
  await import('../src/env');
const { chainServed, chainNotConfigured } = await import('../src/servedChain');
const { readIngestHealth } = await import('../src/healthRoutes');

const raw = { RPC_BASE_SEPOLIA: 'http://127.0.0.1:9', RPC_ARB_SEPOLIA: 'http://127.0.0.1:9' };
const env = raw as unknown as Parameters<typeof getChainConfigs>[0];

describe('a Closed network (#3858)', () => {
  it('is not scanned', () => {
    expect(getScanChainConfigs(env).map((c) => c.id)).toEqual([OPEN]);
    expect(configuredScanChains(raw)).toEqual([OPEN]);
  });

  it('keeps serving its stored rows', () => {
    expect(getChainConfigs(env).map((c) => c.id).sort((a, b) => a - b)).toEqual([CLOSED, OPEN]);
    expect(chainServed(env, CLOSED)).toBe(true);
    expect(configuredServedChains(raw)).toEqual([OPEN, CLOSED].sort((a, b) => a - b));
    expect(chainNotConfigured(raw, CLOSED)).toBeNull();
  });

  it('is named on the ingest health answer, outside the watched set', async () => {
    expect(configuredClosedChains(raw)).toEqual([CLOSED]);
    const db = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }) }),
        all: async () => ({ results: [] }),
      }),
    };
    const gate = { check: async () => ({ ok: true, missing: [] }) as never };
    const out = await readIngestHealth(db as never, configuredScanChains(raw), gate, 1_000, configuredClosedChains(raw));
    expect(out.configured.chains).toEqual([OPEN]);
    expect(out.closed).toEqual([CLOSED]);
  });
});
