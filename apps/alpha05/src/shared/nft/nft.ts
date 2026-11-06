/**
 * NFT-13 / OFF-02 — what the app reads about an NFT a flow pledges as
 * collateral, from the token contract itself (a chain read, RB-RAILS). Which
 * standard a collection follows is the contract's own answer (ERC-165),
 * never assumed from a list; who holds a token and whether the protocol may
 * move it are read for the exact token, at one block.
 *
 * An ERC-721 token is approved alone. An ERC-1155 token can only be
 * approved through an operator approval over the whole collection, so the
 * flow grants it for the action alone and takes it back after
 * (shared/tx/operatorApproval).
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, parseEventLogs, type Log, type PublicClient } from 'viem';

type Hex = `0x${string}`;

/** ERC-165 interface ids. */
const IFACE_721 = '0x80ac58cd';
const IFACE_1155 = '0xd9b67a26';

/** The protocol's `AssetType` positions. */
export const ASSET_TYPE = { erc20: 0, erc721: 1, erc1155: 2 } as const;

export type Standard = 'erc20' | 'erc721' | 'erc1155';

export const NFT_ABI = [
  { type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
] as const;

/** Whether an error is the contract's own answer (a revert, or no code /
 *  no data where a view was expected), as opposed to a read that failed. */
export function isContractAnswer(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null;
}

async function supports(c: PublicClient, asset: Hex, iface: Hex): Promise<boolean> {
  try {
    return (await c.readContract({ address: asset, abi: NFT_ABI, functionName: 'supportsInterface', args: [iface] })) === true;
  } catch (e) {
    // A contract without ERC-165 (every plain ERC-20) does not claim either
    // NFT standard; that is an answer. A read that failed is not one, and
    // propagates, so the page says the standard is unknown instead of
    // treating the asset as a fungible token.
    if (isContractAnswer(e)) return false;
    throw e;
  }
}

/** The standard a collection claims: ERC-721, ERC-1155, or neither (read
 *  as a fungible token, whose own reads then say whether it is one). */
export async function readStandard(c: PublicClient, asset: Hex): Promise<Standard> {
  const [is721, is1155] = await Promise.all([supports(c, asset, IFACE_721), supports(c, asset, IFACE_1155)]);
  if (is721) return 'erc721';
  if (is1155) return 'erc1155';
  return 'erc20';
}

/** A token id as typed: whole digits only, any size the chain takes. */
export function parseTokenId(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = BigInt(t);
  return v < 2n ** 256n ? v : null;
}

/** An ERC-721 token as the wallet and the protocol stand on it, at one
 *  block. `owner` is null when the token does not exist (ownerOf reverts). */
export interface Erc721State {
  owner: Hex | null;
  /** The single-token approval: the address the token may be moved by. */
  approved: Hex | null;
  /** Whether the wallet lets the protocol move every token it holds in the
   *  collection (an approval the wallet set before; this app never sets it). */
  approvedForAll: boolean;
  blockNumber: bigint;
}

export async function readErc721(c: PublicClient, asset: Hex, tokenId: bigint, account: Hex, diamond: Hex, blockNumber?: bigint): Promise<Erc721State> {
  // The head is fetched fresh (cacheTime 0): viem otherwise reuses a block
  // number for a few seconds, and a read right after a transaction mined
  // would then describe the token as it stood before it.
  const block = blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 }));
  const at = { blockNumber: block };
  let owner: Hex | null = null;
  try {
    owner = (await c.readContract({ address: asset, abi: NFT_ABI, functionName: 'ownerOf', args: [tokenId], ...at })) as Hex;
  } catch (e) {
    // ERC-721 reverts ownerOf for a token that does not exist; a read that
    // failed is not that answer and propagates.
    if (!isContractAnswer(e)) throw e;
    return { owner: null, approved: null, approvedForAll: false, blockNumber: block };
  }
  const [approved, forAll] = await Promise.all([
    c.readContract({ address: asset, abi: NFT_ABI, functionName: 'getApproved', args: [tokenId], ...at }) as Promise<Hex>,
    c.readContract({ address: asset, abi: NFT_ABI, functionName: 'isApprovedForAll', args: [account, diamond], ...at }) as Promise<boolean>,
  ]);
  return { owner, approved, approvedForAll: forAll, blockNumber: block };
}

/** Whether the protocol may move the token now, by either approval. */
export function diamondMayMove(s: Erc721State, diamond: Hex): boolean {
  return s.approvedForAll || (s.approved !== null && s.approved.toLowerCase() === diamond.toLowerCase());
}

/** Whether `account` holds the token. */
export function holds(s: Erc721State, account: Hex): boolean {
  return s.owner !== null && s.owner.toLowerCase() === account.toLowerCase();
}

const TRANSFER_721 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);

/** Whether the transaction's own logs record `asset` moving token `tokenId`
 *  from `from` to `to`. ERC-20 and ERC-721 share the Transfer signature, so
 *  only a log whose token id is indexed (four topics) is read as one. */
export function tokenMoved(logs: readonly Log[], asset: Hex, tokenId: bigint, from: Hex, to: Hex): boolean {
  return logs.some((l) => {
    if (l.address.toLowerCase() !== asset.toLowerCase() || l.topics.length !== 4) return false;
    try {
      const [ev] = parseEventLogs({ abi: TRANSFER_721, logs: [l], strict: true });
      return ev !== undefined && ev.args.tokenId === tokenId && ev.args.from.toLowerCase() === from.toLowerCase() && ev.args.to.toLowerCase() === to.toLowerCase();
    } catch {
      return false;
    }
  });
}

/** An ERC-1155 token as the wallet and the protocol stand on it, at one
 *  block. */
export interface Erc1155State {
  /** How many of the token the wallet holds. */
  balance: bigint;
  /** Whether the wallet lets the protocol move every token it holds in the
   *  collection (the only approval ERC-1155 has). */
  approvedForAll: boolean;
  blockNumber: bigint;
}

/** The largest quantity the protocol's vault records for one ERC-1155 leg. */
export const MAX_1155_QUANTITY = 2n ** 128n - 1n;

/** A quantity as typed: whole digits, at least one, within the vault's range. */
export function parseQuantity(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = BigInt(t);
  return v >= 1n && v <= MAX_1155_QUANTITY ? v : null;
}

export async function readErc1155(c: PublicClient, asset: Hex, tokenId: bigint, account: Hex, diamond: Hex, blockNumber?: bigint): Promise<Erc1155State> {
  // A fresh head, as for an ERC-721 (viem caches a block number briefly).
  const block = blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 }));
  const at = { blockNumber: block };
  const [balance, forAll] = await Promise.all([
    c.readContract({ address: asset, abi: NFT_ABI, functionName: 'balanceOf', args: [account, tokenId], ...at }) as Promise<bigint>,
    c.readContract({ address: asset, abi: NFT_ABI, functionName: 'isApprovedForAll', args: [account, diamond], ...at }) as Promise<boolean>,
  ]);
  return { balance, approvedForAll: forAll, blockNumber: block };
}

const TRANSFER_1155 = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

/** How many of `asset`'s token `tokenId` the transaction's own logs record
 *  moving from `from` to `to`, single and batch transfers together. */
export function quantityMoved(logs: readonly Log[], asset: Hex, tokenId: bigint, from: Hex, to: Hex): bigint {
  let moved = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== asset.toLowerCase()) continue;
    let ev;
    try {
      [ev] = parseEventLogs({ abi: TRANSFER_1155, logs: [l], strict: true });
    } catch {
      continue;
    }
    if (ev === undefined || ev.args.from.toLowerCase() !== from.toLowerCase() || ev.args.to.toLowerCase() !== to.toLowerCase()) continue;
    if (ev.eventName === 'TransferSingle') {
      if (ev.args.id === tokenId) moved += ev.args.value;
    } else {
      ev.args.ids.forEach((id, i) => {
        if (id === tokenId) moved += ev.args.values[i] ?? 0n;
      });
    }
  }
  return moved;
}

