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
 * A listed set is published as ONE canonical list file (design section 5,
 * settled 2026-11-16), so the app, the indexer, the keeper and the Console
 * agree byte for byte:
 *   - the file is a JSON array of decimal id strings, strictly ascending by
 *     value, no duplicates, no leading zeros, no whitespace, UTF-8 without a
 *     byte-order mark and without a trailing newline ({@link canonicalListFile});
 *   - the offer's `listHash` is keccak256 of the file's exact bytes, also
 *     when the ids are published in the creation event ({@link listFileHash});
 *   - the root is OpenZeppelin's `StandardMerkleTree` over the ids with its
 *     default leaf sorting: each leaf is
 *     `keccak256(bytes.concat(keccak256(abi.encode(uint256 id))))`, the
 *     leaves are sorted by hash, and each pair is hashed in sorted order, as
 *     `MerkleProof.verifyCalldata` checks it. One construction, so a root
 *     built any other way is "list does not match".
 */
import { concat, encodeAbiParameters, keccak256, stringToBytes, type Hex } from 'viem';

/** `LibVaipakam.CollateralSetKind`, in contract order. */
export const CollateralSetKind = {
  None: 0,
  Collection: 1,
  Range: 2,
  Listed: 3,
} as const;

/** `LibCollateralSet.MAX_PROOF_DEPTH`: a longer proof is refused on-chain. */
export const MAX_PROOF_DEPTH = 20;

/** The most ids a listed set can hold: a tree of this many leaves needs a
 *  proof of at most {@link MAX_PROOF_DEPTH} steps. */
export const MAX_LIST_IDS = 1 << MAX_PROOF_DEPTH;

/** A collection offer's set, as `getCollectionOffer` returns it. */
export interface CollateralSetView {
  kind: number;
  low: bigint;
  high: bigint;
  root: Hex;
  listCount: number;
  /** keccak256 of the set's canonical list file ({@link listFileHash}). */
  listHash: Hex;
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

/** OpenZeppelin `StandardMerkleTree` construction with its default leaf
 *  sorting: the leaves, sorted by hash, sit at the end of the node array in
 *  reverse order, and each inner node hashes its two children. */
export function buildTree(ids: readonly bigint[]): Tree {
  const leaves = ids.map((id) => ({ id, hash: collateralSetLeaf(id) }));
  leaves.sort((x, y) => (BigInt(x.hash) < BigInt(y.hash) ? -1 : BigInt(x.hash) > BigInt(y.hash) ? 1 : 0));
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

/** The canonical list file of `ids`: their decimal strings, ascending by
 *  value, as a JSON array with no whitespace. The caller checks the ids are
 *  distinct and non-negative; this only orders and writes them. */
export function canonicalListFile(ids: readonly bigint[]): string {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(sorted.map((x) => x.toString()));
}

/** keccak256 of a list file's exact UTF-8 bytes: the offer's `listHash`. */
export function listFileHash(file: string): Hex {
  return keccak256(stringToBytes(file));
}

/**
 * Read a list file, accepting only the canonical form: the ids, or null when
 * the text is not exactly the canonical file of the ids it names (any
 * whitespace, a byte-order mark, a trailing newline, a number not written as
 * a string, a leading zero, a duplicate or an id out of order).
 */
export function parseListFile(file: string): bigint[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(file);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > MAX_LIST_IDS) return null;
  const ids: bigint[] = [];
  for (const x of raw) {
    if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x)) return null;
    const id = BigInt(x);
    if (id >= 1n << 256n) return null;
    if (ids.length > 0 && id <= ids[ids.length - 1]) return null;
    ids.push(id);
  }
  return canonicalListFile(ids) === file ? ids : null;
}

/** Why a published list cannot prove membership for an offer. */
export type ListProblem = 'empty' | 'duplicates' | 'count' | 'hash' | 'root';

/**
 * Check a published list against the offer it belongs to (the design's
 * off-chain check, section 5): at least one id, no id twice, as many ids as
 * the offer states, the offer's `listHash` equal to the hash of the list's
 * canonical file, and the standard tree over them rooted at the offer's
 * root. The ids may come in any order (a creation event publishes them as
 * the lender gave them); the canonical file orders them. Returns the
 * problem, or the tree that matched.
 */
export function checkPublishedList(
  ids: readonly bigint[],
  set: Pick<CollateralSetView, 'root' | 'listCount' | 'listHash'>,
): { ok: true; tree: Tree } | { ok: false; problem: ListProblem } {
  if (ids.length === 0) return { ok: false, problem: 'empty' };
  if (new Set(ids).size !== ids.length) return { ok: false, problem: 'duplicates' };
  if (ids.length !== set.listCount || ids.length > MAX_LIST_IDS) return { ok: false, problem: 'count' };
  if (listFileHash(canonicalListFile(ids)) !== set.listHash.toLowerCase()) return { ok: false, problem: 'hash' };
  const tree = buildTree(ids);
  if (tree.nodes[0].toLowerCase() !== set.root.toLowerCase()) return { ok: false, problem: 'root' };
  return { ok: true, tree };
}

/**
 * The proof that `tokenId` is in a Listed set whose published ids are `ids`,
 * or `null` when the id is not in the list, the list does not check out
 * against the offer ({@link checkPublishedList}), or the proof would be
 * longer than the contract accepts.
 */
export function listedProof(
  ids: readonly bigint[],
  set: Pick<CollateralSetView, 'root' | 'listCount' | 'listHash'>,
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
