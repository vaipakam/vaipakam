import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Abi, type AbiFunction } from 'viem';
import { DIAMOND_ABI_VIEM, PositionNFTABI } from '@vaipakam/contracts/abis';
import {
  LEGACY_DIAMOND_NFT_ABI,
  POSITION_ERC721_ABI,
  POSITION_ROUTE,
  POSITION_ROUTE_ABI,
  positionNftSurface,
  positionNftSurfaceForDiamond,
  positionOwnerOfCall,
  positionRetiredCall,
  positionRouteCall,
  routeBlocksTransfer,
} from './positionNft.mjs';
import { readPositionHolder, readPositionRoute } from './positionNftReads';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const NFT = '0x00000000000000000000000000000000000000e1' as const;
const fns = (abi: Abi) => abi.filter((e): e is AbiFunction => e.type === 'function');
const selectors = (abi: Abi) => new Set(fns(abi).map((f) => toFunctionSelector(f)));

describe('positionNftSurface', () => {
  it('reads standalone mode from a record that lists positionNFT', () => {
    const s = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
    expect(s).toEqual({ mode: 'standalone', nft: NFT, diamond: DIAMOND });
    expect(routeBlocksTransfer(s)).toBe(false);
  });

  it('falls back to the Diamond (legacy) when the record has no positionNFT', () => {
    const s = positionNftSurface({ diamond: DIAMOND });
    expect(s).toEqual({ mode: 'legacy', nft: DIAMOND, diamond: DIAMOND });
    expect(routeBlocksTransfer(s)).toBe(true);
  });

  it('finds a record by its Diamond, case-insensitively, and says when none does', () => {
    const all = { 1: { diamond: DIAMOND.toUpperCase().replace('0X', '0x'), positionNFT: NFT } };
    expect(positionNftSurfaceForDiamond(DIAMOND, all)?.mode).toBe('standalone');
    expect(positionNftSurfaceForDiamond(NFT, all)).toBeNull();
  });
});

describe('call builders', () => {
  const standalone = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
  const legacy = positionNftSurface({ diamond: DIAMOND });

  it('aims ownerOf at the token contract', () => {
    expect(positionOwnerOfCall(standalone, 7n).address).toBe(NFT);
    expect(positionOwnerOfCall(legacy, 7n).address).toBe(DIAMOND);
  });

  it('reads the route from the Diamond under each mode’s name', () => {
    expect(positionRouteCall(standalone, 7).functionName).toBe('positionRoute');
    expect(positionRouteCall(legacy, 7).functionName).toBe('positionLock');
    expect(positionRouteCall(legacy, 7).address).toBe(DIAMOND);
  });

  it('has a retirement read only in standalone mode', () => {
    expect(positionRetiredCall(standalone, 1)?.functionName).toBe('isPositionRetired');
    expect(positionRetiredCall(legacy, 1)).toBeNull();
  });
});

describe('fragments against the generated ABIs', () => {
  it('the ERC-721 fragment is a subset of PositionNFT', () => {
    const have = selectors(PositionNFTABI as Abi);
    for (const f of fns(POSITION_ERC721_ABI)) expect(have.has(toFunctionSelector(f)), f.name).toBe(true);
  });

  it('the standalone Diamond reads exist on the Diamond', () => {
    const have = selectors(DIAMOND_ABI_VIEM as Abi);
    for (const f of fns(POSITION_ROUTE_ABI)) expect(have.has(toFunctionSelector(f)), f.name).toBe(true);
  });

  it('the frozen legacy functions are no longer on the generated Diamond ABI', () => {
    const have = selectors(DIAMOND_ABI_VIEM as Abi);
    for (const f of fns(LEGACY_DIAMOND_NFT_ABI)) expect(have.has(toFunctionSelector(f)), f.name).toBe(false);
  });

  it('pins the legacy selectors the old Diamond routed', () => {
    const got = Object.fromEntries(fns(LEGACY_DIAMOND_NFT_ABI).map((f) => [`${f.name}/${f.inputs.length}`, toFunctionSelector(f)]));
    expect(got['ownerOf/1']).toBe('0x6352211e');
    expect(got['positionLock/1']).toBe(toFunctionSelector('function positionLock(uint256)'));
    expect(got['queuePositionTransfer/2']).toBe(toFunctionSelector('function queuePositionTransfer(uint256,address)'));
    expect(got['getPendingTransferIds/1']).toBe(toFunctionSelector('function getPendingTransferIds(address)'));
  });

  it('keeps the route ordinals the two enums share', () => {
    expect(POSITION_ROUTE.EarlyWithdrawalSale).toBe(2);
    expect(POSITION_ROUTE.SwapToRepayIntent).toBe(4);
  });
});

describe('reads', () => {
  const revert = () => new BaseError('reverted', { cause: new ContractFunctionRevertedError({ abi: [], functionName: 'ownerOf' }) });
  const client = (answers: Record<string, unknown>) => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      const a = answers[functionName];
      if (a instanceof Error) throw a;
      return a;
    },
  });

  it('reads a route as its ordinal', async () => {
    const s = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
    expect(await readPositionRoute(client({ positionRoute: 2 }), s, 1n)).toBe(2);
  });

  it('a retired standalone token reads as gone though it keeps an owner', async () => {
    const s = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
    expect(await readPositionHolder(client({ ownerOf: NFT, isPositionRetired: true }), s, 1n)).toBe('gone');
    expect(await readPositionHolder(client({ ownerOf: NFT, isPositionRetired: false }), s, 1n)).toBe(NFT);
  });

  it('a legacy ownerOf revert reads as gone; a transport failure throws', async () => {
    const s = positionNftSurface({ diamond: DIAMOND });
    expect(await readPositionHolder(client({ ownerOf: revert() }), s, 1n)).toBe('gone');
    await expect(readPositionHolder(client({ ownerOf: new Error('fetch failed') }), s, 1n)).rejects.toThrow('fetch failed');
  });
});
