import { getAddress, isAddress } from 'viem';
import { getDeployment, type Deployment } from '@vaipakam/contracts/deployments';
import type { ChainConfig } from '@vaipakam/contracts/chain-config';
export type { ChainConfig } from '@vaipakam/contracts/chain-config';
export { compareChainsForDisplay } from '@vaipakam/contracts/chain-config';

export type EnvGetter = (key: string) => string | undefined;

interface ChainMeta {
  chainId: number;
  chainIdHex: string;
  name: string;
  shortName: string;
  rpcUrlEnvKey: string;
  rpcUrlDefault: string;
  blockExplorer: string;
  isCanonicalVPFI: boolean;
  testnet: boolean;
  nativeGasSymbol: string;
  wrappedNativeAddress?: string | null;
  predominantStableAddress?: string | null;
}

const INDEXER_ONLY_CHAIN_IDS = new Set<number>([97]);

function normalizeAddress(addr: string | null): string | null {
  if (addr == null) return null;
  const trimmed = addr.trim();
  if (trimmed.length === 0) return null;
  if (!isAddress(trimmed.toLowerCase(), { strict: false })) {
    throw new Error(`Invalid address in env: ${addr}`);
  }
  return getAddress(trimmed.toLowerCase());
}

function buildChainConfig(getEnv: EnvGetter, meta: ChainMeta): ChainConfig {
  const dep: Deployment | undefined = getDeployment(meta.chainId);
  const userFacingDiamond = INDEXER_ONLY_CHAIN_IDS.has(meta.chainId)
    ? null
    : (dep?.diamond ?? null);
  return {
    chainId: meta.chainId,
    chainIdHex: meta.chainIdHex,
    name: meta.name,
    shortName: meta.shortName,
    rpcUrl: getEnv(meta.rpcUrlEnvKey) ?? meta.rpcUrlDefault,
    blockExplorer: meta.blockExplorer,
    diamondAddress: userFacingDiamond,
    deployBlock: dep?.deployBlock ?? 0,
    isCanonicalVPFI: meta.isCanonicalVPFI,
    testnet: meta.testnet,
    metricsFacetAddress: dep?.facets?.metricsFacet ?? null,
    vaultImplAddress: dep?.vaultImpl ?? null,
    riskFacetAddress: dep?.facets?.riskFacet ?? null,
    profileFacetAddress: dep?.facets?.profileFacet ?? null,
    nativeGasSymbol: meta.nativeGasSymbol,
    nativeGasCoinGeckoSlug: meta.testnet ? 'ethereum' : 'ethereum',
    bridgedWethCoinGeckoSlug: null,
    wrappedNativeAddress: meta.wrappedNativeAddress ?? null,
    bridgedWethAddress: null,
    predominantStableAddress: meta.predominantStableAddress ?? null,
  };
}

const CHAIN_METAS: ChainMeta[] = [
  { chainId: 1, chainIdHex: '0x1', name: 'Ethereum', shortName: 'eth', rpcUrlEnvKey: 'VITE_ETHEREUM_RPC_URL', rpcUrlDefault: 'https://eth.llamarpc.com', blockExplorer: 'https://etherscan.io', isCanonicalVPFI: false, testnet: false, nativeGasSymbol: 'ETH' },
  { chainId: 8453, chainIdHex: '0x2105', name: 'Base', shortName: 'base', rpcUrlEnvKey: 'VITE_BASE_RPC_URL', rpcUrlDefault: 'https://mainnet.base.org', blockExplorer: 'https://basescan.org', isCanonicalVPFI: true, testnet: false, nativeGasSymbol: 'ETH' },
  { chainId: 84532, chainIdHex: '0x14a34', name: 'Base Sepolia', shortName: 'base-sep', rpcUrlEnvKey: 'VITE_BASE_SEPOLIA_RPC_URL', rpcUrlDefault: 'https://sepolia.base.org', blockExplorer: 'https://sepolia.basescan.org', isCanonicalVPFI: true, testnet: true, nativeGasSymbol: 'ETH', wrappedNativeAddress: '0x4200000000000000000000000000000000000006', predominantStableAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  { chainId: 11155111, chainIdHex: '0xaa36a7', name: 'Sepolia', shortName: 'sep', rpcUrlEnvKey: 'VITE_SEPOLIA_RPC_URL', rpcUrlDefault: 'https://ethereum-sepolia-rpc.publicnode.com', blockExplorer: 'https://sepolia.etherscan.io', isCanonicalVPFI: false, testnet: true, nativeGasSymbol: 'ETH' },
  { chainId: 42161, chainIdHex: '0xa4b1', name: 'Arbitrum', shortName: 'arb', rpcUrlEnvKey: 'VITE_ARBITRUM_RPC_URL', rpcUrlDefault: 'https://arb1.arbitrum.io/rpc', blockExplorer: 'https://arbiscan.io', isCanonicalVPFI: false, testnet: false, nativeGasSymbol: 'ETH' },
  { chainId: 421614, chainIdHex: '0x66eee', name: 'Arbitrum Sepolia', shortName: 'arb-sep', rpcUrlEnvKey: 'VITE_ARBITRUM_SEPOLIA_RPC_URL', rpcUrlDefault: 'https://sepolia-rollup.arbitrum.io/rpc', blockExplorer: 'https://sepolia.arbiscan.io', isCanonicalVPFI: false, testnet: true, nativeGasSymbol: 'ETH' },
  { chainId: 10, chainIdHex: '0xa', name: 'Optimism', shortName: 'op', rpcUrlEnvKey: 'VITE_OPTIMISM_RPC_URL', rpcUrlDefault: 'https://mainnet.optimism.io', blockExplorer: 'https://optimistic.etherscan.io', isCanonicalVPFI: false, testnet: false, nativeGasSymbol: 'ETH' },
  { chainId: 56, chainIdHex: '0x38', name: 'BNB Chain', shortName: 'bnb', rpcUrlEnvKey: 'VITE_BNB_RPC_URL', rpcUrlDefault: 'https://bsc-dataseed.binance.org', blockExplorer: 'https://bscscan.com', isCanonicalVPFI: false, testnet: false, nativeGasSymbol: 'BNB' },
  { chainId: 97, chainIdHex: '0x61', name: 'BNB Testnet', shortName: 'bnb-test', rpcUrlEnvKey: 'VITE_BNB_TESTNET_RPC_URL', rpcUrlDefault: 'https://data-seed-prebsc-1-s1.binance.org:8545', blockExplorer: 'https://testnet.bscscan.com', isCanonicalVPFI: false, testnet: true, nativeGasSymbol: 'BNB' },
];

export interface ChainModule {
  CHAIN_REGISTRY: Record<number, ChainConfig>;
  DEFAULT_CHAIN: ChainConfig;
  getChainByChainId: (chainId: number | null | undefined) => ChainConfig | undefined;
  isChainSupported: (chainId: number | null | undefined) => boolean;
}

export function createChainModule(getEnv: EnvGetter): ChainModule {
  const chains = CHAIN_METAS.map((m) => buildChainConfig(getEnv, m));
  for (const c of chains) {
    c.diamondAddress = normalizeAddress(c.diamondAddress);
    c.metricsFacetAddress = normalizeAddress(c.metricsFacetAddress);
    c.vaultImplAddress = normalizeAddress(c.vaultImplAddress);
    c.riskFacetAddress = normalizeAddress(c.riskFacetAddress);
    c.profileFacetAddress = normalizeAddress(c.profileFacetAddress);
  }

  const CHAIN_REGISTRY: Record<number, ChainConfig> = {};
  for (const c of chains) CHAIN_REGISTRY[c.chainId] = c;

  const envDefault = Number(getEnv('VITE_DEFAULT_CHAIN_ID') ?? '84532');
  const DEFAULT_CHAIN =
    (Number.isFinite(envDefault) && CHAIN_REGISTRY[envDefault]?.diamondAddress
      ? CHAIN_REGISTRY[envDefault]
      : null) ??
    chains.find((c) => c.diamondAddress) ??
    chains[0];

  return {
    CHAIN_REGISTRY,
    DEFAULT_CHAIN,
    getChainByChainId(chainId) {
      if (chainId == null) return undefined;
      return CHAIN_REGISTRY[chainId];
    },
    isChainSupported(chainId) {
      const c = CHAIN_REGISTRY[chainId ?? -1];
      return c !== undefined && c.diamondAddress !== null;
    },
  };
}