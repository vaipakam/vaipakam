import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem';

import {
  QUERY_PROBE_BINDING,
  QUERY_PROBE_VERSION,
  classifyQueryError,
  createQueryProbe,
  errorFromChain,
  judgeQueryProbe,
} from './queryProbe.mjs';
import {
  QUERY_PROBE_BINDING as APP_BINDING,
  QUERY_PROBE_VERSION as APP_VERSION,
  attachQueryStateProbe,
  queryProbeErrorChain,
} from '../../src/lib/queryStateProbe.ts';

/**
 * #1672 — the drive's reading of the app's query-state report. The app
 * half is imported, not copied, so the two cannot drift: the parity cases
 * below run the app's own subscription into this file's judge.
 */

const rpcError = (code, message, data) =>
  new RpcRequestError({
    body: { method: 'eth_call' },
    error: { code, message, ...(data ? { data } : {}) },
    url: 'https://rpc.example/v2/SECRETKEY0123456789abcdef',
  });

describe('the report contract', () => {
  it('is the one the app writes', () => {
    expect(QUERY_PROBE_BINDING).toBe(APP_BINDING);
    expect(QUERY_PROBE_VERSION).toBe(APP_VERSION);
  });
});

describe('classifyQueryError, over the chain the app sends', () => {
  const chainOf = (err) => queryProbeErrorChain(err);
  it('reads a dead endpoint as unserved', () => {
    const http = new HttpRequestError({ url: 'https://rpc.example/KEY', status: 503 });
    expect(classifyQueryError(chainOf(http))).toBe('unreachable');
    expect(classifyQueryError(chainOf(new TimeoutError({ body: {}, url: 'https://rpc.example' })))).toBe(
      'unreachable',
    );
  });

  it('reads a rate limit as unserved', () => {
    expect(classifyQueryError(chainOf(new LimitExceededRpcError(rpcError(-32005, 'limit'))))).toBe(
      'unreachable',
    );
  });

  it('reads a malformed request as a fault of the page', () => {
    expect(classifyQueryError(chainOf(new InvalidParamsRpcError(rpcError(-32602, 'bad params'))))).toBe(
      'client-fault',
    );
  });

  it('reads a revert as the chain answering', () => {
    expect(classifyQueryError(chainOf(rpcError(3, 'execution reverted', '0x08c379a0')))).toBe('answered');
    // A -32000-labelled revert keeps its bytes, which is what decides it.
    expect(classifyQueryError(chainOf(rpcError(-32000, 'execution reverted', '0xdeadbeef')))).toBe(
      'answered',
    );
  });

  it('reads an error it does not recognise as unserved, the loud direction', () => {
    expect(classifyQueryError(chainOf(new Error('indexer 502')))).toBe('unreachable');
    expect(classifyQueryError([])).toBe('unreachable');
    expect(classifyQueryError(undefined)).toBe('unreachable');
  });

  it('reads a cancellation as the app calling the read off', () => {
    expect(classifyQueryError([{ name: 'CancelledError' }])).toBe('cancelled');
  });
});

describe('errorFromChain', () => {
  it('rebuilds the chain with viem-shaped walk', () => {
    const e = errorFromChain([{ name: 'Outer' }, { name: 'Inner', code: 3 }]);
    expect(e.cause.name).toBe('Inner');
    expect(e.walk((x) => typeof x.code === 'number').name).toBe('Inner');
    expect(e.walk((x) => x.name === 'none')).toBeNull();
  });
});

describe('judgeQueryProbe', () => {
  it('is unarmed for a page that never reported', () => {
    expect(judgeQueryProbe(undefined)).toMatchObject({ armed: false, unserved: [], faults: [] });
  });

  it('sorts settlements by what they say about the read', () => {
    const p = createQueryProbe();
    p.record(1, { v: 1, kind: 'armed' });
    p.record(1, {
      v: 1,
      kind: 'settled-error',
      queryKey: '["readContract",{"functionName":"getLoanDetails"}]',
      failureCount: 2,
      hadData: true,
      error: [{ name: 'HttpRequestError', message: 'HTTP request failed. https://rpc.example/KEY' }],
    });
    p.record(1, { v: 1, kind: 'settled-error', queryKey: '["q2"]', failureCount: 2, hadData: false, error: [{ code: -32602 }] });
    p.record(1, { v: 1, kind: 'settled-error', queryKey: '["q3"]', failureCount: 1, hadData: false, error: [{ code: 3 }] });
    p.record(1, { v: 1, kind: 'settled-error', queryKey: '["q4"]', failureCount: 1, hadData: false, error: [{ name: 'CancelledError' }] });
    const j = p.of(1);
    expect(j.armed).toBe(true);
    expect(j.unserved).toHaveLength(1);
    expect(j.unserved[0]).toContain('getLoanDetails');
    expect(j.unserved[0]).toContain('after 2 failed attempt(s), over data from an earlier fetch');
    // A URL in the cause is cut, never printed.
    expect(j.unserved[0]).not.toContain('KEY');
    expect(j.unserved[0]).toContain('(url withheld)');
    expect(j.faults).toHaveLength(1);
    expect(j.answered).toHaveLength(1);
    expect(j.cancelled).toBe(1);
    // Pages are kept apart.
    expect(p.of(2)).toMatchObject({ armed: false, unserved: [] });
  });

  it('refuses a report shape it does not read, rather than reading it as clean', () => {
    const p = createQueryProbe();
    p.record(1, { v: 2, kind: 'armed' });
    p.record(1, { v: 1, kind: 'settled-error', queryKey: 7 });
    p.record(1, null);
    const j = p.of(1);
    expect(j.armed).toBe(false);
    expect(j.refused).toHaveLength(3);
    expect(j.refused[0]).toContain('version 2');
  });
});

describe("the app's subscription, read by this drive", () => {
  const wired = () => {
    const probe = createQueryProbe();
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
    attachQueryStateProbe(client, { [QUERY_PROBE_BINDING]: (e) => probe.record(1, e) });
    return { probe, client };
  };

  it('reports an exhausted read as unserved, and a recovered one not at all', async () => {
    const { probe, client } = wired();
    let n = 0;
    await client.fetchQuery({
      queryKey: ['recovered'],
      queryFn: () =>
        ++n === 1
          ? Promise.reject(new HttpRequestError({ url: 'https://rpc.example', status: 429 }))
          : Promise.resolve(1),
    });
    expect(probe.of(1)).toMatchObject({ armed: true, unserved: [] });
    await client
      .fetchQuery({
        queryKey: ['exhausted'],
        queryFn: () => Promise.reject(new HttpRequestError({ url: 'https://rpc.example/KEY', status: 503 })),
      })
      .catch(() => {});
    const j = probe.of(1);
    expect(j.unserved).toHaveLength(1);
    expect(j.unserved[0]).toContain('["exhausted"]');
    expect(j.unserved[0]).toContain('after 2 failed attempt(s)');
    expect(j.unserved[0]).not.toContain('KEY');
  });

  it('reports a revert as answered and a malformed request as a fault', async () => {
    const { probe, client } = wired();
    await client
      .fetchQuery({ queryKey: ['revert'], queryFn: () => Promise.reject(rpcError(3, 'execution reverted', '0x08c379a0')) })
      .catch(() => {});
    await client
      .fetchQuery({
        queryKey: ['bad'],
        queryFn: () => Promise.reject(new InvalidParamsRpcError(rpcError(-32602, 'bad params'))),
      })
      .catch(() => {});
    const j = probe.of(1);
    expect(j.unserved).toEqual([]);
    expect(j.answered).toHaveLength(1);
    expect(j.faults).toHaveLength(1);
  });
});
