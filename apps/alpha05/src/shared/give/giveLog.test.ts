import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, toHex, type Log } from 'viem';
import { giftTransferred } from './giveLog';

const NFT = '0x00000000000000000000000000000000000000a1' as const;
const OTHER = '0x00000000000000000000000000000000000000b2' as const;
const GIVER = '0x00000000000000000000000000000000000000c3' as const;
const RECEIVER = '0x00000000000000000000000000000000000000d4' as const;
const NEXT = '0x00000000000000000000000000000000000000e5' as const;
const TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const word = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as `0x${string}`]);

function transfer(address: `0x${string}`, from: string, to: string, id: bigint): Log {
  return { address, topics: [TOPIC, word(from), word(to), encodeAbiParameters([{ type: 'uint256' }], [id])], data: '0x' } as unknown as Log;
}

describe('giftTransferred', () => {
  it('finds the gift in its own transfer log', () => {
    expect(giftTransferred([transfer(NFT, GIVER, RECEIVER, 7n)], NFT, GIVER, RECEIVER, 7n)).toBe(true);
  });
  it('still finds it when the receiver passed the token on in the same transaction', () => {
    expect(giftTransferred([transfer(NFT, GIVER, RECEIVER, 7n), transfer(NFT, RECEIVER, NEXT, 7n)], NFT, GIVER, RECEIVER, 7n)).toBe(true);
  });
  it('ignores another token, another contract, or another receiver', () => {
    expect(giftTransferred([transfer(NFT, GIVER, RECEIVER, 8n)], NFT, GIVER, RECEIVER, 7n)).toBe(false);
    expect(giftTransferred([transfer(OTHER, GIVER, RECEIVER, 7n)], NFT, GIVER, RECEIVER, 7n)).toBe(false);
    expect(giftTransferred([transfer(NFT, GIVER, NEXT, 7n)], NFT, GIVER, RECEIVER, 7n)).toBe(false);
  });
});
