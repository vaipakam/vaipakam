import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Abi, type AbiFunction } from 'viem';
import { DIAMOND_ABI_VIEM, PositionNFTABI } from '@vaipakam/contracts/abis';
import {
  POSITION_ERC721_ABI,
  POSITION_NFT_INDEXED_EVENTS,
  POSITION_ROUTE,
  POSITION_ROUTE_ABI,
  positionNftSurface,
  positionNftSurfaceForDiamond,
  PositionNftMissingError,
  PositionRetiredError,
  positionHolderCalls,
  positionHolderFrom,
  readPositionOwner,
  positionRetiredCall,
  positionRouteCall,
} from './positionNft.mjs';
import { readPositionHolder, readPositionRoute } from './positionNftReads';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const NFT = '0x00000000000000000000000000000000000000e1' as const;
const fns = (abi: Abi) => abi.filter((e): e is AbiFunction => e.type === 'function');
const selectors = (abi: Abi) => new Set(fns(abi).map((f) => toFunctionSelector(f)));

describe('positionNftSurface', () => {
  it('reads the PositionNFT and the Diamond from the record', () => {
    expect(positionNftSurface({ diamond: DIAMOND, positionNFT: NFT })).toEqual({ nft: NFT, diamond: DIAMOND });
  });

  it('refuses a record with no positionNFT, naming the chain and Diamond, never falling back', () => {
    expect(() => positionNftSurface({ diamond: DIAMOND, chainId: 84532 })).toThrow(PositionNftMissingError);
    expect(() => positionNftSurface({ diamond: DIAMOND, chainId: 84532 })).toThrow(/chain 84532.*0x0+d1/);
    expect(() => positionNftSurface({ diamond: DIAMOND, positionNFT: '' })).toThrow(PositionNftMissingError);
  });

  it('finds a record by its Diamond, case-insensitively, and says when none does', () => {
    const all = { 1: { diamond: DIAMOND.toUpperCase().replace('0X', '0x'), positionNFT: NFT } };
    expect(positionNftSurfaceForDiamond(DIAMOND, all)?.nft).toBe(NFT);
    expect(positionNftSurfaceForDiamond(NFT, all)).toBeNull();
    expect(() => positionNftSurfaceForDiamond(DIAMOND, { 1: { diamond: DIAMOND } })).toThrow(PositionNftMissingError);
  });
});

describe('call builders', () => {
  const surface = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });

  it('aims ownerOf at the PositionNFT and the retirement read at the Diamond', () => {
    const calls = positionHolderCalls(surface, 7n);
    expect(calls.owner.address).toBe(NFT);
    expect(calls.retired.address).toBe(DIAMOND);
    expect(calls.retired.functionName).toBe('isPositionRetired');
  });

  it('reads the route from the Diamond', () => {
    expect(positionRouteCall(surface, 7)).toMatchObject({ address: DIAMOND, functionName: 'positionRoute', args: [7n] });
    expect(positionRetiredCall(surface, 1)).toMatchObject({ address: DIAMOND, functionName: 'isPositionRetired' });
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

  it('indexes exactly the PositionNFT ERC-721 events', () => {
    expect(POSITION_NFT_INDEXED_EVENTS.map((e) => (e as { name: string }).name)).toEqual([
      'Transfer',
      'Approval',
      'ApprovalForAll',
    ]);
  });

  it('keeps the route ordinals of LibPositionNFT.RouteReason', () => {
    expect(POSITION_ROUTE.EarlyWithdrawalSale).toBe(2);
    expect(POSITION_ROUTE.SwapToRepayIntent).toBe(4);
    expect(Object.values(POSITION_ROUTE)).not.toContain(5);
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

  it('the owner read refuses a retired token, at the block it was asked for', async () => {
    const s = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
    const seen: unknown[] = [];
    const pinned = {
      readContract: async (a: { functionName: string; blockNumber?: bigint }) => {
        seen.push([a.functionName, a.blockNumber]);
        return a.functionName === 'ownerOf' ? NFT : true;
      },
    };
    await expect(readPositionOwner(pinned, s, 9n, 77n)).rejects.toBeInstanceOf(PositionRetiredError);
    expect(seen).toEqual([['ownerOf', 77n], ['isPositionRetired', 77n]]);
    expect(await readPositionOwner(client({ ownerOf: NFT, isPositionRetired: false }), s, 9n)).toBe(NFT);
    expect(positionHolderFrom(NFT, true)).toBe('gone');
    expect(positionHolderFrom(NFT, false)).toBe(NFT);
  });

  it('an ownerOf revert reads as gone; a transport failure throws', async () => {
    const s = positionNftSurface({ diamond: DIAMOND, positionNFT: NFT });
    expect(await readPositionHolder(client({ ownerOf: revert(), isPositionRetired: false }), s, 1n)).toBe('gone');
    await expect(
      readPositionHolder(client({ ownerOf: new Error('fetch failed'), isPositionRetired: false }), s, 1n),
    ).rejects.toThrow('fetch failed');
  });
});
