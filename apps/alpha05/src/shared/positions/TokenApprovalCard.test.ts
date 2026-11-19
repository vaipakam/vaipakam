import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, pad, toHex, zeroAddress, type Log } from 'viem';
import { approvalCleared } from './TokenApprovalCard';

const NFT = '0x00000000000000000000000000000000000000Cc' as const;
const OWNER = '0x00000000000000000000000000000000000000Aa' as const;
const TOPIC = keccak256(toHex('Approval(address,address,uint256)'));

function approval(to: `0x${string}`, tokenId: bigint, address: `0x${string}` = NFT): Log {
  return {
    address,
    topics: [TOPIC, pad(OWNER), pad(to), pad(toHex(tokenId))],
    data: encodeAbiParameters([], []),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}

describe('approvalCleared', () => {
  it('reads the token’s own Approval clearing this token', () => {
    expect(approvalCleared([approval(zeroAddress, 7n)], NFT, 7n)).toBe(true);
  });
  it('refuses another token, a new approval, or another contract', () => {
    expect(approvalCleared([approval(zeroAddress, 8n)], NFT, 7n)).toBe(false);
    expect(approvalCleared([approval(OWNER, 7n)], NFT, 7n)).toBe(false);
    expect(approvalCleared([approval(zeroAddress, 7n, OWNER)], NFT, 7n)).toBe(false);
  });
});
