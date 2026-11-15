import { describe, expect, it } from 'vitest';
import {
  RPC_PROXY_CHAINS,
  RPC_PROXY_MAX_LOG_ADDRESSES,
  RPC_PROXY_MAX_LOG_RANGE_BLOCKS,
  RPC_PROXY_MAX_BATCH,
  RPC_PROXY_MAX_FEE_HISTORY_BLOCKS,
  RPC_PROXY_METHODS,
  RPC_PROXY_UNITS_PER_SLOT,
  checkRpcCall,
  rpcCallWeight,
} from './rpcProxyPolicy';

const DIAMOND = '0x' + 'ab'.repeat(20);
const hex = (n: number) => '0x' + n.toString(16);

describe('the read-only RPC proxy policy (#1724)', () => {
  it('serves reads only: no method that sends, signs or subscribes', () => {
    for (const m of RPC_PROXY_METHODS) {
      expect(m).not.toMatch(/send|sign|subscribe|filter|personal_|debug_|trace_|admin_|txpool_/i);
    }
    expect(RPC_PROXY_METHODS.has('eth_sendRawTransaction')).toBe(false);
  });

  it('refuses a method outside the list with -32601', () => {
    expect(checkRpcCall('eth_sendRawTransaction', ['0x00'])).toEqual({
      ok: false,
      code: -32601,
      message: 'method not served by this proxy',
    });
    expect(checkRpcCall('eth_call', [{ to: DIAMOND, data: '0x' }, 'latest'])).toEqual({ ok: true });
  });

  it('gives every chain its own dedicated secret', () => {
    const names = Object.values(RPC_PROXY_CHAINS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^RPC_PROXY_[A-Z_]+$/);
  });

  describe('eth_getLogs', () => {
    const logs = (f: Record<string, unknown>) => checkRpcCall('eth_getLogs', [f]);

    it('accepts a numeric range up to the cap, both ends inclusive', () => {
      expect(logs({ address: DIAMOND, fromBlock: hex(100), toBlock: hex(100 + RPC_PROXY_MAX_LOG_RANGE_BLOCKS - 1) }).ok).toBe(
        true,
      );
      expect(logs({ address: DIAMOND, fromBlock: hex(100), toBlock: hex(100 + RPC_PROXY_MAX_LOG_RANGE_BLOCKS) }).ok).toBe(
        false,
      );
    });

    it('accepts the shape the app sends: one address, hex range, topic0 alternatives', () => {
      expect(
        logs({ address: DIAMOND, fromBlock: '0x10', toBlock: '0x3e7', topics: [['0x' + '11'.repeat(32)]] }).ok,
      ).toBe(true);
    });

    it('accepts a single block hash with no range', () => {
      expect(logs({ address: DIAMOND, blockHash: '0x' + '22'.repeat(32) }).ok).toBe(true);
      expect(logs({ address: DIAMOND, blockHash: '0x' + '22'.repeat(32), fromBlock: '0x1' }).ok).toBe(false);
    });

    it('refuses tags, reversed ranges and a missing range', () => {
      expect(logs({ address: DIAMOND, fromBlock: '0x1', toBlock: 'latest' }).ok).toBe(false);
      expect(logs({ address: DIAMOND, fromBlock: 'earliest', toBlock: '0x1' }).ok).toBe(false);
      expect(logs({ address: DIAMOND, fromBlock: '0x10', toBlock: '0x1' }).ok).toBe(false);
      expect(logs({ address: DIAMOND }).ok).toBe(false);
    });

    it('refuses a filter that names no contract, or too many', () => {
      expect(logs({ fromBlock: '0x1', toBlock: '0x2' }).ok).toBe(false);
      expect(logs({ address: [], fromBlock: '0x1', toBlock: '0x2' }).ok).toBe(false);
      const many = Array.from({ length: RPC_PROXY_MAX_LOG_ADDRESSES + 1 }, () => DIAMOND);
      expect(logs({ address: many, fromBlock: '0x1', toBlock: '0x2' }).ok).toBe(false);
      expect(logs({ address: many.slice(1), fromBlock: '0x1', toBlock: '0x2' }).ok).toBe(true);
    });

    it('refuses a malformed params list', () => {
      expect(checkRpcCall('eth_getLogs', []).ok).toBe(false);
      expect(checkRpcCall('eth_getLogs', [null]).ok).toBe(false);
      expect(checkRpcCall('eth_getLogs', 'x').ok).toBe(false);
    });
  });

  describe('every other method has a stated shape (#1283)', () => {
    const ok = (m: string, p: unknown) => expect(checkRpcCall(m, p), `${m} ${JSON.stringify(p)}`).toEqual({ ok: true });
    const bad = (m: string, p: unknown) => expect(checkRpcCall(m, p).ok, `${m} ${JSON.stringify(p)}`).toBe(false);
    const HASH32 = '0x' + '33'.repeat(32);

    it('covers every served method', () => {
      // A method added to the list without a shape would fall to the
      // no-params rule; this keeps that a decision, not an accident.
      expect([...RPC_PROXY_METHODS].sort()).toEqual(
        [
          'eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice',
          'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs',
          'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
          'eth_maxPriorityFeePerGas',
        ].sort(),
      );
    });

    it('eth_call and eth_estimateGas: a transaction and an optional block, never a state override', () => {
      for (const m of ['eth_call', 'eth_estimateGas']) {
        ok(m, [{ to: DIAMOND, data: '0x1234' }]);
        ok(m, [{ to: DIAMOND, data: '0x' }, 'latest']);
        ok(m, [{ to: DIAMOND }, '0x10']);
        ok(m, [{ to: DIAMOND }, { blockHash: HASH32, requireCanonical: true }]);
        ok(m, [{ to: DIAMOND }, { blockNumber: '0x10' }]);
        bad(m, [{ to: DIAMOND }, 'latest', { [DIAMOND]: { code: '0x00' } }]);
        bad(m, [{ to: DIAMOND }, 'tomorrow']);
        bad(m, [{ to: DIAMOND }, { blockHash: HASH32, blockNumber: '0x1' }]);
        bad(m, [{ to: DIAMOND }, { blockNumber: '0x1', extra: 1 }]);
        bad(m, []);
        bad(m, ['0xdead']);
        bad(m, [[{ to: DIAMOND }]]);
      }
    });

    it('account reads: one address, an optional block, and a slot for storage', () => {
      for (const m of ['eth_getBalance', 'eth_getCode', 'eth_getTransactionCount']) {
        ok(m, [DIAMOND]);
        ok(m, [DIAMOND, 'pending']);
        bad(m, [DIAMOND, 'latest', 'extra']);
        bad(m, ['0x1234', 'latest']);
        bad(m, []);
      }
      ok('eth_getStorageAt', [DIAMOND, '0x0', 'latest']);
      ok('eth_getStorageAt', [DIAMOND, HASH32]);
      bad('eth_getStorageAt', [DIAMOND]);
      bad('eth_getStorageAt', [DIAMOND, '0x' + '1'.repeat(65)]);
    });

    it('block reads: a block and a boolean', () => {
      ok('eth_getBlockByNumber', ['latest', false]);
      ok('eth_getBlockByNumber', ['0x10', true]);
      bad('eth_getBlockByNumber', ['latest']);
      bad('eth_getBlockByNumber', ['0x01', false]);
      bad('eth_getBlockByNumber', ['latest', 'yes']);
      ok('eth_getBlockByHash', [HASH32, false]);
      bad('eth_getBlockByHash', ['latest', false]);
    });

    it('transaction reads: one hash', () => {
      for (const m of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
        ok(m, [HASH32]);
        bad(m, [HASH32, HASH32]);
        bad(m, ['0x12']);
      }
    });

    it('eth_feeHistory: a bounded count, the newest block and a few percentiles', () => {
      ok('eth_feeHistory', ['0x5', 'latest', [25, 50, 75]]);
      ok('eth_feeHistory', [4, 'latest']);
      bad('eth_feeHistory', [hex(RPC_PROXY_MAX_FEE_HISTORY_BLOCKS + 1), 'latest']);
      bad('eth_feeHistory', ['0x0', 'latest']);
      bad('eth_feeHistory', ['0x5', 'latest', Array.from({ length: 11 }, () => 50)]);
      bad('eth_feeHistory', ['0x5', 'latest', [101]]);
    });

    it('the no-param reads take none', () => {
      for (const m of ['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas']) {
        ok(m, []);
        ok(m, undefined);
        bad(m, ['latest']);
        bad(m, {});
      }
    });
  });

  describe('call weights (#1283)', () => {
    it('weights a scan or a full block above a plain read', () => {
      expect(rpcCallWeight('eth_blockNumber', [])).toBe(1);
      expect(rpcCallWeight('eth_call', [{ to: DIAMOND }])).toBe(2);
      expect(rpcCallWeight('eth_estimateGas', [{ to: DIAMOND }])).toBe(3);
      expect(rpcCallWeight('eth_getLogs', [{}])).toBe(10);
      expect(rpcCallWeight('eth_getBlockByNumber', ['latest', false])).toBe(1);
      expect(rpcCallWeight('eth_getBlockByNumber', ['latest', true])).toBe(5);
    });

    it('charges the widest batch twenty slots', () => {
      expect(Math.ceil((RPC_PROXY_MAX_BATCH * rpcCallWeight('eth_getLogs', [{}])) / RPC_PROXY_UNITS_PER_SLOT)).toBe(20);
    });
  });
});
