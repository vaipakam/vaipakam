/**
 * #3858 — a network whose deployment record says Closed gets no alerts and
 * no new orders, while the reads that show a wallet what it holds stay.
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

const { getChainConfigs, getAlertChainConfigs } = await import('../src/env');
const { bindListingToProtocol } = await import('../src/openseaListingBinding');

const env = {
  RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  RPC_ARB_SEPOLIA: 'http://127.0.0.1:9',
} as unknown as Parameters<typeof getChainConfigs>[0];

describe('a Closed network (#3858)', () => {
  it('gets no alerts, and stays readable', () => {
    expect(getAlertChainConfigs(env).map((c) => c.id)).toEqual([OPEN]);
    expect(getChainConfigs(env).map((c) => c.id).sort((a, b) => a - b)).toEqual([CLOSED, OPEN]);
  });

  it('has no listing to publish', async () => {
    const verdict = await bindListingToProtocol(env, CLOSED, {} as never, `0x${'00'.repeat(20)}`);
    expect(verdict).toEqual({ kind: 'refused', status: 400, error: 'network-closed' });
  });
});
