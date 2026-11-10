/**
 * Secrets Store reads in `resolveEnv`: two policies, side by side.
 *
 * Every secret but one goes through the shared `readSecrets`
 * (`@vaipakam/lib/secretsStore`): a failed read is unset for the run and is
 * logged by the secret's name, so one unavailable secret cannot take the
 * whole tick down. `PRIVATE_TX_RPCS` is the exception (#3240): its absence
 * means "send publicly", so a binding that is present but unreadable is
 * reported as a failure the private-send path refuses on, never as unset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnv, type WorkerEnv } from '../src/env';

const ok = (v: string) => ({ get: async () => v });
const failing = () => ({
  get: async (): Promise<string> => {
    throw new Error('store unavailable');
  },
});

afterEach(() => vi.restoreAllMocks());

describe('resolveEnv secret reads', () => {
  it('reads every bound secret, and leaves an unbound one unset', async () => {
    const env = await resolveEnv({
      RPC_BASE: ok('https://base.example'),
      PRIVATE_TX_RPCS: ok('{"1":"https://private.example"}'),
    } as unknown as WorkerEnv);
    expect(env.RPC_BASE).toBe('https://base.example');
    expect(env.RPC_ETH).toBeUndefined();
    expect(env.PRIVATE_TX_RPCS).toBe('{"1":"https://private.example"}');
  });

  it('treats an unreadable ordinary secret as unset and names it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = await resolveEnv({
      RPC_BASE: failing(),
      RPC_ETH: ok('https://eth.example'),
    } as unknown as WorkerEnv);
    expect(env.RPC_BASE).toBeUndefined();
    expect(env.RPC_ETH).toBe('https://eth.example');
    const lines = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).toContain('RPC_BASE');
    expect(lines).not.toContain('RPC_ETH');
  });

  it('reports an unreadable PRIVATE_TX_RPCS as a failure, never as unset (#3240)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = await resolveEnv({
      PRIVATE_TX_RPCS: failing(),
    } as unknown as WorkerEnv);
    expect(env.PRIVATE_TX_RPCS).toEqual({ secretReadFailed: true });
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      'could not read PRIVATE_TX_RPCS; its dependent feature refuses this run',
    );
  });

  it('leaves an absent PRIVATE_TX_RPCS binding unset', async () => {
    const env = await resolveEnv({} as unknown as WorkerEnv);
    expect(env.PRIVATE_TX_RPCS).toBeUndefined();
  });
});
