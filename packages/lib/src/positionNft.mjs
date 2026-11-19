/**
 * #3205 — where a chain's position NFTs live, and how to read them.
 *
 * Position NFTs live in a standalone ERC-721, `PositionNFT` (PR #3318), whose
 * address every deployment record carries as `positionNFT`. Owners,
 * approvals, transfers and enumeration go to that contract. The Diamond
 * answers the open protocol route (`positionRoute`) and whether a token was
 * retired (`isPositionRetired`). A route does NOT stop the token moving:
 * moving it makes the route's completion revert, so the route can then only
 * be cancelled. Tokens are retired when their position closes, never burned.
 *
 * A deployment record without `positionNFT` is refused (#3321): there is no
 * fallback to reading the Diamond as the NFT.
 *
 * Plain JS (with `positionNft.d.mts`) so the Node live drivers can import it
 * as well as the TypeScript apps and Workers.
 */

/** The route a token carries, in the order of the contract's
 *  `LibPositionNFT.RouteReason`. Ordinal 5 (`retiredProtectedOwner` there)
 *  is retired: it is kept in the contract only so the member order stays
 *  unchanged, and `positionRoute` never returns it. */
export const POSITION_ROUTE = Object.freeze({
  None: 0,
  PrecloseOffset: 1,
  EarlyWithdrawalSale: 2,
  PrepayCollateralListing: 3,
  SwapToRepayIntent: 4,
});

const u256 = (name) => ({ name, type: 'uint256' });
const addr = (name) => ({ name, type: 'address' });
const view = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });
const write = (name, inputs, outputs = []) => ({ type: 'function', name, stateMutability: 'nonpayable', inputs, outputs });
const err = (name, inputs = []) => ({ type: 'error', name, inputs });
const ev = (name, inputs) => ({ type: 'event', name, anonymous: false, inputs });
const ix = (p) => ({ ...p, indexed: true });

/** The standard ERC-721 surface of the PositionNFT: aim it at
 *  `surface.nft`. */
export const POSITION_ERC721_ABI = Object.freeze([
  view('ownerOf', [u256('tokenId')], [addr('')]),
  view('balanceOf', [addr('owner')], [u256('')]),
  view('tokenOfOwnerByIndex', [addr('owner'), u256('index')], [u256('')]),
  view('totalSupply', [], [u256('')]),
  view('tokenByIndex', [u256('index')], [u256('')]),
  view('getApproved', [u256('tokenId')], [addr('')]),
  view('isApprovedForAll', [addr('owner'), addr('operator')], [{ name: '', type: 'bool' }]),
  write('approve', [addr('to'), u256('tokenId')]),
  write('setApprovalForAll', [addr('operator'), { name: 'approved', type: 'bool' }]),
  write('transferFrom', [addr('from'), addr('to'), u256('tokenId')]),
  write('safeTransferFrom', [addr('from'), addr('to'), u256('tokenId')]),
  write('safeTransferFrom', [addr('from'), addr('to'), u256('tokenId'), { name: 'data', type: 'bytes' }]),
  ev('Transfer', [ix(addr('from')), ix(addr('to')), ix(u256('tokenId'))]),
  ev('Approval', [ix(addr('owner')), ix(addr('approved')), ix(u256('tokenId'))]),
  ev('ApprovalForAll', [ix(addr('owner')), ix(addr('operator')), { name: 'approved', type: 'bool', indexed: false }]),
  err('ERC721NonexistentToken', [u256('tokenId')]),
  err('ERC721IncorrectOwner', [addr('sender'), u256('tokenId'), addr('owner')]),
  err('ERC721InsufficientApproval', [addr('operator'), u256('tokenId')]),
]);

/**
 * Every position-NFT event the indexer decodes OUTSIDE the generated Diamond
 * ABI: the PositionNFT's ERC-721 events. The ONE list both the indexer's
 * decoder and the Activity participant rule read, so an indexed event can
 * never lose its participant rule because the generated ABI dropped it
 * (#3318 Codex r3).
 */
export const POSITION_NFT_INDEXED_EVENTS = Object.freeze(POSITION_ERC721_ABI.filter((e) => e.type === 'event'));

/** The position reads the Diamond keeps (VaipakamNFTFacet). */
export const POSITION_ROUTE_ABI = Object.freeze([
  view('positionRoute', [u256('tokenId')], [{ name: '', type: 'uint8' }]),
  view('isPositionRetired', [u256('tokenId')], [{ name: '', type: 'bool' }]),
  view('positionNFT', [], [addr('')]),
]);

/** Thrown by {@link positionNftSurface} for a deployment record that names
 *  no PositionNFT. */
export class PositionNftMissingError extends Error {
  constructor(deployment) {
    const chain = deployment && deployment.chainId !== undefined ? `chain ${String(deployment.chainId)}, ` : '';
    super(
      `deployment record (${chain}Diamond ${String(deployment && deployment.diamond)}) names no positionNFT: ` +
        'position NFTs are read only from the standalone PositionNFT (#3321)',
    );
    this.name = 'PositionNftMissingError';
  }
}

/** The addresses for one deployment record. Throws
 *  {@link PositionNftMissingError} when the record names no PositionNFT: it
 *  never falls back to the Diamond. */
export function positionNftSurface(deployment) {
  const nft = deployment && deployment.positionNFT;
  if (typeof nft !== 'string' || nft === '') throw new PositionNftMissingError(deployment);
  return Object.freeze({ nft, diamond: deployment.diamond });
}

/** The surface of the deployment whose Diamond is `diamond`, or null when no
 *  record in `deployments` names it. Throws {@link PositionNftMissingError}
 *  when the matching record names no PositionNFT. */
export function positionNftSurfaceForDiamond(diamond, deployments) {
  const want = String(diamond).toLowerCase();
  for (const d of Object.values(deployments)) {
    if (d && typeof d.diamond === 'string' && d.diamond.toLowerCase() === want) return positionNftSurface(d);
  }
  return null;
}

/** RAW `ownerOf(tokenId)` on the PositionNFT. Not exported: a retired
 *  receipt still has an owner, so a raw owner is
 *  not a live holder. Every reader goes through {@link readPositionOwner} or,
 *  when batching, {@link positionHolderCalls} + {@link positionHolderFrom},
 *  which carry the retired rule (#3318 Codex r2). */
function tokenOwnerCall(surface, tokenId) {
  return { address: surface.nft, abi: POSITION_ERC721_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] };
}

/** Thrown by {@link readPositionOwner} for a retired token: its position
 *  closed, though the token keeps an owner. */
export class PositionRetiredError extends Error {
  constructor(tokenId) {
    super(`position token ${String(tokenId)} is retired: its position closed`);
    this.name = 'PositionRetiredError';
    this.tokenId = BigInt(tokenId);
  }
}

/**
 * The calls that establish a LIVE holder of `tokenId`, for a batched reader:
 * the owner, and whether the token was retired. Read both at the
 * same block, then pass the answers to {@link positionHolderFrom}.
 */
export function positionHolderCalls(surface, tokenId) {
  return { owner: tokenOwnerCall(surface, tokenId), retired: positionRetiredCall(surface, tokenId) };
}

/** A live holder from {@link positionHolderCalls}' answers: the owner, or
 *  `'gone'` when the token was retired. */
export function positionHolderFrom(owner, retired) {
  return retired === true ? 'gone' : owner;
}

/**
 * The LIVE holder of `tokenId`, read at `blockNumber` (both reads at that one
 * block). Throws a revert for a token never minted,
 * {@link PositionRetiredError} for a retired one, and a transport failure as
 * itself.
 */
export async function readPositionOwner(client, surface, tokenId, blockNumber) {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const calls = positionHolderCalls(surface, tokenId);
  const [owner, retired] = await Promise.all([
    client.readContract({ ...calls.owner, ...at }),
    client.readContract({ ...calls.retired, ...at }),
  ]);
  if (positionHolderFrom(owner, retired) === 'gone') throw new PositionRetiredError(tokenId);
  return owner;
}

/** `positionRoute(tokenId)` on the Diamond: the open route as its
 *  {@link POSITION_ROUTE} ordinal. */
export function positionRouteCall(surface, tokenId) {
  return { address: surface.diamond, abi: POSITION_ROUTE_ABI, functionName: 'positionRoute', args: [BigInt(tokenId)] };
}

/** `isPositionRetired(tokenId)` on the Diamond. */
export function positionRetiredCall(surface, tokenId) {
  return { address: surface.diamond, abi: POSITION_ROUTE_ABI, functionName: 'isPositionRetired', args: [BigInt(tokenId)] };
}
