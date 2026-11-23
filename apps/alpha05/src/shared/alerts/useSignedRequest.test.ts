import { describe, expect, it } from 'vitest';
import type { AgentClient } from './agentClient';
import { routeOffered, signedIdentity } from './useSignedRequest';

const client = (status: number, data: Record<string, unknown> | null) => {
  const asked: unknown[][] = [];
  const c: AgentClient = {
    origin: 'https://agent.example',
    request: async (...args) => {
      asked.push(args);
      return { status, data, reference: null };
    },
  };
  return { c, asked };
};

describe('routeOffered', () => {
  it('asks with an empty body, before any signature', async () => {
    const { c, asked } = client(400, { error: 'invalid-payload' });
    expect(await routeOffered(c, '/goals/save')).toBe(true);
    expect(asked).toEqual([['POST', '/goals/save', {}]]);
  });

  it('reads only the generic 404 with no error named as not offered', async () => {
    expect(await routeOffered(client(404, null).c, '/watch/loans/add')).toBe(false);
    expect(await routeOffered(client(404, {}).c, '/watch/loans/add')).toBe(false);
    expect(await routeOffered(client(404, { error: 'not-found' }).c, '/watch/loans/add')).toBe(true);
    expect(await routeOffered(client(503, null).c, '/watch/loans/add')).toBe(true);
  });
});

describe('signedIdentity', () => {
  it('separates wallets and networks, and reads one wallet in any letter case as itself', () => {
    const a = '0x' + 'aB'.repeat(20);
    expect(signedIdentity(84532, a)).toBe(signedIdentity(84532, a.toLowerCase()));
    expect(signedIdentity(84532, a)).not.toBe(signedIdentity(421614, a));
    expect(signedIdentity(84532, a)).not.toBe(signedIdentity(84532, '0x' + 'cd'.repeat(20)));
    // A request about one loan is not another loan's.
    expect(signedIdentity(84532, a, 'loan:1')).not.toBe(signedIdentity(84532, a, 'loan:2'));
  });
});
