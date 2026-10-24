import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  createPublicClient,
  custom,
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem';

import {
  READ_PROBE_BINDING,
  READ_PROBE_VERSION,
  classifyQueryError,
  classifyRpcRead,
  createReadProbe,
  errorFromChain,
  judgeReadProbe,
} from './readProbe.mjs';
import {
  READ_PROBE_BINDING as APP_BINDING,
  READ_PROBE_VERSION as APP_VERSION,
  attachReadProbe,
  probeTransport,
  readProbeErrorChain,
} from '../../src/lib/readProbe.ts';

/**
 * #1672 — the drive's reading of the app's read report. The app half is
 * imported, not copied, so the two cannot drift: the parity cases below run
 * the app's own transport wrapper and cache subscription into this file's
 * judge.
 */

const rpcError = (code, message, data) =>
  new RpcRequestError({
    body: { method: 'eth_call' },
    error: { code, message, ...(data ? { data } : {}) },
    url: 'https://rpc.example/v2/SECRETKEY0123456789abcdef',
  });

describe('the report contract', () => {
  it('is the one the app writes', () => {
    expect(READ_PROBE_BINDING).toBe(APP_BINDING);
    expect(READ_PROBE_VERSION).toBe(APP_VERSION);
  });
});

describe('classifyQueryError, over the chain the app sends', () => {
  const chainOf = (err) => readProbeErrorChain(err);
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
    expect(classifyQueryError(chainOf(new Error('decode failed')))).toBe('unreachable');
    expect(classifyQueryError([])).toBe('unreachable');
    expect(classifyQueryError(undefined)).toBe('unreachable');
  });

  it('reads a cancellation as the app calling the read off', () => {
    expect(classifyQueryError([{ name: 'CancelledError' }])).toBe('cancelled');
  });
});

describe('classifyRpcRead, which knows the method', () => {
  const chain = readProbeErrorChain(rpcError(3, 'execution reverted', '0x08c379a0'));
  // #2783 r1 — a revert is an EVM answer only from a method that runs EVM
  // code, the rule the wire classifier applies.
  it('reads a revert as an answer only from a method that executes code', () => {
    expect(classifyRpcRead('eth_call', chain)).toBe('answered');
    expect(classifyRpcRead('eth_estimateGas', chain)).toBe('answered');
    expect(classifyRpcRead('eth_blockNumber', chain)).toBe('unreachable');
    expect(classifyRpcRead('eth_getBlockByNumber', chain)).toBe('unreachable');
  });

  it('keeps the other verdicts', () => {
    expect(classifyRpcRead('eth_call', readProbeErrorChain(new InvalidParamsRpcError(rpcError(-32602, 'x'))))).toBe(
      'client-fault',
    );
    expect(classifyRpcRead('eth_call', [])).toBe('unreachable');
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

describe('judgeReadProbe', () => {
  it('is unarmed for a page that never reported', () => {
    expect(judgeReadProbe(undefined)).toMatchObject({ armed: false, unserved: [], pending: [], faults: [] });
  });

  it('sorts RPC outcomes and query settlements by what they say about the read', () => {
    const p = createReadProbe();
    p.record(1, { v: 1, kind: 'armed' });
    const rpc = (seq, method, ok, error) => {
      p.record(1, { v: 1, kind: 'rpc-start', seq, chainId: 84532, method });
      p.record(1, { v: 1, kind: 'rpc-settled', seq, chainId: 84532, method, ok, ...(error ? { error } : {}) });
    };
    rpc(1, 'eth_call', true);
    rpc(2, 'eth_call', false, [{ name: 'HttpRequestError', message: 'HTTP request failed. https://rpc.example/KEY' }]);
    rpc(3, 'eth_call', false, [{ code: 3, data: '0x08c379a0' }]);
    rpc(4, 'eth_blockNumber', false, [{ code: 3, data: '0x08c379a0' }]);
    rpc(5, 'eth_call', false, [{ code: -32602 }]);
    p.record(1, {
      v: 1,
      kind: 'query-settled',
      queryHash: 'h1',
      queryKey: '["loanDetails",7]',
      outcome: 'error',
      failureCount: 2,
      hadData: true,
      error: [{ name: 'AbiDecodingDataSizeTooSmallError' }],
    });
    p.record(1, {
      v: 1,
      kind: 'query-settled',
      queryHash: 'h2',
      queryKey: '["q"]',
      outcome: 'error',
      failureCount: 1,
      hadData: false,
      error: [{ name: 'CancelledError' }],
    });
    const j = p.of(1, { chainId: 84532 });
    expect(j.armed).toBe(true);
    expect(j.unserved).toHaveLength(3);
    expect(j.unserved[0]).toContain('rpc eth_call on chain 84532');
    // A URL in the cause is cut, never printed.
    expect(j.unserved[0]).not.toContain('KEY');
    expect(j.unserved[0]).toContain('(url withheld)');
    expect(j.unserved[1]).toContain('rpc eth_blockNumber');
    expect(j.unserved[2]).toContain('after 2 failed attempt(s), over data from an earlier fetch');
    expect(j.answered).toHaveLength(1);
    expect(j.faults).toHaveLength(1);
    expect(j.cancelled).toBe(1);
    // Pages are kept apart.
    expect(p.of(2)).toMatchObject({ armed: false, unserved: [] });
  });

  it('holds a read still unsettled as pending, not as served', () => {
    const p = createReadProbe();
    p.record(1, { v: 1, kind: 'armed' });
    p.record(1, { v: 1, kind: 'rpc-start', seq: 9, chainId: 84532, method: 'eth_call' });
    p.record(1, { v: 1, kind: 'query-retrying', queryHash: 'h', queryKey: '["k"]', failureCount: 1 });
    const j = p.of(1, { chainId: 84532 });
    expect(j.pending).toHaveLength(2);
    expect(j.unserved).toEqual([]);
    // A retry that was served closes the pending entry.
    p.record(1, { v: 1, kind: 'query-settled', queryHash: 'h', queryKey: '["k"]', outcome: 'ok', failureCount: 1, hadData: false });
    p.record(1, { v: 1, kind: 'rpc-settled', seq: 9, chainId: 84532, method: 'eth_call', ok: true });
    expect(p.of(1, { chainId: 84532 }).pending).toEqual([]);
  });

  it('lists a read on another chain without judging it', () => {
    const p = createReadProbe();
    p.record(1, { v: 1, kind: 'rpc-start', seq: 1, chainId: 1, method: 'eth_call' });
    p.record(1, { v: 1, kind: 'rpc-settled', seq: 1, chainId: 1, method: 'eth_call', ok: false, error: [{ name: 'HttpRequestError' }] });
    const j = p.of(1, { chainId: 84532 });
    expect(j.unserved).toEqual([]);
    expect(j.elsewhere).toHaveLength(1);
  });

  it('refuses a report shape it does not read, rather than reading it as clean', () => {
    const p = createReadProbe();
    p.record(1, { v: 2, kind: 'armed' });
    p.record(1, { v: 1, kind: 'query-settled', queryHash: 'h', queryKey: 7, outcome: 'error' });
    p.record(1, { v: 1, kind: 'rpc-settled', seq: 1, chainId: 84532, method: 'eth_call', ok: false });
    p.record(1, { v: 1, kind: 'settled-error' });
    p.record(1, null);
    const j = p.of(1);
    expect(j.armed).toBe(false);
    expect(j.refused).toHaveLength(5);
    expect(j.refused[0]).toContain('version 2');
  });
});

describe('settle', () => {
  // A fake clock: `sleep` advances it and runs whatever the page reports
  // meanwhile.
  const clocked = (during) => {
    let t = 0;
    const probe = createReadProbe({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        during(t, probe);
      },
    });
    return probe;
  };

  it('waits for the reads unsettled when it was called, and no others', async () => {
    const probe = clocked((t, p) => {
      if (t === 300) p.record(1, { v: 1, kind: 'rpc-settled', seq: 1, chainId: 84532, method: 'eth_call', ok: true });
      // A poll that starts while waiting is not waited for.
      if (t === 100) p.record(1, { v: 1, kind: 'rpc-start', seq: 2, chainId: 84532, method: 'eth_blockNumber' });
    });
    probe.record(1, { v: 1, kind: 'rpc-start', seq: 1, chainId: 84532, method: 'eth_call' });
    await probe.settle(1, { timeoutMs: 5_000 });
    const j = probe.of(1, { chainId: 84532 });
    expect(j.pending).toHaveLength(1);
    expect(j.pending[0]).toContain('eth_blockNumber');
  });

  it('gives up at the deadline and leaves the read pending', async () => {
    let slept = 0;
    const probe = clocked(() => {
      slept += 1;
    });
    probe.record(1, { v: 1, kind: 'query-retrying', queryHash: 'h', queryKey: '["k"]', failureCount: 1 });
    await probe.settle(1, { timeoutMs: 1_000 });
    expect(slept).toBe(10);
    expect(probe.of(1).pending).toHaveLength(1);
  });
});

describe("the app's report, read by this drive", () => {
  const wired = () => {
    const probe = createReadProbe();
    const host = { [READ_PROBE_BINDING]: (e) => probe.record(1, e) };
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
    attachReadProbe(client, host);
    return { probe, client, host };
  };

  // #2783 r1 P1 — the shape the query cache could never report: a hook
  // degrades a failed read into `null` ("unavailable"), which settles the
  // query as a SUCCESS.
  it('reports a read a hook degraded into "unavailable" as unserved', async () => {
    const { probe, client, host } = wired();
    const transport = custom(
      { request: async () => { throw new HttpRequestError({ url: 'https://rpc.example/KEY', status: 503 }); } },
      { retryCount: 0 },
    );
    const chain = createPublicClient({ transport: probeTransport(transport, 84532, host) });
    const data = await client.fetchQuery({
      queryKey: ['myLoans'],
      queryFn: () => chain.getBlockNumber({ cacheTime: 0 }).catch(() => null),
    });
    expect(data).toBeNull();
    const j = probe.of(1, { chainId: 84532 });
    expect(j.unserved).toHaveLength(1);
    expect(j.unserved[0]).toContain('rpc eth_blockNumber');
    expect(j.unserved[0]).not.toContain('KEY');
  });

  it('reports nothing for a read viem retried and served', async () => {
    const { probe, host } = wired();
    let n = 0;
    const transport = custom(
      {
        request: async () => {
          n += 1;
          if (n === 1) throw new HttpRequestError({ url: 'https://rpc.example', status: 429 });
          return '0x5';
        },
      },
      { retryCount: 1, retryDelay: 0 },
    );
    const chain = createPublicClient({ transport: probeTransport(transport, 84532, host) });
    expect(await chain.getBlockNumber({ cacheTime: 0 })).toBe(5n);
    expect(probe.of(1, { chainId: 84532 })).toMatchObject({ armed: true, unserved: [], pending: [] });
  });

  it('reports an exhausted query as unserved, and a recovered one not at all', async () => {
    const { probe, client } = wired();
    let n = 0;
    await client.fetchQuery({
      queryKey: ['recovered'],
      queryFn: () => (++n === 1 ? Promise.reject(new Error('decode')) : Promise.resolve(1)),
    });
    expect(probe.of(1)).toMatchObject({ armed: true, unserved: [], pending: [] });
    await client
      .fetchQuery({ queryKey: ['exhausted'], queryFn: () => Promise.reject(new Error('decode')) })
      .catch(() => {});
    const j = probe.of(1);
    expect(j.unserved).toHaveLength(1);
    expect(j.unserved[0]).toContain('["exhausted"]');
    expect(j.unserved[0]).toContain('after 2 failed attempt(s)');
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
