// Unit tests for the page-read ledger the sanctions-banner drive judges by.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, multicall3Abi } from 'viem';
import { createReadLedger, watchedRead } from './pageSanctionsReads.mjs';

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
