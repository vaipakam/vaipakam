/**
 * "Your Vaipakam Vault" reads. Per asset the displayed numbers are:
 *   total  = min(raw ERC-20 balanceOf(vault), protocol-tracked)
 *            — unsolicited transfers never inflate anything (T-051)
 *   locked = getEncumbered(user, asset, 0)
 *   free   = total - locked (floored at 0)
 *
 * The asset list is best-effort: canonical per-chain tokens plus every
 * ERC-20 leg of the wallet's loans and open offers.
 */
import { useQuery } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
} from 'viem';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';
import { useActiveChain } from '../chain/useActiveChain';
import { AssetType } from '../lib/types';
import { useMyLoans, useMyOffers } from './hooks';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface VaultAssetRow {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  total: bigint;
  locked: bigint;
  free: bigint;
}

export interface VaultSnapshot {
  vaultAddress: `0x${string}` | null; // null = not created yet
  assets: VaultAssetRow[];
  /** Tokens whose reads FAILED this scan (transient RPC/metadata
   *  errors). Non-empty means the list may be missing real balances —
   *  the page must say so instead of looking complete. */
  unreadable: `0x${string}`[];
}

export function useVaultAssets() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const loans = useMyLoans();
  const offers = useMyOffers();
  // The candidate list depends on loans+offers — a failed dependency
  // must surface as UNAVAILABLE, not as a canonical-only scan that
  // renders an incomplete "where my assets sit" page.
  const depsUnavailable = loans.data === null || offers.data === null;
  const depsLoading =
    !depsUnavailable &&
    (loans.data === undefined || offers.data === undefined) &&
    Boolean(address);

  // Candidate ERC-20 set: canonical + every ERC-20 leg we know about.
  const candidates = new Set<string>(
    getCanonicalAssetsForChain(readChain.chainId).map((a) => a.toLowerCase()),
  );
  for (const loan of Array.isArray(loans.data) ? loans.data : []) {
    if (loan.assetType === AssetType.ERC20) candidates.add(loan.lendingAsset.toLowerCase());
    if (loan.collateralAssetType === AssetType.ERC20 && loan.collateralAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(loan.collateralAsset.toLowerCase());
    }
  }
  for (const offer of Array.isArray(offers.data) ? offers.data : []) {
    if (offer.assetType === AssetType.ERC20) candidates.add(offer.lendingAsset.toLowerCase());
    if (offer.collateralAssetType === AssetType.ERC20 && offer.collateralAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(offer.collateralAsset.toLowerCase());
    }
    if (offer.prepayAsset && offer.prepayAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(offer.prepayAsset.toLowerCase());
    }
  }
  const tokenList = [...candidates].sort();

  const query = useQuery({
    queryKey: ['vaultAssets', readChain.chainId, address?.toLowerCase(), tokenList.join(',')],
    enabled:
      Boolean(address) &&
      Boolean(publicClient) &&
      !depsUnavailable &&
      !depsLoading,
    refetchInterval: 30_000,
    queryFn: async (): Promise<VaultSnapshot> => {
      const vault = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserVaultAddress',
        args: [address!],
      })) as `0x${string}`;
      if (vault.toLowerCase() === ZERO_ADDRESS) {
        return { vaultAddress: null, assets: [], unreadable: [] };
      }

      // VPFI deposits arrive via the VPFI page, not via any loan or
      // offer, and VPFI isn't a canonical asset — without this the
      // vault of a VPFI-only depositor reads "empty".
      const scanTokens = [...tokenList];
      try {
        const vpfiToken = (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getVPFIToken',
        })) as string;
        if (
          vpfiToken.toLowerCase() !== ZERO_ADDRESS &&
          !scanTokens.includes(vpfiToken.toLowerCase())
        ) {
          scanTokens.push(vpfiToken.toLowerCase());
        }
      } catch (err) {
        // Only a REVERT/zero-data means "VPFI facet absent on this
        // chain" (skip the token, scan the rest). A transport failure
        // is not knowledge — swallowing it would render a VPFI-only
        // vault as "empty"; rethrow so the page shows unavailable.
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (!isRevert) throw err;
      }

      const unreadable: `0x${string}`[] = [];
      const rows = await Promise.all(
        scanTokens.map(async (tokenLower): Promise<VaultAssetRow | null> => {
          const token = tokenLower as `0x${string}`;
          try {
            const [raw, tracked, locked, symbol, decimals] = await Promise.all([
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [vault],
              }),
              publicClient!.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getProtocolTrackedVaultBalance',
                args: [address!, token],
              }) as Promise<bigint>,
              publicClient!.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getEncumbered',
                args: [address!, token, 0n],
              }) as Promise<bigint>,
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'symbol',
              }),
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'decimals',
              }),
            ]);
            const total = raw < tracked ? raw : tracked;
            const free = total > locked ? total - locked : 0n;
            if (total === 0n && locked === 0n) return null; // hide empty rows
            return { token, symbol, decimals, total, locked, free };
          } catch {
            // Don't sink the whole page on one bad token, but don't
            // pretend the scan was complete either — a transient read
            // failure on an asset backing a live position would make
            // locked funds silently vanish from "where my assets sit".
            unreadable.push(token);
            return null;
          }
        }),
      );

      const assets = rows
        .filter((r): r is VaultAssetRow => r !== null)
        .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
      return { vaultAddress: vault, assets, unreadable };
    },
  });

  return { ...query, depsUnavailable, depsLoading };
}
