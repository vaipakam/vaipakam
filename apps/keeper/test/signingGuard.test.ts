// apps/keeper/test/signingGuard.test.ts
//
// #3543 — the check every keeper send passes between preparation and
// signature: the chain id is the configured one, and the RPC-supplied fee
// fields are within the chain's ceilings.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, type Address, type Hex, type WalletClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { chainWeiEntry, feeCeiling, DEFAULT_MAX_FEE_WEI } from '../src/feeCeiling';
import {
  armSigningGuard,
  DEFAULT_GAS_CEILINGS,
  describeAction,
  guardBeforeSigning,
  resetSigningGuard,
  resolveGasCeiling,
  signGuarded,
  signingRefusal,
  SigningRefused,
} from '../src/signingGuard';
import { sendInSubmissionSlot } from '../src/keeperSend';
import { resetSubmissionQueues } from '../src/submissionQueue';
import { armHeldFence } from './helpers/epochFence';
import { PREPARED_FEES_84532 } from './helpers/preparedFees';

const GWEI = 10n ** 9n;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Address;
const KEEPER = '0x00000000000000000000000000000000000000aa' as Address;
const SIGNED: Hex = '0x02f86b0182';

beforeEach(() => {
  resetSigningGuard();
  resetSubmissionQueues();
  armHeldFence();
});
afterEach(() => resetSigningGuard());

describe('chainWeiEntry (shared with the #2627 fee ceilings)', () => {
  it('reads the chain entry, then *, then nothing', () => {
    expect(chainWeiEntry('84532=5,*=9', 84532, 'X')).toEqual({ wei: 5n, from: "X, this chain's entry" });
    expect(chainWeiEntry('84532=5,*=9', 97, 'X')).toEqual({ wei: 9n, from: 'X, its * entry' });
    expect(chainWeiEntry('84532=5', 97, 'X')).toEqual({ none: true });
    expect(chainWeiEntry(' ', 97, 'X')).toEqual({ none: true });
  });

  it('refuses malformed text and a chain named twice', () => {
    expect(chainWeiEntry('84532=5gwei', 84532, 'X')).toHaveProperty('unread');
    expect(chainWeiEntry('84532=5,084532=6', 84532, 'X')).toHaveProperty('unread');
  });

  it('leaves the fee ceiling it was factored out of unchanged', () => {
    expect(feeCeiling(undefined, 1, 'F')).toEqual({ wei: DEFAULT_MAX_FEE_WEI, from: 'the default, F being unset' });
    expect(feeCeiling('2=1', 1, 'F')).toEqual({ wei: DEFAULT_MAX_FEE_WEI, from: 'the default, F naming neither this chain nor *' });
    expect(feeCeiling('1=7', 1, 'F')).toEqual({ wei: 7n, from: "F, this chain's entry" });
    expect(feeCeiling('1=x', 1, 'F')).toHaveProperty('unread');
  });
});

describe('resolveGasCeiling', () => {
  it('uses the built-in figures when no variable names the chain', () => {
    const r = resolveGasCeiling({}, 84532);
    expect(r).toEqual({
      ceiling: DEFAULT_GAS_CEILINGS.get(84532),
      from: {
        maxFeePerGasWei: 'the built-in figure for chain 84532',
        maxPriorityFeePerGasWei: 'the built-in figure for chain 84532',
        maxTxFeeWei: 'the built-in figure for chain 84532',
      },
    });
  });

  it('takes each variable separately, per chain or through *', () => {
    const r = resolveGasCeiling({ GAS_MAX_FEE_PER_GAS_WEI: `84532=${50n * GWEI}`, GAS_MAX_TX_FEE_WEI: '*=1' }, 84532);
    if (!('ceiling' in r)) throw new Error('unread');
    expect(r.ceiling.maxFeePerGasWei).toBe(50n * GWEI);
    expect(r.ceiling.maxPriorityFeePerGasWei).toBe(DEFAULT_GAS_CEILINGS.get(84532)!.maxPriorityFeePerGasWei);
    expect(r.ceiling.maxTxFeeWei).toBe(1n);
    expect(r.from.maxTxFeeWei).toBe('GAS_MAX_TX_FEE_WEI, its * entry');
  });

  it('cannot be read when a variable is malformed, or a chain has no figure at all', () => {
    expect(resolveGasCeiling({ GAS_MAX_PRIORITY_FEE_PER_GAS_WEI: 'lots' }, 84532)).toHaveProperty('unread');
    expect(resolveGasCeiling({}, 999_999)).toEqual({
      unread: 'chain 999999 has no built-in gas ceiling and GAS_MAX_FEE_PER_GAS_WEI names neither it nor *',
    });
    // A * entry for every variable covers a chain with no built-in figure.
    expect(
      resolveGasCeiling({ GAS_MAX_FEE_PER_GAS_WEI: '*=1', GAS_MAX_PRIORITY_FEE_PER_GAS_WEI: '*=1', GAS_MAX_TX_FEE_WEI: '*=1' }, 999_999),
    ).toHaveProperty('ceiling');
  });
});

describe('signingRefusal', () => {
  const ok = { ...PREPARED_FEES_84532 };
  const base = resolveGasCeiling({}, 84532);

  it('passes an ordinary send', () => {
    expect(signingRefusal(ok, 84532, base)).toBeNull();
  });

  it('refuses a request for another chain, or one with no chain id', () => {
    expect(signingRefusal({ ...ok, chainId: 1 }, 84532, base)).toMatch(/for chain 1, not the configured chain 84532/);
    expect(signingRefusal({ ...ok, chainId: undefined }, 84532, base)).toMatch(/for chain undefined/);
  });

  it('refuses when the ceiling cannot be read', () => {
    expect(signingRefusal(ok, 84532, { unread: 'X is malformed' })).toBe('its gas ceiling cannot be read: X is malformed');
  });

  it('refuses a request whose cost cannot be bounded', () => {
    expect(signingRefusal({ ...ok, gas: undefined }, 84532, base)).toMatch(/cannot be bounded/);
    expect(signingRefusal({ ...ok, maxFeePerGas: undefined }, 84532, base)).toMatch(/cannot be bounded/);
    expect(signingRefusal({ ...ok, maxPriorityFeePerGas: undefined }, 84532, base)).toMatch(/no priority fee/);
  });

  it('refuses a fee per gas or a tip above its ceiling, and passes one at it', () => {
    expect(signingRefusal({ ...ok, maxFeePerGas: 20n * GWEI, gas: 21_000n }, 84532, base)).toBeNull();
    expect(signingRefusal({ ...ok, maxFeePerGas: 20n * GWEI + 1n, gas: 21_000n }, 84532, base)).toMatch(
      /max fee per gas 20\.000000001 gwei is above the ceiling 20 gwei \(the built-in figure for chain 84532\)/,
    );
    expect(signingRefusal({ ...ok, maxPriorityFeePerGas: 3n * GWEI }, 84532, base)).toMatch(/priority fee 3 gwei is above the ceiling 2 gwei/);
  });

  it('bounds an inflated gas limit through the per-send cost', () => {
    // 1 gwei is well inside the per-gas ceiling; 20M gas makes it 0.02 ETH.
    expect(signingRefusal({ ...ok, gas: 20_000_000n }, 84532, base)).toMatch(/the most its fee can cost, 20000000000000000 wei/);
  });

  it('holds a legacy gas price to the fee ceiling and skips the tip', () => {
    const legacy = { chainId: 97, gas: 300_000n, gasPrice: 3n * GWEI };
    const bnb = resolveGasCeiling({}, 97);
    expect(signingRefusal(legacy, 97, bnb)).toBeNull();
    expect(signingRefusal({ ...legacy, gasPrice: 31n * GWEI }, 97, bnb)).toMatch(/^gas price 31 gwei is above/);
  });
});

describe('describeAction', () => {
  it('names the Diamond function and its first argument', () => {
    const data = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'triggerDefault', args: [42n, 0n, []] } as never);
    expect(describeAction({ to: DIAMOND, data })).toBe(`triggerDefault(42, …) on ${DIAMOND}`);
  });

  it('falls back to the selector for calldata it cannot decode', () => {
    expect(describeAction({ to: DIAMOND, data: '0xdeadbeef00' })).toBe(`selector 0xdeadbeef on ${DIAMOND}`);
    expect(describeAction({ to: DIAMOND })).toBe(`a call to ${DIAMOND}`);
  });
});

describe('guardBeforeSigning', () => {
  it('returns the request with the configured chain id', () => {
    expect(guardBeforeSigning(84532, { ...PREPARED_FEES_84532, to: DIAMOND })).toEqual({ ...PREPARED_FEES_84532, to: DIAMOND, chainId: 84532 });
  });

  it('throws SigningRefused and reports the held send once', async () => {
    const held: [number, string][] = [];
    armSigningGuard({}, { held: async (chainId, line) => void held.push([chainId, line]) });
    expect(() => guardBeforeSigning(84532, { ...PREPARED_FEES_84532, maxFeePerGas: 500n * GWEI, to: DIAMOND, data: '0xdeadbeef' })).toThrow(
      SigningRefused,
    );
    await Promise.resolve();
    expect(held).toHaveLength(1);
    expect(held[0]![0]).toBe(84532);
    expect(held[0]![1]).toMatch(/^held selector 0xdeadbeef on 0x0+d1: max fee per gas 500 gwei is above the ceiling 20 gwei .*Nothing was signed\.$/);
  });

  it('posts one alert per chain while one is still being posted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held: number[] = [];
    armSigningGuard({}, { held: async (chainId) => { held.push(chainId); await gate; } });
    const over = { ...PREPARED_FEES_84532, maxFeePerGas: 500n * GWEI, to: DIAMOND };
    for (let i = 0; i < 3; i++) expect(() => guardBeforeSigning(84532, over)).toThrow(SigningRefused);
    expect(() => guardBeforeSigning(97, { ...over, chainId: 97, maxFeePerGas: 500n * GWEI })).toThrow(SigningRefused);
    expect(held).toEqual([84532, 97]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    // Posted: the next refusal may alert again; the hook's own interval decides.
    expect(() => guardBeforeSigning(84532, over)).toThrow(SigningRefused);
    expect(held).toEqual([84532, 97, 84532]);
  });

  it('refuses a signer that is not a local key, before any signature', async () => {
    await expect(signGuarded(84532, { address: KEEPER, type: 'json-rpc' }, PREPARED_FEES_84532)).rejects.toThrow(/not a local key/);
  });

  it('reads the armed variables', () => {
    armSigningGuard({ GAS_MAX_FEE_PER_GAS_WEI: `84532=${600n * GWEI}`, GAS_MAX_TX_FEE_WEI: '84532=10000000000000000000' }, null);
    expect(guardBeforeSigning(84532, { ...PREPARED_FEES_84532, maxFeePerGas: 500n * GWEI })).toHaveProperty('chainId', 84532);
  });
});

describe('a held send through the submission slot', () => {
  function wallet(fees: () => object) {
    const nonces: number[] = [];
    const signed: object[] = [];
    const w = {
      account: {
        address: KEEPER,
        type: 'local',
        signTransaction: async (req: object) => {
          signed.push(req);
          return SIGNED;
        },
      },
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_getTransactionCount') return '0x0';
        throw new Error(`unexpected request ${method}`);
      },
      prepareTransactionRequest: async (args: { nonce: number }) => {
        nonces.push(args.nonce);
        return { ...args, ...fees() };
      },
      sendRawTransaction: async () => keccak256(SIGNED),
    } as unknown as WalletClient;
    return { w, nonces, signed };
  }

  it('is never signed, and the next send takes the same nonce', async () => {
    let inflated = true;
    const h = wallet(() => (inflated ? { ...PREPARED_FEES_84532, maxFeePerGas: 1_000n * GWEI } : PREPARED_FEES_84532));
    await expect(sendInSubmissionSlot(h.w, 84532, Number.MAX_SAFE_INTEGER, DIAMOND, '0x01')).rejects.toBeInstanceOf(SigningRefused);
    expect(h.signed).toHaveLength(0);
    inflated = false;
    await expect(sendInSubmissionSlot(h.w, 84532, Number.MAX_SAFE_INTEGER, DIAMOND, '0x01')).resolves.toEqual({
      kind: 'submitted',
      tx: keccak256(SIGNED),
    });
    expect(h.nonces).toEqual([0, 0]);
    expect(h.signed).toHaveLength(1);
  });

  it('signs over the configured chain id, never one the RPC reported', async () => {
    const h = wallet(() => ({ ...PREPARED_FEES_84532, chainId: 1 }));
    await expect(sendInSubmissionSlot(h.w, 84532, Number.MAX_SAFE_INTEGER, DIAMOND, '0x01')).rejects.toThrow(/for chain 1, not the configured chain 84532/);
    expect(h.signed).toHaveLength(0);
  });
});
