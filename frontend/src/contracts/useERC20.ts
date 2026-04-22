import { useMemo } from 'react';
import { Contract } from 'ethers';
import { useWallet } from '../context/WalletContext';

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

export function useERC20(tokenAddress: string | null) {
  const { signer } = useWallet();

  return useMemo(() => {
    if (!tokenAddress || !signer) return null;
    return new Contract(tokenAddress, ERC20_ABI, signer);
  }, [tokenAddress, signer]);
}
