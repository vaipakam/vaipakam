// Unit tests for the page-read ledger the sanctions-banner drive judges by.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, multicall3Abi } from 'viem';
import { attachLedger, createCallLedger, createReadLedger, isRefusedSocketMethod, watchedRead } from './pageSanctionsReads.mjs';

const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const OTHER = '0x2E4033Ae1200CC14D33E09021C4098d12b54341c';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const IMPOSTOR = '0x648897f2c549956eFfF626D57fBc3E39761e6792';
const WALLET = '0xCeF8D4D9FF706B39baF07Ff9630AE81d632e55dc';
const STRANGER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';

const flagRead = watchedRead('isSanctionedAddress(address)', DIAMOND, WALLET);
const bool = (b) => encodeAbiParameters([{ type: 'bool' }], [b]);
const plain = (id, to, data) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, '0x10'] });
const aggregate = (id, calls, to = MULTICALL) =>
  plain(
    id,
    to,
    encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [calls.map(([target, callData]) => ({ target, allowFailure: true, callData }))],
    }),
  );
const aggregateResult = (results) =>
  encodeFunctionResult({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    result: results.map(([success, returnData]) => ({ success, returnData })),
  });

function ledgerAt(times) {
  let i = 0;
  return createReadLedger({ flag: flagRead }, () => times[Math.min(i++, times.length - 1)]);
}

describe('page sanctions read ledger', () => {
  it('records a plain read and its decoded answer', () => {
    const l = ledgerAt([100]);
    const p = l.onRequest(JSON.stringify(plain(1, DIAMOND, flagRead.calldata)));
    l.onResponse(p, JSON.stringify({ jsonrpc: '2.0', id: 1, result: bool(true) }));
    expect(l.judge('flag', 50, true)).toEqual({ state: 'agrees', value: true });
    expect(l.judge('flag', 50, false)).toEqual({ state: 'disagrees', value: true });
  });

  it('ignores the same call for another wallet or on another contract', () => {
    const l = ledgerAt([100]);
    const other = watchedRead('isSanctionedAddress(address)', DIAMOND, STRANGER).calldata;
    expect(l.onRequest(JSON.stringify([plain(1, DIAMOND, other), plain(2, OTHER, flagRead.calldata)]))).toBeNull();
    expect(l.judge('flag', 0, true)).toEqual({ state: 'none' });
  });

  it('finds the read inside an aggregate3 and decodes that call alone', () => {
    const l = ledgerAt([100]);
    const p = l.onRequest(
      JSON.stringify(aggregate(7, [[OTHER, '0x12345678'], [DIAMOND, flagRead.calldata]])),
    );
    l.onResponse(p, JSON.stringify({ id: 7, result: aggregateResult([[true, bool(true)], [true, bool(false)]]) }));
    expect(l.judge('flag', 0, false).state).toBe('agrees');
  });

  it('a failed call inside the multicall is unanswered', () => {
    const l = ledgerAt([100]);
    const p = l.onRequest(JSON.stringify(aggregate(7, [[DIAMOND, flagRead.calldata]])));
    l.onResponse(p, JSON.stringify({ id: 7, result: aggregateResult([[false, '0x']]) }));
    expect(l.judge('flag', 0, true)).toEqual({ state: 'unanswered', attempts: 1 });
  });

  it('an RPC error, a lost response or one still in flight is unanswered', () => {
    const l = ledgerAt([100, 101, 102]);
    const a = l.onRequest(JSON.stringify(plain(1, DIAMOND, flagRead.calldata)));
    l.onResponse(a, JSON.stringify({ id: 1, error: { code: -32000, message: 'x' } }));
    const b = l.onRequest(JSON.stringify(plain(2, DIAMOND, flagRead.calldata)));
    l.onResponse(b, null);
    l.onRequest(JSON.stringify(plain(3, DIAMOND, flagRead.calldata)));
    expect(l.judge('flag', 0, true)).toEqual({ state: 'unanswered', attempts: 3 });
  });

  it('matches answers to requests by id within a batch', () => {
    const l = ledgerAt([100]);
    const p = l.onRequest(JSON.stringify([plain(1, OTHER, '0x'), plain(2, DIAMOND, flagRead.calldata)]));
    l.onResponse(
      p,
      JSON.stringify([
        { id: 2, result: bool(false) },
        { id: 1, result: bool(true) },
      ]),
    );
    expect(l.judge('flag', 0, false).state).toBe('agrees');
  });

  it('a read started before the window never counts for it, even if answered inside', () => {
    const l = ledgerAt([100, 300]);
    const early = l.onRequest(JSON.stringify(plain(1, DIAMOND, flagRead.calldata)));
    // the window opens at 200; the early read's answer arrives afterwards
    l.onResponse(early, JSON.stringify({ id: 1, result: bool(true) }));
    expect(l.judge('flag', 200, false)).toEqual({ state: 'none' });
    const late = l.onRequest(JSON.stringify(plain(2, DIAMOND, flagRead.calldata)));
    l.onResponse(late, JSON.stringify({ id: 2, result: bool(false) }));
    expect(l.judge('flag', 200, false).state).toBe('agrees');
  });

  it('the latest answered read in the window decides', () => {
    const l = ledgerAt([100, 110]);
    const a = l.onRequest(JSON.stringify(plain(1, DIAMOND, flagRead.calldata)));
    const b = l.onRequest(JSON.stringify(plain(2, DIAMOND, flagRead.calldata)));
    l.onResponse(a, JSON.stringify({ id: 1, result: bool(true) }));
    l.onResponse(b, JSON.stringify({ id: 2, result: bool(false) }));
    expect(l.judge('flag', 0, false).state).toBe('agrees');
  });

  it('with `until`, judges only what had arrived by then', () => {
    // started 100, answered 110 (true); started 200, answered 210 (false)
    const l = ledgerAt([100, 110, 200, 210]);
    const a = l.onRequest(JSON.stringify(plain(1, DIAMOND, flagRead.calldata)));
    l.onResponse(a, JSON.stringify({ id: 1, result: bool(true) }));
    const b = l.onRequest(JSON.stringify(plain(2, DIAMOND, flagRead.calldata)));
    l.onResponse(b, JSON.stringify({ id: 2, result: bool(false) }));
    expect(l.judge('flag', 0, false, 150)).toEqual({ state: 'disagrees', value: true });
    expect(l.judge('flag', 0, false).state).toBe('agrees');
  });

  it('trusts nested calls only inside the canonical Multicall3', () => {
    const l = ledgerAt([100]);
    const body = aggregate(7, [[DIAMOND, flagRead.calldata]], IMPOSTOR);
    expect(l.onRequest(JSON.stringify(body))).toBeNull();
    expect(l.judge('flag', 0, true)).toEqual({ state: 'none' });
  });
});

describe('read-only check on the page\'s WebSockets', () => {
  const READS = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber']);

  /** A fake page that opens one socket and sends `frames` on it. */
  function pageSending(url, frames) {
    const handlers = {};
    const page = { on: (ev, fn) => (handlers[ev] = fn) };
    const l = createReadLedger({});
    const { wsViolations } = attachLedger(page, l, READS);
    const wsHandlers = {};
    handlers.websocket({ url: () => url, on: (ev, fn) => (wsHandlers[ev] = fn) });
    for (const f of frames) wsHandlers.framesent({ payload: JSON.stringify(f) });
    return wsViolations;
  }

  it('refuses every method off the read list, except the WalletConnect relay protocol on its host', () => {
    const NODE = 'wss://rpc.example/ws';
    const RELAY = 'wss://relay.walletconnect.org/?projectId=x';
    expect(isRefusedSocketMethod(NODE, 'eth_sendRawTransaction', READS)).toBe(true);
    expect(isRefusedSocketMethod(NODE, 'anvil_setBalance', READS)).toBe(true);
    expect(isRefusedSocketMethod(NODE, 'evm_mine', READS)).toBe(true);
    expect(isRefusedSocketMethod(NODE, 'irn_publish', READS)).toBe(true); // relay method, not the relay host
    expect(isRefusedSocketMethod(RELAY, 'eth_sendRawTransaction', READS)).toBe(true); // relay host, not the relay method
    expect(isRefusedSocketMethod(NODE, 'eth_call', READS)).toBe(false);
    expect(isRefusedSocketMethod(RELAY, 'irn_publish', READS)).toBe(false);
    expect(isRefusedSocketMethod('wss://relay.walletconnect.com', 'irn_subscribe', READS)).toBe(false);
    expect(isRefusedSocketMethod('wss://relay.walletconnect.org.evil.example', 'irn_publish', READS)).toBe(true);
    expect(isRefusedSocketMethod(NODE, undefined, READS)).toBe(false);
  });

  it('does not count WalletConnect relay traffic (the #2439 live-run false FAIL)', () => {
    const v = pageSending('wss://relay.walletconnect.org/?projectId=x', [
      { id: 1, jsonrpc: '2.0', method: 'irn_subscribe', params: { topic: 't' } },
      { id: 2, jsonrpc: '2.0', method: 'irn_publish', params: { topic: 't', message: 'm' } },
    ]);
    expect(v).toEqual([]);
  });

  it('records a chain write sent on a socket, alone or in a batch', () => {
    const v = pageSending('wss://rpc.example/ws', [
      { id: 1, jsonrpc: '2.0', method: 'eth_call', params: [] },
      [
        { id: 2, jsonrpc: '2.0', method: 'eth_chainId' },
        { id: 3, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: ['0x00'] },
      ],
    ]);
    expect(v).toEqual([
      { reason: 'websocket rpc eth_sendRawTransaction (not a permitted read)', url: 'wss://rpc.example/ws' },
    ]);
  });
});

describe('createCallLedger', () => {
  const T = '0x00000000000000000000000000000000000000d1';
  const P = '0xabcdef01' + '00'.repeat(31) + '15';
  it('records the page simulations of one call, refused or accepted, from the click on', () => {
    let t = 0;
    const l = createCallLedger(T, P, () => t);
    const pending = l.onRequest(
      JSON.stringify([
        { id: 1, method: 'eth_call', params: [{ to: T.toUpperCase().replace('0X', '0x'), data: P + 'ff' }] },
        { id: 2, method: 'eth_call', params: [{ to: T, data: '0xabcdef01' + '00'.repeat(31) + '16' }] },
        { id: 3, method: 'eth_estimateGas', params: [{ to: T, data: P }] },
      ]),
    );
    expect(l.entries).toHaveLength(1);
    l.onResponse(pending, JSON.stringify([{ id: 1, error: { code: 3, message: 'execution reverted', data: '0x12345678' } }]));
    expect(l.refusedSince(0)).toEqual([expect.objectContaining({ error: 'execution reverted (0x12345678)', tx: expect.objectContaining({ data: P + 'ff' }) })]);
    expect(l.refusedSince(1)).toEqual([]);
    t = 5;
    const ok = l.onRequest(JSON.stringify({ id: 9, method: 'eth_call', params: [{ to: T, data: P }] }));
    l.onResponse(ok, JSON.stringify({ id: 9, result: '0x' }));
    expect(l.entries[1].error).toBeNull();
    expect(l.refusedSince(5)).toEqual([]);
    // A provider failure is not the chain refusing the call.
    const limited = l.onRequest(JSON.stringify({ id: 10, method: 'eth_call', params: [{ to: T, data: P, value: '0x1' }] }));
    l.onResponse(limited, JSON.stringify({ id: 10, error: { code: -32005, message: 'rate limited' } }));
    expect(l.entries[2].tx.value).toBe('0x1');
    expect(l.refusedSince(5)).toEqual([]);
  });
});
