import { describe, expect, it } from 'vitest';
import { hashStruct, hashTypedData, type Hex } from 'viem';
import { SIGNED_OFFER_FIELDS } from './signedOfferWire.mjs';
import {
  ALONE,
  MAX_SIGNED_OFFER_SET,
  SIGNED_OFFER_SET_TYPES,
  placementProblem,
  placementsOf,
  signedDigest,
  signedStructHash,
} from './signedOfferSet';

const domain = {
  name: 'Vaipakam SignedOffer',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x63816B149266C9dBFB7683dfd02D851915238049',
} as const;

/** A typed message for every field, varied by `seed`. */
function offer(seed: number) {
  const m: Record<string, unknown> = {};
  for (const f of SIGNED_OFFER_FIELDS) {
    if (f.type === 'address') m[f.name] = '0x000000000000000000000000000000000000beef';
    else if (f.type === 'bool') m[f.name] = false;
    else if (f.type === 'bytes32') m[f.name] = `0x${seed.toString(16).padStart(64, '0')}`;
    else if (f.type === 'uint256') m[f.name] = BigInt(seed);
    else m[f.name] = 1;
  }
  m.durationDays = BigInt(30 * seed);
  return m;
}

describe('signed offer sets', () => {
  const offers = [offer(1), offer(2), offer(3)];
  const hashes = offers.map((o) => hashStruct({ data: o, primaryType: 'SignedOffer', types: { SignedOffer: SIGNED_OFFER_FIELDS } }));
  const walletDigest = hashTypedData({ domain, types: SIGNED_OFFER_SET_TYPES, primaryType: 'SignedOfferSet', message: { offers } });

  it('rebuilds the digest a wallet signs over the typed list, from any offer', () => {
    placementsOf(hashes).forEach((p, i) => expect(signedDigest(hashes[i], p, domain)).toBe(walletDigest));
  });

  it('a wrong position or a missing offer does not rebuild it', () => {
    expect(signedDigest(hashes[0], { others: [hashes[1], hashes[2]], index: 1 }, domain)).not.toBe(walletDigest);
    expect(signedDigest(hashes[0], { others: [hashes[1]], index: 0 }, domain)).not.toBe(walletDigest);
  });

  it('an offer signed alone signs its own struct hash', () => {
    expect(signedStructHash(hashes[0], ALONE)).toBe(hashes[0]);
    expect(signedStructHash(hashes[0], null)).toBe(hashes[0]);
  });

  it('refuses malformed placements', () => {
    const h = hashes[0] as Hex;
    expect(placementProblem({ others: [h], index: 1 })).toBeNull();
    expect(placementProblem(null)).toBe('set-not-object');
    expect(placementProblem({ others: [], index: 0 })).toBe('set-size');
    expect(placementProblem({ others: Array(MAX_SIGNED_OFFER_SET).fill(h), index: 0 })).toBe('set-size');
    expect(placementProblem({ others: [h.toUpperCase().replace('0X', '0x')], index: 0 })).toBe('set-hash');
    expect(placementProblem({ others: [h], index: 2 })).toBe('set-index');
    expect(placementProblem({ others: [h], index: 0.5 })).toBe('set-index');
  });
});
