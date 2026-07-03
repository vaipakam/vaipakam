import { getAddress, isAddress } from 'viem';

/** Block-explorer URL for a contract or wallet address. */
export function contractExplorerUrl(blockExplorer: string, address: string): string | null {
  const base = blockExplorer.replace(/\/$/, '');
  if (!isAddress(address, { strict: false })) return null;
  return `${base}/address/${getAddress(address.toLowerCase())}`;
}

/** Block-explorer URL for a transaction hash. */
export function txExplorerUrl(blockExplorer: string, txHash: string): string | null {
  const base = blockExplorer.replace(/\/$/, '');
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
  return `${base}/tx/${txHash}`;
}