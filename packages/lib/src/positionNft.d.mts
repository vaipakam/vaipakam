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
export class PositionRetiredError extends Error {
  readonly tokenId: bigint;
  constructor(tokenId: bigint | number | string);
}
export function positionHolderCalls(
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
): { owner: PositionContractCall; retired: PositionContractCall | null };
export function positionHolderFrom(owner: Hex, retired: boolean | undefined): Hex | 'gone';
export function readPositionOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { readContract: (args: any) => Promise<unknown> },
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
  blockNumber?: bigint,
): Promise<Hex>;
export function positionRouteCall(surface: PositionNftSurface, tokenId: bigint | number | string): PositionContractCall;
export function positionRetiredCall(
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
): PositionContractCall | null;
