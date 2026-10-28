/**
 * #2437 — the contract figures on /analytics: one block, stated; nothing
 * unread becomes zero; the chain's own "no token" is not a failed read.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, getAddress, stringToHex, type Address, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  numeraireFrom,
  readOnChainTransparency,
  transparencyReads,
  treasuryFeesOf,
  treasuryOf,
  vpfiTokenOf,
} from './onChainTransparency';

const DIAMOND: Address = '0x00000000000000000000000000000000000000d1';
const TOKEN: Address = '0x00000000000000000000000000000000000000a1';
const MINTER: Address = '0x00000000000000000000000000000000000000b2';
const EXTERNAL: Address = '0x00000000000000000000000000000000000000c3';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const E18 = 10n ** 18n;

const ok = (result: unknown) => ({ status: 'success' as const, result });
const fail = { status: 'failure' as const, error: new Error('reverted') };

describe('vpfiTokenOf', () => {
  it('reads the canonical snapshot with its cap, headroom and minter', () => {
    expect(vpfiTokenOf(ok([TOKEN, true, 40n * E18, 100n * E18, 60n * E18, MINTER]))).toEqual({
      kind: 'canonical',
      token: getAddress(TOKEN),
      totalSupply: 40n * E18,
      cap: 100n * E18,
      headroom: 60n * E18,
      minter: getAddress(MINTER),
    });
  });

  it('states no minter as none, not as the zero address', () => {
    const v = vpfiTokenOf(ok([TOKEN, true, 1n, 2n, 1n, ZERO]));
    expect(v.kind === 'canonical' && v.minter).toBeNull();
  });

  it('on a mirror chain carries the supply only — no zero cap or minter', () => {
    const v = vpfiTokenOf(ok([TOKEN, false, 7n, 0n, 0n, ZERO]));
    expect(v).toEqual({ kind: 'mirror', token: getAddress(TOKEN), totalSupply: 7n });
    expect(v).not.toHaveProperty('cap');
  });

  it("keeps the chain's own 'no token' apart from a failed read", () => {
    expect(vpfiTokenOf(ok([ZERO, true, 0n, 0n, 0n, ZERO]))).toEqual({ kind: 'unbound' });
    expect(vpfiTokenOf(fail)).toEqual({ kind: 'unread' });
  });

  it('refuses an answer that is not the view\'s (headroom ≠ cap − supply, bad shape)', () => {
    expect(vpfiTokenOf(ok([TOKEN, true, 40n, 100n, 59n, MINTER]))).toEqual({ kind: 'unread' });
    expect(vpfiTokenOf(ok([TOKEN, 'yes', 1n]))).toEqual({ kind: 'unread' });
    expect(vpfiTokenOf(ok('0x'))).toEqual({ kind: 'unread' });
  });
});

describe('treasuryFeesOf / treasuryOf / numeraireFrom', () => {
  it('reads the four metrics in the view\'s order', () => {
    expect(treasuryFeesOf(ok([5n, 4n, 3n, 2n]))).toEqual({ kind: 'read', held: 5n, total: 4n, last24h: 3n, last7d: 2n });
  });

  it('a failed or malformed metrics read is unread, never zeros', () => {
    expect(treasuryFeesOf(fail)).toEqual({ kind: 'unread' });
    expect(treasuryFeesOf(ok([1n, 2n, 3n]))).toEqual({ kind: 'unread' });
  });

  it('tells the Diamond-as-treasury, an external treasury, an unset one and a failed read apart', () => {
    expect(treasuryOf(ok(DIAMOND), DIAMOND)).toEqual({ kind: 'diamond', address: getAddress(DIAMOND) });
    expect(treasuryOf(ok(EXTERNAL), DIAMOND)).toEqual({ kind: 'external', address: getAddress(EXTERNAL) });
    expect(treasuryOf(ok(ZERO), DIAMOND)).toEqual({ kind: 'unset' });
    expect(treasuryOf(fail, DIAMOND)).toEqual({ kind: 'unread' });
  });

  it('names the reference currency, and a failed read as none', () => {
    expect(numeraireFrom(ok(stringToHex('eur', { size: 32 })))).toEqual({ symbol: 'EUR', isDefault: false });
    expect(numeraireFrom(fail)).toBeNull();
  });
});

describe('readOnChainTransparency', () => {
  const MC3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const encode = (functionName: string, result: unknown) =>
    encodeFunctionResult({ abi: DIAMOND_ABI_VIEM, functionName, result } as never);

  it('fixes the block FIRST and reads every view at it, in one aggregate', async () => {
    const readContract = vi.fn(async () => [
      { success: true, returnData: encode('getVPFISnapshot', [TOKEN, false, 9n, 0n, 0n, ZERO]) },
      { success: true, returnData: encode('getTreasuryMetrics', [0n, 10n * E18, E18, 2n * E18]) },
      { success: true, returnData: encode('getTreasury', EXTERNAL) },
      { success: false, returnData: '0x' },
    ]);
    const getBlock = vi.fn(async () => ({ number: 777n, timestamp: 1_800_000_000n }));
    const client = {
      chain: { id: 84532, contracts: { multicall3: { address: MC3 } } },
      readContract,
      getBlock,
    } as unknown as PublicClient;

    const out = await readOnChainTransparency(client, DIAMOND);

    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
    expect(readContract).toHaveBeenCalledTimes(1);
    const call = (readContract.mock.calls[0] as unknown[])[0] as { blockNumber?: bigint; address: Address };
    expect(call.blockNumber).toBe(777n);
    expect(call.address).toBe(MC3);
    expect(out.blockNumber).toBe(777n);
    expect(out.blockTimestamp).toBe(1_800_000_000);
    expect(out.vpfi).toEqual({ kind: 'mirror', token: getAddress(TOKEN), totalSupply: 9n });
    expect(out.fees).toEqual({ kind: 'read', held: 0n, total: 10n * E18, last24h: E18, last7d: 2n * E18 });
    expect(out.treasury).toEqual({ kind: 'external', address: getAddress(EXTERNAL) });
    // The one view that failed is carried as unread, not as the default.
    expect(out.numeraire).toBeNull();
  });

  it('rejects when the chain could not be reached, rather than reporting unread views', async () => {
    const client = {
      chain: { id: 84532, contracts: { multicall3: { address: MC3 } } },
      readContract: vi.fn(),
      getBlock: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    } as unknown as PublicClient;
    await expect(readOnChainTransparency(client, DIAMOND)).rejects.toThrow('fetch failed');
  });

  it('reads the four named views, nothing else', () => {
    expect(transparencyReads(DIAMOND).map((r) => r.functionName)).toEqual([
      'getVPFISnapshot',
      'getTreasuryMetrics',
      'getTreasury',
      'getNumeraireSymbol',
    ]);
  });
});
