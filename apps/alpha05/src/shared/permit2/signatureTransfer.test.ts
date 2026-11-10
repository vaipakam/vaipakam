import { describe, expect, it } from 'vitest';
import { hashTypedData, type PublicClient } from 'viem';
import { PERMIT2 } from '../approvals/approvals';
import { PERMIT_TRANSFER_TYPES, permitCovers, permitDomain, permitMessage, readPermitRoute, unusedNonce } from './signatureTransfer';

const ME = '0x00000000000000000000000000000000000000e1' as const;
const TOKEN = '0x00000000000000000000000000000000000000a1' as const;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;

describe('the signed transfer', () => {
  it('is Permit2’s PermitTransferFrom, with the protocol as the spender', () => {
    const permit = { permitted: { token: TOKEN, amount: 5n }, nonce: 1n, deadline: 2n };
    expect(permitDomain(84532)).toEqual({ name: 'Permit2', chainId: 84532, verifyingContract: PERMIT2 });
    expect(permitMessage(permit, DIAMOND)).toEqual({ permitted: { token: TOKEN, amount: 5n }, spender: DIAMOND, nonce: 1n, deadline: 2n });
    // The typed data hashes: every field is named and typed as Permit2 has it.
    expect(() =>
      hashTypedData({ domain: permitDomain(84532), types: PERMIT_TRANSFER_TYPES, primaryType: 'PermitTransferFrom', message: permitMessage(permit, DIAMOND) }),
    ).not.toThrow();
  });
  it('is open only where Permit2 is deployed and the wallet’s approval for it covers the amount', () => {
    expect(permitCovers({ deployed: false, allowance: null }, 1n)).toBe(false);
    expect(permitCovers({ deployed: true, allowance: null }, 1n)).toBeNull();
    expect(permitCovers({ deployed: true, allowance: 1n }, 1n)).toBe(true);
    expect(permitCovers({ deployed: true, allowance: 0n }, 1n)).toBe(false);
  });
});

function client(code: string | undefined, allowance: bigint | 'fails', bitmap = 0n): PublicClient {
  return {
    getCode: async () => code,
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'allowance') {
        if (allowance === 'fails') throw new Error('no answer');
        expect(args).toEqual([ME, PERMIT2]);
        return allowance;
      }
      if (functionName === 'nonceBitmap') return bitmap;
      throw new Error(functionName);
    },
  } as unknown as PublicClient;
}

describe('reading the route', () => {
  it('reads the wallet’s approval for Permit2 only where Permit2 is deployed', async () => {
    expect(await readPermitRoute(client('0x', 5n), ME, TOKEN, 1n)).toEqual({ deployed: false, allowance: null });
    expect(await readPermitRoute(client('0x60', 5n), ME, TOKEN, 1n)).toEqual({ deployed: true, allowance: 5n });
    expect(await readPermitRoute(client('0x60', 'fails'), ME, TOKEN, 1n)).toEqual({ deployed: true, allowance: null });
  });
  it('never picks a nonce Permit2 has burned', async () => {
    const zeros = (b: Uint8Array) => b.fill(0);
    expect(await unusedNonce(client('0x60', 0n, 0n), ME, zeros)).toBe(0n);
    await expect(unusedNonce(client('0x60', 0n, 1n), ME, zeros)).rejects.toThrow();
  });
});
