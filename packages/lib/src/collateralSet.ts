/**
 * #3328 / #3688 — the off-chain statement of a collection offer's collateral
 * set: which NFT token ids a lender's collection offer takes, and the Merkle
 * proof a Listed set needs.
 *
 * The on-chain rule is `LibCollateralSet` (one copy, read by every fill,
 * match and view). This module mirrors it for the readers that must decide
 * BEFORE they pay for a call: the keeper's collection matcher picks the
 * borrower offers worth simulating, and builds the proof a Listed set needs
 * from the ids its lender published. The contract stays the authority: a
 * pair this module admits is still simulated before it is sent.
 *
 * A Listed leaf is the OpenZeppelin standard-tree leaf of one `uint256` id,
 * `keccak256(bytes.concat(keccak256(abi.encode(id))))`, and pairs are hashed
 * in sorted order, as `MerkleProof.verifyCalldata` checks them. The tree is
 * built the way OpenZeppelin's `StandardMerkleTree` builds it, with its
 * leaves sorted (its default) or in the order the list gives them. Which of
 * the two the lender used is read from the root: a proof is offered only
 * for a tree whose root equals the offer's.
 */
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';

/** `LibVaipakam.CollateralSetKind`, in contract order. */
export const CollateralSetKind = {
  None: 0,
  Collection: 1,
  Range: 2,
  Listed: 3,
} as const;

/** `LibCollateralSet.MAX_PROOF_DEPTH`: a longer proof is refused on-chain. */
export const MAX_PROOF_DEPTH = 20;

/** A collection offer's set, as `getCollectionOffer` returns it. */
export interface CollateralSetView {
  kind: number;
  low: bigint;
  high: bigint;
  root: Hex;
  listCount: number;
  exclusions: readonly bigint[];
}

/** `LibCollateralSet.leaf`: the standard-tree leaf of one id. */
export function collateralSetLeaf(tokenId: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'uint256' }], [tokenId])));
}

/** `Hashes.commutativeKeccak256`: the pair hashed in sorted order. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Whether `set` takes `tokenId`, for the kinds that need no proof. An
 * exclusion wins over inclusion. A Listed set answers `null`: membership
 * there is a proof question ({@link listedProof}).
 */
export function setTakesWithoutProof(set: CollateralSetView, tokenId: bigint): boolean | null {
  if (set.kind === CollateralSetKind.None) return false;
  if (set.exclusions.some((x) => x === tokenId)) return false;
  if (set.kind === CollateralSetKind.Collection) return true;
  if (set.kind === CollateralSetKind.Range) return tokenId >= set.low && tokenId <= set.high;
  return null;
}

/** A standard tree over a list of ids: the node array, and each id's leaf
 *  position in it. */
export interface Tree {
  nodes: Hex[];
  leafIndex: Map<bigint, number>;
}

/** OpenZeppelin `StandardMerkleTree` construction: the leaves sit at the end
 *  of the node array, in reverse order, and each inner node hashes its two
 *  children. `sortLeaves` sorts the leaves by hash first, as that library
 *  does by default. */
function buildTree(ids: readonly bigint[], sortLeaves: boolean): Tree {
  const leaves = ids.map((id) => ({ id, hash: collateralSetLeaf(id) }));
  if (sortLeaves) leaves.sort((x, y) => (BigInt(x.hash) < BigInt(y.hash) ? -1 : BigInt(x.hash) > BigInt(y.hash) ? 1 : 0));
  const n = leaves.length;
  const nodes: Hex[] = new Array(2 * n - 1);
  const leafIndex = new Map<bigint, number>();
  leaves.forEach((l, i) => {
    const at = nodes.length - 1 - i;
    nodes[at] = l.hash;
    leafIndex.set(l.id, at);
  });
  for (let i = nodes.length - 1 - n; i >= 0; i--) nodes[i] = hashPair(nodes[2 * i + 1], nodes[2 * i + 2]);
  return { nodes, leafIndex };
}

function proofAt(tree: Tree, index: number): Hex[] {
  const proof: Hex[] = [];
  let i = index;
  while (i > 0) {
    proof.push(tree.nodes[i % 2 === 1 ? i + 1 : i - 1]);
    i = Math.floor((i - 1) / 2);
  }
  return proof;
}

/** `MerkleProof.processProof`: the root a proof leads to from a leaf. */
export function processProof(proof: readonly Hex[], leaf: Hex): Hex {
  return proof.reduce<Hex>((acc, p) => hashPair(acc, p), leaf);
}

/** Why a published list cannot prove membership for an offer. */
export type ListProblem = 'empty' | 'duplicates' | 'count' | 'root';

/**
 * Check a published list against the offer it belongs to (the design's
 * off-chain check, section 5): at least one id, no id twice, as many ids as
 * the offer states, and a standard tree over them whose root is the offer's.
 * Returns the problem, or the tree that matched.
 */
export function checkPublishedList(
  ids: readonly bigint[],
  set: Pick<CollateralSetView, 'root' | 'listCount'>,
): { ok: true; tree: Tree } | { ok: false; problem: ListProblem } {
  if (ids.length === 0) return { ok: false, problem: 'empty' };
  if (new Set(ids).size !== ids.length) return { ok: false, problem: 'duplicates' };
  if (ids.length !== set.listCount) return { ok: false, problem: 'count' };
  const want = set.root.toLowerCase();
  for (const sortLeaves of [true, false]) {
    const tree = buildTree(ids, sortLeaves);
    if (tree.nodes[0].toLowerCase() === want) return { ok: true, tree };
  }
  return { ok: false, problem: 'root' };
}

/**
 * The proof that `tokenId` is in a Listed set whose published ids are `ids`,
 * or `null` when the id is not in the list, the list does not check out
 * against the offer ({@link checkPublishedList}), or the proof would be
 * longer than the contract accepts.
 */
export function listedProof(
  ids: readonly bigint[],
  set: Pick<CollateralSetView, 'root' | 'listCount'>,
  tokenId: bigint,
): Hex[] | null {
  const checked = checkPublishedList(ids, set);
  return checked.ok ? treeProof(checked.tree, tokenId) : null;
}

/**
 * The proof that `tokenId` is in a tree {@link checkPublishedList} accepted,
 * or `null` when the id is not in it or the proof would be longer than the
 * contract accepts. A reader proving many ids against one list checks the
 * list once and calls this per id.
 */
export function treeProof(tree: Tree, tokenId: bigint): Hex[] | null {
  const at = tree.leafIndex.get(tokenId);
  if (at === undefined) return null;
  const proof = proofAt(tree, at);
  return proof.length > MAX_PROOF_DEPTH ? null : proof;
}
