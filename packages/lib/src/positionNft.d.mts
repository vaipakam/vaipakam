/** Types for `positionNft.mjs` (#3205). See that file's header. */
import type { Abi } from 'viem';

type Hex = `0x${string}`;

export type PositionNftMode = 'standalone' | 'legacy';

export interface PositionNftSurface {
  readonly mode: PositionNftMode;
  /** Where owners, approvals, transfers and enumeration are read and sent:
   *  the PositionNFT (standalone) or the Diamond (legacy). */
  readonly nft: Hex;
  /** The Diamond: the open route, retirement and (legacy) the NFT queue. */
  readonly diamond: Hex;
}

export interface PositionContractCall {
  address: Hex;
  abi: Abi;
  functionName: string;
  args: readonly [bigint];
}

export const POSITION_ROUTE: Readonly<{
  None: 0;
  PrecloseOffset: 1;
  EarlyWithdrawalSale: 2;
  PrepayCollateralListing: 3;
  SwapToRepayIntent: 4;
  LegacyProtectedOwner: 5;
}>;

export const POSITION_ERC721_ABI: Abi;
/** FROZEN pre-#3205 Diamond fragment; legacy mode only. */
export const LEGACY_DIAMOND_NFT_ABI: Abi;
export const POSITION_ROUTE_ABI: Abi;

export function positionNftSurface(deployment: { diamond: string; positionNFT?: string | undefined }): PositionNftSurface;
export function positionNftSurfaceForDiamond(
  diamond: string,
  deployments: Readonly<Record<string | number, { diamond: string; positionNFT?: string | undefined } | undefined>>,
): PositionNftSurface | null;
export function routeBlocksTransfer(surface: PositionNftSurface): boolean;
export function positionOwnerOfCall(surface: PositionNftSurface, tokenId: bigint | number | string): PositionContractCall;
export function positionRouteCall(surface: PositionNftSurface, tokenId: bigint | number | string): PositionContractCall;
export function positionRetiredCall(
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
): PositionContractCall | null;
