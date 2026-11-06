/**
 * NFT-13 / OFF-02 — what the app reads about an NFT a flow pledges as
 * collateral, from the token contract itself (a chain read, RB-RAILS). Which
 * standard a collection follows is the contract's own answer (ERC-165),
 * never assumed from a list; who holds a token and whether the protocol may
 * move it are read for the exact token, at one block.
 *
 * This slice pledges ERC-721 tokens. An ERC-1155 token needs an operator
 * approval over the whole collection, which must be taken back after the
 * action, so it is named and handed to the current app until that step is
 * built (the flow says so; it never offers a signing step it cannot finish).
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
