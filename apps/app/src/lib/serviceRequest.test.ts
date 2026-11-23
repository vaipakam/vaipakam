// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { noteReference, referenceOf, serviceFetch, ServiceUnreachableError } from './serviceRequest';

const REF = /^[0-9A-HJKMNP-TV-Z]{10}$/;

function recorder(answer: (init: RequestInit) => Response | Promise<Response>) {
  const seen: Headers[] = [];
  const impl = (async (_url: string, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers));
    return answer(init);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('serviceFetch (#3922)', () => {
  it('a write sends a fresh reference, and the response reference wins', async () => {
    const { impl, seen } = recorder(() => new Response('{}', { status: 403, headers: { 'x-request-ref': 'ABCDE12345' } }));
    const out = await serviceFetch('https://agent.example/thresholds', { method: 'PUT', headers: { 'content-type': 'application/json' } }, impl);
    expect(seen[0].get('x-request-ref')).toMatch(REF);
    expect(seen[0].get('content-type')).toBe('application/json');
    expect(out.reference).toBe('ABCDE12345');
  });

  it('a write keeps the reference it sent when the response carries none', async () => {
    const { impl, seen } = recorder(() => new Response('{}', { status: 500 }));
    const out = await serviceFetch('https://agent.example/support/ticket', { method: 'POST' }, impl);
    expect(out.reference).toBe(seen[0].get('x-request-ref'));
  });

  it('a read sends no reference, and reads the one the service made', async () => {
    const { impl, seen } = recorder(() => new Response('{}', { status: 404, headers: { 'x-request-ref': 'ZZZZZ00000' } }));
    const out = await serviceFetch('https://indexer.example/offers/1', {}, impl);
    expect(seen[0].has('x-request-ref')).toBe(false);
    expect(out.reference).toBe('ZZZZZ00000');
  });

  it('ignores a malformed response reference', async () => {
    const { impl } = recorder(() => new Response('{}', { status: 404, headers: { 'x-request-ref': '<script>' } }));
    expect((await serviceFetch('https://indexer.example/x', {}, impl)).reference).toBeNull();
  });

  it('a write with no response throws, carrying the reference it sent', async () => {
    let sent: string | null = null;
    const impl = (async (_u: string, init: RequestInit = {}) => {
      sent = new Headers(init.headers).get('x-request-ref');
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await serviceFetch('https://agent.example/thresholds', { method: 'PUT' }, impl).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnreachableError);
    expect(referenceOf(err)).toBe(sent);
    expect(sent).toMatch(REF);
  });

  it('keeps the reference out of browser storage', async () => {
    const { impl } = recorder(() => new Response('{}', { status: 500, headers: { 'x-request-ref': 'ABCDE12345' } }));
    await serviceFetch('https://agent.example/support/ticket', { method: 'POST' }, impl);
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`),
    );
    expect(stored.join('\n')).not.toContain('ABCDE12345');
  });

  it('attaches a reference to an error, and only to objects', () => {
    const e = noteReference(new Error('x'), 'ABCDE12345');
    expect(referenceOf(e)).toBe('ABCDE12345');
    expect(referenceOf(new Error('y'))).toBeNull();
    expect(referenceOf('ABCDE12345')).toBeNull();
    expect(referenceOf(noteReference(new Error('z'), null))).toBeNull();
  });
});
