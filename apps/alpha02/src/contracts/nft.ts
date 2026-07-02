/**
 * Minimal NFT surface for the rental flows: ownership checks (so the
 * checklist can say "you own this NFT" before any gas is spent) and
 * the collection-level approval the Diamond needs to pull the NFT
 * into vault custody at offer creation.
 */
import { parseAbi } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
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

/** Grant the Diamond collection-level transfer approval when it
 *  doesn't already have it (both 721 and 1155 use the same surface). */
export async function ensureNftApproval(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  contract: `0x${string}`;
  owner: `0x${string}`;
  operator: `0x${string}`;
}): Promise<void> {
  const { publicClient, walletClient, contract, owner, operator } = opts;
  const already = await publicClient.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, operator],
  });
  if (already) return;
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
