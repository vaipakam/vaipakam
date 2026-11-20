import { describe, expect, it } from 'vitest';
import {
  ERC1271_MAGIC,
  awaitAccountSignature,
  gatewayRead,
  isPendingSignature,
  onChainRead,
  safeMessageHash,
  safeMessageUrl,
} from './accountSignature';

const SAFE = '0x00000000000000000000000000000000000000aa' as const;
const HASH = `0x${'11'.repeat(32)}` as const;

describe('a signature an account wallet has not finished approving (#3770, #3836)', () => {
  it('reads an empty signature as a proposal', () => {
    expect(isPendingSignature('0x')).toBe(true);
    expect(isPendingSignature(`0x${'ab'.repeat(65)}`)).toBe(false);
  });

  it('names the gateway record by the Safe message hash', () => {
    expect(safeMessageUrl(84532, SAFE, HASH)).toBe(
      `https://safe-client.safe.global/v1/chains/84532/messages/${safeMessageHash(84532, SAFE, HASH)}`,
    );
  });

  it('takes the on-chain answer as `0x` once the wallet says the hash is signed', async () => {
    expect(await onChainRead(async () => '0xffffffff')()).toEqual({ kind: 'pending' });
    expect(await onChainRead(async () => ERC1271_MAGIC.toUpperCase().replace('0X', '0x'))()).toEqual({ kind: 'valid', signature: '0x' });
  });

  it('takes the gateway record once confirmed, a 404 as not yet, and refuses other failures', async () => {
    const res = (status: number, body: unknown) => async () => ({ status, ok: status < 300, json: async () => body });
    expect(await gatewayRead(res(404, null))()).toEqual({ kind: 'pending' });
    expect(await gatewayRead(res(200, { status: 'NEEDS_CONFIRMATIONS' }))()).toEqual({ kind: 'pending' });
    expect(await gatewayRead(res(200, { status: 'CONFIRMED', preparedSignature: '0xabcd' }))()).toEqual({ kind: 'valid', signature: '0xabcd' });
    await expect(gatewayRead(res(500, null))()).rejects.toThrow();
  });

  it('waits through unread and pending rounds, and stops when the wallet moved', async () => {
    let round = 0;
    const sig = await awaitAccountSignature(
      [
        async () => {
          round += 1;
          if (round === 1) throw new Error('down');
          return round < 3 ? { kind: 'pending' } : { kind: 'valid', signature: '0x' };
        },
      ],
      () => {},
      async () => {},
    );
    expect(sig).toBe('0x');
    await expect(
      awaitAccountSignature([async () => ({ kind: 'pending' })], () => {
        throw new Error('moved');
      }, async () => {}),
    ).rejects.toThrow('moved');
  });
});
