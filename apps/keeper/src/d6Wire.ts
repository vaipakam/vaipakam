// apps/keeper/src/d6Wire.ts
//
// The rooted (d6) remittance wire's day-list commitment, mirrored from
// `contracts/src/crosschain/RemitWire.sol` so the keeper can index or prove a
// delivery's chunks. Every rule here is the contract's, restated once:
//
//   - the funded day list is split into chunks of `D6_CHUNK_DAYS` (16), in
//     order, the last chunk holding the remainder;
//   - a chunk's leaf is `keccak256(keccak256(abi.encode(chunkIndex, dayIds)))`
//     (double-hashed, the OpenZeppelin convention, with the index in the
//     preimage so the same days cannot be proven at another position);
//   - the root pairs nodes with COMMUTATIVE keccak (the smaller word first),
//     and an unpaired node is PROMOTED unhashed — so a promoted node
//     contributes no sibling to a proof.
//
// A proof built here is what `MerkleProof.verify` accepts against that root.
// The unit test pins the leaf and root encodings against vectors computed
// independently with `cast`, not against this code.

import { encodeAbiParameters, keccak256, concat, type Hex } from 'viem';

/** `RemitWire.D6_CHUNK_DAYS`. */
export const D6_CHUNK_DAYS = 16;

/** The days of chunk `chunkIndex` of `dayIds`. */
export function d6Chunk(dayIds: readonly bigint[], chunkIndex: number): bigint[] {
  return dayIds.slice(chunkIndex * D6_CHUNK_DAYS, (chunkIndex + 1) * D6_CHUNK_DAYS);
}

/** How many chunks `dayIds` makes. */
export function d6ChunkCount(dayCount: number): number {
  return Math.ceil(dayCount / D6_CHUNK_DAYS);
}

/** The indexed leaf for chunk `chunkIndex` holding `dayIds`. */
export function d6Leaf(chunkIndex: number | bigint, dayIds: readonly bigint[]): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256[]' }], [BigInt(chunkIndex), [...dayIds]]),
  );
  return keccak256(inner);
}

/** Every chunk's leaf, in chunk order. */
export function d6Leaves(dayIds: readonly bigint[]): Hex[] {
  const n = d6ChunkCount(dayIds.length);
  const out: Hex[] = [];
  for (let c = 0; c < n; c++) out.push(d6Leaf(c, d6Chunk(dayIds, c)));
  return out;
}

/** OpenZeppelin `Hashes.commutativeKeccak256`: the smaller word first. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** The root over `leaves` (`RemitWire.d6Root`). Throws on no leaves, as the
 *  contract reverts. */
export function d6Root(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) throw new Error('d6Root: no leaves');
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** The proof for leaf `index`: the sibling at each level, none where the
 *  node was promoted unpaired. */
export function d6Proof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error(`d6Proof: index ${index} out of range`);
  const proof: Hex[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(j + 1 < level.length ? hashPair(level[j], level[j + 1]) : level[j]);
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

/** OpenZeppelin `MerkleProof.processProof` — for self-checks before sending. */
export function d6VerifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
