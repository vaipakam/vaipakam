/**
 * The chains this app serves. A chain is supported when, and only when, the
 * committed deployments bundle carries a Diamond for it: a redeploy flows
 * through with the next build and this file never holds an address. One
 * Diamond per chain for its life on a mainnet (owner decision 2026-11-05);
 * a testnet reset by a fresh deploy carries nothing over, so a retired
 * Diamond is simply absent here (ACC-65).
 */
import { getDeployment } from '@vaipakam/contracts/deployments';
import { isMainnetChain, rpcEndpointsFor, type RpcEndpoint } from './endpoints';

interface ChainMeta {
  chainId: number;
  name: string;
  blockExplorer: string;
  nativeGasSymbol: string;
}

/** Display metadata; order is display order (mainnets first). */
const CHAIN_META: readonly ChainMeta[] = [
  { chainId: 1, name: 'Ethereum', blockExplorer: 'https://etherscan.io', nativeGasSymbol: 'ETH' },
  { chainId: 8453, name: 'Base', blockExplorer: 'https://basescan.org', nativeGasSymbol: 'ETH' },
  { chainId: 42161, name: 'Arbitrum', blockExplorer: 'https://arbiscan.io', nativeGasSymbol: 'ETH' },
  { chainId: 10, name: 'Optimism', blockExplorer: 'https://optimistic.etherscan.io', nativeGasSymbol: 'ETH' },
  { chainId: 56, name: 'BNB Chain', blockExplorer: 'https://bscscan.com', nativeGasSymbol: 'BNB' },
  { chainId: 84532, name: 'Base Sepolia', blockExplorer: 'https://sepolia.basescan.org', nativeGasSymbol: 'ETH' },
  { chainId: 421614, name: 'Arbitrum Sepolia', blockExplorer: 'https://sepolia.arbiscan.io', nativeGasSymbol: 'ETH' },
  { chainId: 97, name: 'BNB Testnet', blockExplorer: 'https://testnet.bscscan.com', nativeGasSymbol: 'BNB' },
];

export interface SupportedChain {
  chainId: number;
  name: string;
  rpcEndpoints: readonly RpcEndpoint[];
  blockExplorer: string;
  testnet: boolean;
  nativeGasSymbol: string;
  diamondAddress: `0x${string}`;
  deployBlock: number;
}

export const SUPPORTED_CHAINS: readonly SupportedChain[] = CHAIN_META.flatMap((meta) => {
  const deployment = getDeployment(meta.chainId);
  if (!deployment?.diamond) return [];
  return [
    {
      chainId: meta.chainId,
      name: meta.name,
      rpcEndpoints: rpcEndpointsFor(meta.chainId, import.meta.env),
      blockExplorer: meta.blockExplorer,
      testnet: !isMainnetChain(meta.chainId),
      nativeGasSymbol: meta.nativeGasSymbol,
      diamondAddress: deployment.diamond as `0x${string}`,
      deployBlock: deployment.deployBlock ?? 0,
    },
  ];
});

if (SUPPORTED_CHAINS.length === 0) {
  throw new Error('alpha05 chains: the deployments bundle carries no chain from CHAIN_META.');
}

const BY_ID = new Map(SUPPORTED_CHAINS.map((c) => [c.chainId, c]));

export function getSupportedChain(chainId: number | undefined): SupportedChain | null {
  if (chainId === undefined) return null;
  return BY_ID.get(chainId) ?? null;
}

/** Where reads land with no wallet, or on an unsupported network: the env
 *  override, else the first supported mainnet, else the first testnet. */
export const DEFAULT_CHAIN: SupportedChain = (() => {
  const envId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? NaN);
  const fromEnv = Number.isFinite(envId) ? BY_ID.get(envId) : undefined;
  if (fromEnv) return fromEnv;
  return SUPPORTED_CHAINS.find((c) => !c.testnet) ?? SUPPORTED_CHAINS[0]!;
})();

export function supportedChainNames(): string {
  const names = SUPPORTED_CHAINS.map((c) => c.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
