import { type Address, type PublicClient, type WalletClient, parseAbi } from 'viem';
import { ASSET_TYPE_ERC1155 } from '../types/offers.js';

const ERC721_ABI = parseAbi([
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function getApproved(uint256 tokenId) view returns (address)',
]);

const ERC1155_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

export async function ensureNftRentalApproval(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  nftContract: Address;
  diamondAddress: Address;
  assetType: number;
  tokenId: bigint;
}) {
  const owner = opts.walletClient.account?.address as Address | undefined;
  if (!owner) throw new Error('Wallet not connected');

  if (opts.assetType === ASSET_TYPE_ERC1155) {
    const approved = (await opts.publicClient.readContract({
      address: opts.nftContract,
      abi: ERC1155_ABI,
      functionName: 'isApprovedForAll',
      args: [owner, opts.diamondAddress],
    })) as boolean;
    if (approved) return;
    const hash = await opts.walletClient.writeContract({
      address: opts.nftContract,
      abi: ERC1155_ABI,
      functionName: 'setApprovalForAll',
      args: [opts.diamondAddress, true],
      account: opts.walletClient.account!,
      chain: opts.walletClient.chain,
    });
    await opts.publicClient.waitForTransactionReceipt({ hash });
    return;
  }

  const approvedForAll = (await opts.publicClient.readContract({
    address: opts.nftContract,
    abi: ERC721_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, opts.diamondAddress],
  })) as boolean;
  if (approvedForAll) return;

  const approved = (await opts.publicClient.readContract({
    address: opts.nftContract,
    abi: ERC721_ABI,
    functionName: 'getApproved',
    args: [opts.tokenId],
  })) as Address;
  if (approved.toLowerCase() === opts.diamondAddress.toLowerCase()) return;

  const hash = await opts.walletClient.writeContract({
    address: opts.nftContract,
    abi: ERC721_ABI,
    functionName: 'approve',
    args: [opts.diamondAddress, opts.tokenId],
    account: opts.walletClient.account!,
    chain: opts.walletClient.chain,
  });
  await opts.publicClient.waitForTransactionReceipt({ hash });
}