import { describe, expect, it } from 'vitest';
import { REQUEST_REF_HEADER, isRequestReference } from '@vaipakam/lib/requestReference';
import { AgentUnavailable, createAgentClient } from './agentClient';

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('the alert service client and its request reference (#3922)', () => {
  it('sends a fresh reference on a write and returns it when the answer names none', async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ error: 'used' }), { status: 409 });
    }) as unknown as typeof fetch;
    const res = await createAgentClient('https://agent.test', fake).request('POST', '/alerts/link', { a: 1 });
    const sent = headersOf(seen[0]!)[REQUEST_REF_HEADER];
    expect(isRequestReference(sent)).toBe(true);
    expect(res).toEqual({ status: 409, data: { error: 'used' }, reference: sent });
  });

  it('sends none on a read, and keeps the one the service made', async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 503, headers: { [REQUEST_REF_HEADER]: 'ABCDEFGH23' } });
    }) as unknown as typeof fetch;
    const res = await createAgentClient('https://agent.test', fake).request('GET', '/alerts/state');
    expect(headersOf(seen[0]!)[REQUEST_REF_HEADER]).toBeUndefined();
    expect(res.reference).toBe('ABCDEFGH23');
  });

  it('carries the sent reference on a write that got no answer, and none on a read', async () => {
    let sent: string | undefined;
    const down = (async (_url: string, init: RequestInit) => {
      sent = headersOf(init)[REQUEST_REF_HEADER];
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createAgentClient('https://agent.test', down);
    const write = await client.request('POST', '/x', {}).catch((e: unknown) => e);
    expect(write).toBeInstanceOf(AgentUnavailable);
    expect((write as AgentUnavailable).reference).toBe(sent);
    expect(isRequestReference(sent)).toBe(true);
    const read = await client.request('GET', '/x').catch((e: unknown) => e);
    expect((read as AgentUnavailable).reference).toBeNull();
  });
});
