/**
 * alpha02 chain registry — lean by design.
 *
 * A chain is "supported" when (and only when) the consolidated
 * deployments bundle (`@vaipakam/contracts/deployments`) carries a
 * Diamond for it. The static table below is display metadata only;
 * addresses always come from the bundle, so a redeploy flows through
 * with the next build and this file never holds an address.
 *
 * This intentionally carries far less than apps/defi's ChainConfig —
 * alpha02 adds fields when a page needs them, not before.
 */
import { getDeployment } from '@vaipakam/contracts/deployments';

const env = import.meta.env;

interface ChainMeta {
  chainId: number;
  name: string;
  rpcUrlEnvKey: string;
  rpcUrlDefault: string;
  blockExplorer: string;
  testnet: boolean;
  nativeGasSymbol: string;
}

/** Chains alpha02 knows how to describe. Order = display order
 *  (mainnets first, then testnets). A chain only becomes selectable
 *  when its Diamond is present in the deployments bundle. */
const CHAIN_META: readonly ChainMeta[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    rpcUrlEnvKey: 'VITE_ETHEREUM_RPC_URL',
    rpcUrlDefault: 'https://ethereum-rpc.publicnode.com',
    blockExplorer: 'https://etherscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 8453,
    name: 'Base',
    rpcUrlEnvKey: 'VITE_BASE_RPC_URL',
    rpcUrlDefault: 'https://mainnet.base.org',
    blockExplorer: 'https://basescan.org',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 42161,
    name: 'Arbitrum',
    rpcUrlEnvKey: 'VITE_ARBITRUM_RPC_URL',
    rpcUrlDefault: 'https://arb1.arbitrum.io/rpc',
    blockExplorer: 'https://arbiscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 10,
    name: 'Optimism',
    rpcUrlEnvKey: 'VITE_OPTIMISM_RPC_URL',
    rpcUrlDefault: 'https://mainnet.optimism.io',
    blockExplorer: 'https://optimistic.etherscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 56,
    name: 'BNB Chain',
    rpcUrlEnvKey: 'VITE_BNB_RPC_URL',
    rpcUrlDefault: 'https://bsc-dataseed.bnbchain.org',
    blockExplorer: 'https://bscscan.com',
    testnet: false,
    nativeGasSymbol: 'BNB',
  },
  {
    chainId: 84532,
    name: 'Base Sepolia',
    rpcUrlEnvKey: 'VITE_BASE_SEPOLIA_RPC_URL',
    rpcUrlDefault: 'https://sepolia.base.org',
    blockExplorer: 'https://sepolia.basescan.org',
    testnet: true,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    rpcUrlEnvKey: 'VITE_ARBITRUM_SEPOLIA_RPC_URL',
    rpcUrlDefault: 'https://sepolia-rollup.arbitrum.io/rpc',
    blockExplorer: 'https://sepolia.arbiscan.io',
    testnet: true,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 97,
    name: 'BNB Testnet',
    rpcUrlEnvKey: 'VITE_BNB_TESTNET_RPC_URL',
    rpcUrlDefault: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    blockExplorer: 'https://testnet.bscscan.com',
    testnet: true,
    nativeGasSymbol: 'BNB',
  },
];

export interface SupportedChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  blockExplorer: string;
  testnet: boolean;
  nativeGasSymbol: string;
  diamondAddress: `0x${string}`;
  deployBlock: number;
}

function rpcUrlFor(meta: ChainMeta): string {
  return (env[meta.rpcUrlEnvKey] as string | undefined) ?? meta.rpcUrlDefault;
}

/** Every chain with a live Diamond, in display order. */
export const SUPPORTED_CHAINS: readonly SupportedChain[] = CHAIN_META.flatMap(
  (meta) => {
    const deployment = getDeployment(meta.chainId);
    if (!deployment?.diamond) return [];
    return [
      {
        chainId: meta.chainId,
        name: meta.name,
        rpcUrl: rpcUrlFor(meta),
        blockExplorer: meta.blockExplorer,
        testnet: meta.testnet,
        nativeGasSymbol: meta.nativeGasSymbol,
        diamondAddress: deployment.diamond as `0x${string}`,
        deployBlock: deployment.deployBlock ?? 0,
      },
    ];
  },
);

if (SUPPORTED_CHAINS.length === 0) {
  throw new Error(
    'alpha02 chains: deployments bundle contains no chain from CHAIN_META — ' +
      'extend CHAIN_META when deploying to a new chain.',
  );
}

const BY_ID = new Map(SUPPORTED_CHAINS.map((c) => [c.chainId, c]));

export function getSupportedChain(
  chainId: number | undefined,
): SupportedChain | null {
  if (chainId === undefined) return null;
  return BY_ID.get(chainId) ?? null;
}

export function isSupportedChain(chainId: number | undefined): boolean {
  return chainId !== undefined && BY_ID.has(chainId);
}

/** Where reads land when the wallet is disconnected or on an
 *  unsupported network: env override first, else the first supported
 *  mainnet, else the first supported chain (testnet phase). */
export const DEFAULT_CHAIN: SupportedChain = (() => {
  const envId = Number(env.VITE_DEFAULT_CHAIN_ID ?? NaN);
  const fromEnv = Number.isFinite(envId) ? BY_ID.get(envId) : undefined;
  if (fromEnv) return fromEnv;
  return SUPPORTED_CHAINS.find((c) => !c.testnet) ?? SUPPORTED_CHAINS[0];
})();

/** Human list for "switch to a supported network" copy —
 *  e.g. "Base Sepolia, Arbitrum Sepolia or BNB Testnet". */
export function supportedChainNames(): string {
  const names = SUPPORTED_CHAINS.map((c) => c.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
