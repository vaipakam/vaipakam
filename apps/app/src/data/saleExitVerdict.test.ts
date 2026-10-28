import { describe, expect, it } from 'vitest';
import { encodeErrorResult, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { decodeSaleRefusals, verdictOf } from './saleExitVerdict';

const encode = (errorName: string, args?: readonly unknown[]): Hex =>
  encodeErrorResult({
    abi: DIAMOND_ABI_VIEM,
    errorName,
    args,
  } as Parameters<typeof encodeErrorResult>[0]);

describe('decodeSaleRefusals', () => {
  it('decodes a refusal to the custom error the entry raises', () => {
    expect(decodeSaleRefusals([{ reason: encode('LoanNotActive'), reopensAt: 0n }])).toEqual([
      { error: 'LoanNotActive', args: [], reopensAt: null },
    ]);
  });

  it('keeps the error’s arguments in declaration order', () => {
    const [r] = decodeSaleRefusals([
      { reason: encode('OfferDurationExceedsCap', [400n, 365n]), reopensAt: 0n },
    ]);
    expect(r.error).toBe('OfferDurationExceedsCap');
    expect(r.args).toEqual([400n, 365n]);
  });

  it('carries the contract’s earliest lift time, and none when it names none', () => {
    const [r] = decodeSaleRefusals([
      { reason: encode('SaleRelistCooldownActive', [1_800_000_000n]), reopensAt: 1_800_000_000n },
    ]);
    expect(r.reopensAt).toBe(1_800_000_000);
  });

  it('keeps an undecodable reason as a refusal with no name, never drops it', () => {
    expect(decodeSaleRefusals([{ reason: '0xdeadbeef', reopensAt: 0n }])).toEqual([
      { error: null, args: [], reopensAt: null },
    ]);
  });

  it('preserves order, so the first refusal stays the one the entry reverts with', () => {
    const out = decodeSaleRefusals([
      { reason: encode('EnforcedPause'), reopensAt: 0n },
      { reason: encode('LoanNotActive'), reopensAt: 0n },
    ]);
    expect(out.map((r) => r.error)).toEqual(['EnforcedPause', 'LoanNotActive']);
  });
});

describe('verdictOf', () => {
  const data = { direct: [], listing: [] };

  it('is checking until the first answer lands', () => {
    expect(verdictOf({ data: undefined, error: null, isError: false })).toEqual({
      kind: 'checking',
    });
  });

  it('is known once it answers', () => {
    expect(verdictOf({ data, error: null, isError: false })).toEqual({ kind: 'known', ...data });
  });

  it('distrusts a cached answer once the latest fetch failed', () => {
    expect(verdictOf({ data, error: new Error('rpc down'), isError: true })).toEqual({
      kind: 'failed',
    });
  });

  it('reports a Diamond without the selector as unserved, not failed', () => {
    const err = new Error('execution reverted: FunctionDoesNotExist()');
    expect(verdictOf({ data: undefined, error: err, isError: true })).toEqual({
      kind: 'unserved',
    });
  });
});
