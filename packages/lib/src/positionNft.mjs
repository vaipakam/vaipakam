/**
 * #3205 — where a chain's position NFTs live, and how to read them.
 *
 * PR #3318 moved the position NFTs out of the Diamond into a standalone
 * ERC-721, `PositionNFT`. The apps deploy from `main` while the live testnets
 * keep their older Diamond until a fresh deploy, so every reader picks a MODE
 * per chain from that chain's deployment record:
 *
 *   - `standalone`: the record lists `positionNFT`. Owners, approvals,
 *     transfers and enumeration go to that contract. The Diamond answers the
 *     open protocol route (`positionRoute`) and whether a token was retired
 *     (`isPositionRetired`). A route does NOT stop the token moving: moving it
 *     makes the route's completion revert, so the route can then only be
 *     cancelled. Tokens are retired when their position closes, never burned.
 *   - `legacy`: no `positionNFT` in the record. The Diamond is still the
 *     position NFT, and is called through the FROZEN fragment below, which is
 *     NOT part of the generated combined ABI. A route there (`positionLock`)
 *     DOES block transfers, protected mode queues NFT transfers, and a closed
 *     position's token is burned.
 *
 * TODO(#3321 positionNft-legacy-removal): delete the `legacy` mode, the
 * frozen fragment and every branch on it at the all-waves fresh deploy, when
 * every deployment records `positionNFT`.
 *
 * Plain JS (with `positionNft.d.mts`) so the Node live drivers can import it
 * as well as the TypeScript apps and Workers.
 */

/** The route a token carries, in the contract's order. `LibERC721.LockReason`
 *  (legacy) and `LibPositionNFT.RouteReason` (standalone) share it; ordinal 5
 *  is the legacy protected-owner lock, retired in standalone mode. */
export const POSITION_ROUTE = Object.freeze({
  None: 0,
  PrecloseOffset: 1,
  EarlyWithdrawalSale: 2,
  PrepayCollateralListing: 3,
  SwapToRepayIntent: 4,
  LegacyProtectedOwner: 5,
});

const u256 = (name) => ({ name, type: 'uint256' });
const addr = (name) => ({ name, type: 'address' });
const view = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });
const write = (name, inputs, outputs = []) => ({ type: 'function', name, stateMutability: 'nonpayable', inputs, outputs });
const err = (name, inputs = []) => ({ type: 'error', name, inputs });
const ev = (name, inputs) => ({ type: 'event', name, anonymous: false, inputs });
const ix = (p) => ({ ...p, indexed: true });

/** The standard ERC-721 surface both contracts answer with identical
 *  selectors: aim it at `surface.nft`. */
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

/** FROZEN: the pre-#3205 Diamond's position-NFT surface (VaipakamNFTFacet,
 *  VaultPayoutFacet, ProtectedAccountFacet on `main` before PR #3318), for
 *  legacy-mode chains only. Never regenerate it; delete it with the legacy
 *  mode. */
export const LEGACY_DIAMOND_NFT_ABI = Object.freeze([
  ...POSITION_ERC721_ABI,
  view('positionLock', [u256('tokenId')], [{ name: '', type: 'uint8' }]),
  write('queuePositionTransfer', [u256('tokenId'), addr('to')], [u256('id')]),
  write('cancelPositionTransfer', [u256('id')]),
  write('releasePositionTransfer', [u256('id')]),
  write('cosignPositionTransfer', [u256('id')]),
  write('setProtectNfts', [addr('account'), { name: 'on', type: 'bool' }]),
  view('getPendingTransferIds', [addr('account')], [{ name: '', type: 'uint256[]' }]),
  view(
    'getPendingPositionTransfer',
    [u256('id')],
    [
      {
        name: '',
        type: 'tuple',
        components: [
          addr('from'),
          { name: 'state', type: 'uint8' },
          { name: 'cosigned', type: 'bool' },
          { name: 'releaseAt', type: 'uint64' },
          addr('to'),
          u256('tokenId'),
        ],
      },
    ],
  ),
  ev('NFTBurned', [ix(u256('tokenId'))]),
  ev('PositionTransferQueued', [ix(addr('account')), ix(u256('id')), ix(u256('tokenId')), { ...addr('to'), indexed: false }, { ...u256('releaseAt'), indexed: false }]),
  ev('PositionTransferReleased', [ix(addr('account')), ix(u256('id')), ix(u256('tokenId')), { ...addr('to'), indexed: false }]),
  ev('PositionTransferCancelled', [ix(addr('account')), ix(u256('id')), { ...addr('by'), indexed: false }]),
  ev('PositionTransferCosigned', [ix(addr('account')), ix(u256('id')), ix(addr('signer'))]),
  err('ERC721Locked', [u256('tokenId'), { name: 'reason', type: 'uint8' }]),
  err('LockReasonConflict', [u256('tokenId'), { name: 'current', type: 'uint8' }, { name: 'attempted', type: 'uint8' }]),
  err('ApprovalForbiddenWhileTokensLocked', [addr('owner'), u256('lockedCount')]),
  err('ProtectedOwnerApprovalForbidden', [addr('owner')]),
  err('NFTAlreadyBurned'),
  err('InvalidTokenId'),
  err('RowNotQueued', [u256('id')]),
  err('PayoutNotDue', [u256('id'), u256('releaseAt')]),
  err('CosignRequired', [u256('id')]),
  err('TooManyPendingRows'),
  err('RecipientNotAllowlisted', [addr('account'), addr('recipient')]),
  err('ProtectedVaultLocked', [addr('account')]),
  err('ProtectedModeOff', [addr('account')]),
]);

/** The standalone-mode reads the Diamond keeps (VaipakamNFTFacet). */
export const POSITION_ROUTE_ABI = Object.freeze([
  view('positionRoute', [u256('tokenId')], [{ name: '', type: 'uint8' }]),
  view('isPositionRetired', [u256('tokenId')], [{ name: '', type: 'bool' }]),
  view('positionNFT', [], [addr('')]),
]);

/** The mode and addresses for one deployment record. */
export function positionNftSurface(deployment) {
  const diamond = deployment.diamond;
  const nft = deployment.positionNFT;
  return nft
    ? Object.freeze({ mode: 'standalone', nft, diamond })
    : Object.freeze({ mode: 'legacy', nft: diamond, diamond });
}

/** The surface of the deployment whose Diamond is `diamond`, or null when no
 *  record in `deployments` names it. */
export function positionNftSurfaceForDiamond(diamond, deployments) {
  const want = String(diamond).toLowerCase();
  for (const d of Object.values(deployments)) {
    if (d && typeof d.diamond === 'string' && d.diamond.toLowerCase() === want) return positionNftSurface(d);
  }
  return null;
}

/** Legacy only: an open route blocks the token moving. In standalone mode a
 *  move is allowed and cancels the route instead. */
export function routeBlocksTransfer(surface) {
  return surface.mode === 'legacy';
}

/** RAW `ownerOf(tokenId)` on the contract holding the tokens. Not exported:
 *  in standalone mode a retired receipt still has an owner, so a raw owner is
 *  not a live holder. Every reader goes through {@link readPositionOwner} or,
 *  when batching, {@link positionHolderCalls} + {@link positionHolderFrom},
 *  which carry the retired rule (#3318 Codex r2). */
function tokenOwnerCall(surface, tokenId) {
  return { address: surface.nft, abi: POSITION_ERC721_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] };
}

/** Thrown by {@link readPositionOwner} for a retired token: the standalone
 *  counterpart of the legacy `ownerOf` revert for a burned one. */
export class PositionRetiredError extends Error {
  constructor(tokenId) {
    super(`position token ${String(tokenId)} is retired: its position closed`);
    this.name = 'PositionRetiredError';
    this.tokenId = BigInt(tokenId);
  }
}

/**
 * The calls that establish a LIVE holder of `tokenId`, for a batched reader:
 * the owner, and (standalone) whether the token was retired. Read both at the
 * same block, then pass the answers to {@link positionHolderFrom}.
 */
export function positionHolderCalls(surface, tokenId) {
  return { owner: tokenOwnerCall(surface, tokenId), retired: positionRetiredCall(surface, tokenId) };
}

/** A live holder from {@link positionHolderCalls}' answers: the owner, or
 *  `'gone'` when the token was retired. `retired` is ignored (pass
 *  `undefined`) when the surface has no retired call. */
export function positionHolderFrom(owner, retired) {
  return retired === true ? 'gone' : owner;
}

/**
 * The LIVE holder of `tokenId`, read at `blockNumber` (both reads at that one
 * block). Throws exactly as a pre-#3205 `ownerOf` did: a revert for a token
 * never minted (and, legacy, burned), {@link PositionRetiredError} for a
 * retired one, and a transport failure as itself.
 */
export async function readPositionOwner(client, surface, tokenId, blockNumber) {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const calls = positionHolderCalls(surface, tokenId);
  const [owner, retired] = await Promise.all([
    client.readContract({ ...calls.owner, ...at }),
    calls.retired ? client.readContract({ ...calls.retired, ...at }) : Promise.resolve(undefined),
  ]);
  if (positionHolderFrom(owner, retired) === 'gone') throw new PositionRetiredError(tokenId);
  return owner;
}

/** The open route on `tokenId`: `positionRoute` (standalone) or the legacy
 *  `positionLock`, both on the Diamond, both returning the ordinal above. */
export function positionRouteCall(surface, tokenId) {
  return surface.mode === 'standalone'
    ? { address: surface.diamond, abi: POSITION_ROUTE_ABI, functionName: 'positionRoute', args: [BigInt(tokenId)] }
    : { address: surface.diamond, abi: LEGACY_DIAMOND_NFT_ABI, functionName: 'positionLock', args: [BigInt(tokenId)] };
}

/** `isPositionRetired(tokenId)` on the Diamond (standalone), or null: a
 *  legacy chain burns a closed position's token instead. */
export function positionRetiredCall(surface, tokenId) {
  return surface.mode === 'standalone'
    ? { address: surface.diamond, abi: POSITION_ROUTE_ABI, functionName: 'isPositionRetired', args: [BigInt(tokenId)] }
    : null;
}
