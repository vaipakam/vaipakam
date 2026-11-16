/** Types for `positionNft.mjs` (#3205). See that file's header. */
import type { Abi } from 'viem';

type Hex = `0x${string}`;

export interface PositionNftSurface {
  /** The PositionNFT: owners, approvals, transfers and enumeration. */
  readonly nft: Hex;
  /** The Diamond: the open route and retirement. */
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
}>;

export const POSITION_ERC721_ABI: Abi;
export const POSITION_ROUTE_ABI: Abi;
/** The PositionNFT's ERC-721 events, decoded outside the generated Diamond ABI. */
export const POSITION_NFT_INDEXED_EVENTS: Abi;

export class PositionNftMissingError extends Error {
  constructor(deployment: unknown);
}

/** Throws {@link PositionNftMissingError} when the record names no PositionNFT. */
export function positionNftSurface(deployment: {
  diamond: string;
  positionNFT?: string | undefined;
  chainId?: number | undefined;
}): PositionNftSurface;
export function positionNftSurfaceForDiamond(
  diamond: string,
  deployments: Readonly<
    Record<string | number, { diamond: string; positionNFT?: string | undefined; chainId?: number | undefined } | undefined>
  >,
): PositionNftSurface | null;
export class PositionRetiredError extends Error {
  readonly tokenId: bigint;
  constructor(tokenId: bigint | number | string);
}
export function positionHolderCalls(
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
): { owner: PositionContractCall; retired: PositionContractCall };
export function positionHolderFrom(owner: Hex, retired: boolean): Hex | 'gone';
export function readPositionOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { readContract: (args: any) => Promise<unknown> },
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
  blockNumber?: bigint,
): Promise<Hex>;
export function positionRouteCall(surface: PositionNftSurface, tokenId: bigint | number | string): PositionContractCall;
export function positionRetiredCall(surface: PositionNftSurface, tokenId: bigint | number | string): PositionContractCall;
