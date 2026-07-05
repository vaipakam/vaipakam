/**
 * Minimal NFT surface for the rental flows: ownership checks (so the
 * checklist can say "you own this NFT" before any gas is spent) and
 * the collection-level approval the Diamond needs to pull the NFT
 * into vault custody at offer creation.
 */
import { parseAbi } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient, useReadContract } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { AssetType } from '../lib/types';
import { isAddressLike } from './erc20';

const NFT_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

/** ERC-165 interface id for IERC4907 (rentable-NFT user rights). */
const IERC4907_INTERFACE_ID = '0xad092b5c' as const;

export type NftStandard = typeof AssetType.ERC721 | typeof AssetType.ERC1155;

/** Does the connected wallet own (enough of) this NFT? `undefined`
 *  while loading, `null` when the contract/token can't be read (wrong
 *  address, wrong standard — the checklist reports that plainly). */
export function useNftOwnership(
  contract: string,
  standard: NftStandard,
  tokenId: string,
  quantity: string,
) {
  const { address, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const idValid = tokenId !== '' && /^\d+$/.test(tokenId);
  const enabled =
    isAddressLike(contract) && idValid && Boolean(address) && Boolean(publicClient);

  return useQuery({
    queryKey: [
      'nftOwnership',
      walletChain?.chainId,
      contract.toLowerCase(),
      standard,
      tokenId,
      quantity,
      address?.toLowerCase(),
    ],
    enabled,
    queryFn: async (): Promise<boolean | null> => {
      try {
        if (standard === AssetType.ERC721) {
          const owner = await publicClient!.readContract({
            address: contract as `0x${string}`,
            abi: NFT_ABI,
            functionName: 'ownerOf',
            args: [BigInt(tokenId)],
          });
          return owner.toLowerCase() === address!.toLowerCase();
        }
        const balance = await publicClient!.readContract({
          address: contract as `0x${string}`,
          abi: NFT_ABI,
          functionName: 'balanceOf',
          args: [address!, BigInt(tokenId)],
        });
        const needed = BigInt(quantity || '1');
        return balance >= (needed > 0n ? needed : 1n);
      } catch {
        return null;
      }
    },
  });
}

/** Does this ERC-721 collection implement IERC4907 (on-chain renter
 *  rights)? The vault rents non-4907 NFTs too — it keeps its own renter
 *  registry and only FORWARDS setUser when the collection supports it
 *  (VaipakamVaultImplementation.setUser) — so `false` is a heads-up,
 *  not a blocker: apps outside Vaipakam won't see the renter.
 *  `undefined` while loading, `null` when the read failed. */
export function useNftRentalSupport(contract: string, standard: NftStandard) {
  const { walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const enabled =
    standard === AssetType.ERC721 && isAddressLike(contract) && Boolean(publicClient);

  return useQuery({
    queryKey: ['nftRentalSupport', walletChain?.chainId, contract.toLowerCase()],
    enabled,
    queryFn: async (): Promise<boolean | null> => {
      try {
        return await publicClient!.readContract({
          address: contract as `0x${string}`,
          abi: NFT_ABI,
          functionName: 'supportsInterface',
          args: [IERC4907_INTERFACE_ID],
        });
      } catch {
        // ERC-721 mandates ERC-165, so a revert usually means "no such
        // method" → effectively unsupported; transport failures land
        // here too, so report "couldn't check" rather than a hard no.
        return null;
      }
    },
  });
}

/** LIVE ownership re-read for submit paths — the checklist's cached
 *  query can be stale if the NFT was transferred/sold after review.
 *  Throws on transport failure (fail closed: nothing has been sent
 *  yet, so blocking on an unreadable chain is free). */
export async function readNftOwnershipLive(opts: {
  publicClient: PublicClient;
  contract: `0x${string}`;
  standard: NftStandard;
  tokenId: string;
  quantity: string;
  owner: `0x${string}`;
}): Promise<boolean> {
  const { publicClient, contract, standard, tokenId, quantity, owner } = opts;
  if (standard === AssetType.ERC721) {
    const current = await publicClient.readContract({
      address: contract,
      abi: NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    });
    return current.toLowerCase() === owner.toLowerCase();
  }
  const balance = await publicClient.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: 'balanceOf',
    args: [owner, BigInt(tokenId)],
  });
  const needed = BigInt(quantity || '1');
  return balance >= (needed > 0n ? needed : 1n);
}

/** Grant the Diamond collection-level transfer approval when it
 *  doesn't already have it (both 721 and 1155 use the same surface). */
export async function ensureNftApproval(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  contract: `0x${string}`;
  owner: `0x${string}`;
  operator: `0x${string}`;
  /** Called immediately before the setApprovalForAll prompt (skipped
   *  entirely when the collection is already approved) — drives the
   *  "step x of y" submit-progress label (#1037). */
  onPrompt?: () => void;
}): Promise<void> {
  const { publicClient, walletClient, contract, owner, operator, onPrompt } = opts;
  const already = await publicClient.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, operator],
  });
  if (already) return;
  onPrompt?.();
  const hash = await walletClient.writeContract({
    address: contract,
    abi: NFT_ABI,
    functionName: 'setApprovalForAll',
    args: [operator, true],
    account: owner,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`NFT approval failed (${hash})`);
  }
}


/** One-shot operator-approval read for runtime prompt planning
 *  (#1037). `undefined` = read failed → callers plan the prompt in. */
export async function readNftOperatorApproval(opts: {
  publicClient: PublicClient;
  contract: `0x${string}`;
  owner: `0x${string}`;
  operator: `0x${string}`;
}): Promise<boolean | undefined> {
  try {
    return await opts.publicClient.readContract({
      address: opts.contract,
      abi: NFT_ABI,
      functionName: 'isApprovedForAll',
      args: [opts.owner, opts.operator],
    });
  } catch {
    return undefined;
  }
}

/** Reactive operator-approval read for the review-screen prompt
 *  roadmap (#1037). */
export function useNftOperatorApproval(opts: {
  chainId: number | undefined;
  contract: `0x${string}` | undefined;
  owner: `0x${string}` | undefined;
  operator: `0x${string}` | undefined;
}) {
  return useReadContract({
    chainId: opts.chainId,
    address: opts.contract,
    abi: NFT_ABI,
    functionName: 'isApprovedForAll',
    args: opts.owner && opts.operator ? [opts.owner, opts.operator] : undefined,
    query: {
      enabled: Boolean(opts.chainId && opts.contract && opts.owner && opts.operator),
    },
  });
}
