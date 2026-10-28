import { describe, expect, it } from 'vitest';
import {
  RPC_PROXY_CHAINS,
  RPC_PROXY_MAX_LOG_ADDRESSES,
  RPC_PROXY_MAX_LOG_RANGE_BLOCKS,
  RPC_PROXY_METHODS,
  checkRpcCall,
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
});
