/**
 * #3205 / #3321 — the keeper's position-NFT surface. Every chain's
 * deployment record names its PositionNFT; a Diamond no record names is
 * refused rather than read as the NFT.
 */
import { describe, expect, it } from 'vitest';
import { positionNftForDiamond } from '../src/positionNft';

describe('position-NFT surface', () => {
  it('refuses a Diamond no deployment record names', () => {
    const d = '0x00000000000000000000000000000000000000d1';
    expect(() => positionNftForDiamond(d)).toThrow(/no deployment record names Diamond/);
  });
});
