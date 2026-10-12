/**
 * The keeper's mirror of the rooted (d6) wire commitment. The leaf and root
 * encodings are pinned against vectors computed INDEPENDENTLY with `cast`
 * (abi-encode + keccak), never against this module's own output, so a drift
 * from `RemitWire.sol` fails here rather than as a refused proof on chain.
 *
 *   leaf(0, [1,2,3])  = keccak(keccak(abi.encode(0, [1,2,3])))
 *   leaf(1, [17])     = keccak(keccak(abi.encode(1, [17])))
 *   leaf(2, [40,41])  = keccak(keccak(abi.encode(2, [40,41])))
 *   root2 = keccak(sorted(leaf0, leaf1));  root3 = keccak(sorted(root2, leaf2)) (leaf2 promoted)
 */
import { describe, expect, it } from 'vitest';
import {
  D6_CHUNK_DAYS,
  d6Chunk,
  d6ChunkCount,
  d6Leaf,
  d6Leaves,
  d6Proof,
  d6Root,
  d6VerifyProof,
} from '../src/d6Wire';

const LEAF0 = '0x946623f0d05f16d845f2a9f23ebcb0ad35e18c9ba6b80bfd485189d67d73670b';
const LEAF1 = '0xb90bcf7be13cb236a993d45fb386f2091b7dba515f41ddc212e549ed98592bf5';
const LEAF2 = '0xa1778d33a8b3628dad4042e320cbb2ba113d148b7078e9b100b1f536aa2551cc';
const ROOT2 = '0x44887985b57e905135a41706d6454692212d45855152fc2dffdf6583d24c72ab';
const ROOT3 = '0xc08fe34688da0505d48aa26a07940d7d766d39e4538167c8a75e473fcd7d41f6';

describe('d6 wire — encodings pinned to cast vectors', () => {
  it('leaf: double-hashed (index, days)', () => {
    expect(d6Leaf(0, [1n, 2n, 3n])).toBe(LEAF0);
    expect(d6Leaf(1, [17n])).toBe(LEAF1);
    expect(d6Leaf(2, [40n, 41n])).toBe(LEAF2);
  });
  it('root: commutative pairs, an unpaired node promoted', () => {
    expect(d6Root([LEAF0])).toBe(LEAF0);
    expect(d6Root([LEAF0, LEAF1])).toBe(ROOT2);
    expect(d6Root([LEAF0, LEAF1, LEAF2])).toBe(ROOT3);
    expect(() => d6Root([])).toThrow();
  });
  it('every proof verifies against the root, including the promoted leaf', () => {
    const leaves = [LEAF0, LEAF1, LEAF2] as const;
    for (let i = 0; i < leaves.length; i++) {
      expect(d6VerifyProof(d6Proof(leaves, i), ROOT3, leaves[i]), `leaf ${i}`).toBe(true);
    }
    expect(d6Proof(leaves, 2), 'a promoted leaf has no sibling at its first level').toEqual([ROOT2]);
    expect(d6VerifyProof(d6Proof(leaves, 0), ROOT3, LEAF2), 'a proof does not verify another leaf').toBe(false);
  });
});

describe('d6 wire — chunking', () => {
  it('splits into 16-day chunks in order, the last holding the remainder', () => {
    const days = Array.from({ length: 33 }, (_, i) => BigInt(100 + i));
    expect(d6ChunkCount(days.length)).toBe(3);
    expect(d6Chunk(days, 0)).toHaveLength(D6_CHUNK_DAYS);
    expect(d6Chunk(days, 2)).toEqual([132n]);
    const leaves = d6Leaves(days);
    expect(leaves).toHaveLength(3);
    expect(leaves[1]).toBe(d6Leaf(1, days.slice(16, 32)));
  });
});
