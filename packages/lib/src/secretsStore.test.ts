import { describe, expect, it } from 'vitest';
import { readSecret, readSecrets, type SecretBinding } from './secretsStore';

const ok = (v: string): SecretBinding => ({ get: async () => v });
const bad = (): SecretBinding => ({
  get: async () => {
    throw new Error('Secrets Worker: Failed to fetch secret');
  },
});

describe('readSecrets', () => {
  it('returns each value by name; an unbound secret is undefined and silent', async () => {
    const lines: string[] = [];
    const out = await readSecrets({ A: ok('a'), B: undefined }, { log: (l) => lines.push(l) });
    expect(out).toEqual({ A: 'a', B: undefined });
    expect(lines).toEqual([]);
  });

  it('names each secret that failed, and leaves the others readable', async () => {
    const lines: string[] = [];
    const out = await readSecrets(
      { RPC_BASE: ok('s3cr3t-value'), RPC_ARB: bad(), TG_BOT_TOKEN: bad(), RPC_ETH: undefined },
      { log: (l) => lines.push(l) },
    );
    expect(out).toEqual({ RPC_BASE: 's3cr3t-value', RPC_ARB: undefined, TG_BOT_TOKEN: undefined, RPC_ETH: undefined });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('could not read RPC_ARB');
    expect(lines[1]).toContain('could not read TG_BOT_TOKEN');
    expect(lines.join('')).not.toContain('s3cr3t-value');
  });

  it('says once that the store is unavailable when every bound secret failed, naming them', async () => {
    const lines: string[] = [];
    await readSecrets({ A: bad(), B: bad(), C: bad(), D: undefined }, { log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Secrets Store unavailable');
    expect(lines[0]).toContain('none of the 3 secrets');
    expect(lines[0]).toContain('(A, B, C)');
  });

  it('counts only the bindings it actually reads', async () => {
    let reads = 0;
    await readSecrets({ A: ok('a'), B: bad(), C: undefined }, { onRead: () => reads++, log: () => {} });
    expect(reads).toBe(2);
  });
});

describe('readSecret', () => {
  it('names the secret on a failed read', async () => {
    const lines: string[] = [];
    expect(await readSecret('ALCHEMY_WEBHOOK_SIGNING_KEY', bad(), { log: (l) => lines.push(l) })).toBeUndefined();
    expect(lines[0]).toContain('could not read ALCHEMY_WEBHOOK_SIGNING_KEY');
  });
});
