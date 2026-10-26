/**
 * app chain registry — lean by design.
 *
 * A chain is "supported" when (and only when) the consolidated
 * deployments bundle (`@vaipakam/contracts/deployments`) carries a
 * Diamond for it. The static table below is display metadata only;
 * addresses always come from the bundle, so a redeploy flows through
 * with the next build and this file never holds an address.
 *
 * This intentionally carries far less than apps/defi's ChainConfig —
 * app adds fields when a page needs them, not before.
 */
import { getDeployment } from '@vaipakam/contracts/deployments';
import { rpcUrlFor, wsUrlFor } from '../lib/endpoints';

/** Display metadata. Where a chain is READ from (its RPC and optional
 *  WebSocket URL) is resolved by `lib/endpoints.ts`, which the build also
 *  reads to write the page's `connect-src` (#43), so the two cannot
 *  disagree. */
interface ChainMeta {
  chainId: number;
  name: string;
  blockExplorer: string;
  testnet: boolean;
  nativeGasSymbol: string;
}

/** Chains app knows how to describe. Order = display order
 *  (mainnets first, then testnets). A chain only becomes selectable
 *  when its Diamond is present in the deployments bundle. */
const CHAIN_META: readonly ChainMeta[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    blockExplorer: 'https://etherscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 8453,
    name: 'Base',
    blockExplorer: 'https://basescan.org',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 42161,
    name: 'Arbitrum',
    blockExplorer: 'https://arbiscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 10,
    name: 'Optimism',
    blockExplorer: 'https://optimistic.etherscan.io',
    testnet: false,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 56,
    name: 'BNB Chain',
    blockExplorer: 'https://bscscan.com',
    testnet: false,
    nativeGasSymbol: 'BNB',
  },
  {
    chainId: 84532,
    name: 'Base Sepolia',
    blockExplorer: 'https://sepolia.basescan.org',
    testnet: true,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    blockExplorer: 'https://sepolia.arbiscan.io',
    testnet: true,
    nativeGasSymbol: 'ETH',
  },
  {
    chainId: 97,
    name: 'BNB Testnet',
    blockExplorer: 'https://testnet.bscscan.com',
    testnet: true,
    nativeGasSymbol: 'BNB',
  },
];

export interface SupportedChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  /** WebSocket RPC URL when configured (opt-in); undefined otherwise. */
  wsUrl?: string;
  blockExplorer: string;
  testnet: boolean;
  nativeGasSymbol: string;
  diamondAddress: `0x${string}`;
  deployBlock: number;
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
        // A WebSocket URL, when configured, is preferred by the wagmi
        // transport (`eth_subscribe` newHeads drive live invalidation);
        // absent, the app polls over HTTP. Opt-in per deploy, no default.
        rpcUrl: rpcUrlFor(meta.chainId, import.meta.env),
        wsUrl: wsUrlFor(meta.chainId, import.meta.env),
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
    'app chains: deployments bundle contains no chain from CHAIN_META — ' +
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

/** Display name for ANY chain the app can describe — deliberately
 *  NOT deployment-gated like `getSupportedChain` (#2013 round 6): the
 *  support service verifies smart-account signatures on whatever
 *  chain the account lives on, deployment or not, and a confirmation
 *  naming that chain must be able to name e.g. Ethereum during the
 *  testnet phase. Null for a chain the catalog has no entry for. */
export function chainDisplayName(chainId: number | undefined): string | null {
  if (chainId === undefined) return null;
  return CHAIN_META.find((m) => m.chainId === chainId)?.name ?? null;
}

/** Where reads land when the wallet is disconnected or on an
 *  unsupported network: env override first, else the first supported
 *  mainnet, else the first supported chain (testnet phase). */
export const DEFAULT_CHAIN: SupportedChain = (() => {
  const envId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? NaN);
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
