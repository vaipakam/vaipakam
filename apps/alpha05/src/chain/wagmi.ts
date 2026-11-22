/**
 * wagmi v2 + ConnectKit configuration. The transports here are the WORLD
 * and PRE-SIGN rails' fallback (the proxy, then the public endpoint); a
 * connected user's own state is read through the wallet's provider first
 * (`ownRail.ts`, RB-RAILS).
 *
 * Choices carried over from the connected app, each for a recorded reason:
 * the injected connector targets MetaMask directly (the SDK connector's
 * desktop detection is unreliable); WalletConnect is wired only with a
 * project id and with its telemetry off; Coinbase's SDK telemetry is off; the
 * Safe connector keeps `shimDisconnect` so a disconnect survives a reload.
 */
import { createConfig, fallback, http } from 'wagmi';
import type { Transport } from 'viem';
import { coinbaseWallet, injected, safe, walletConnect } from 'wagmi/connectors';
import {
  mainnet,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  arbitrum,
  arbitrumSepolia,
  optimism,
  type Chain,
} from 'wagmi/chains';
import { getDefaultConfig } from 'connectkit';
import { RPC_PROXY_MAX_BATCH } from '@vaipakam/lib/rpcProxyPolicy';
import { SUPPORTED_CHAINS } from './chains';
import type { RpcEndpoint } from './endpoints';

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || '';

const APP_NAME = 'Vaipakam';
const APP_DESCRIPTION =
  'Lend, borrow, and rent NFTs directly with other people. Your assets stay in your own on-chain vault.';
const APP_URL = typeof window !== 'undefined' ? window.location.origin : 'https://app.vaipakam.com';
const APP_ICON = `${APP_URL}/logo.svg`;

const CHAIN_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [optimism.id]: optimism,
};

const chains: Chain[] = [];
for (const c of SUPPORTED_CHAINS) {
  const viemChain = CHAIN_BY_ID[c.chainId];
  // A deployed chain with no viem chain object would be "supported" with no
  // client behind it: every read disabled, every write throwing. Loud.
  if (!viemChain) throw new Error(`alpha05 wagmi: deployed chain ${c.chainId} (${c.name}) has no viem chain object.`);
  chains.push(viemChain);
}

/** The proxy's route is batched within the proxy's cap and not retried (a
 *  refusal will not change in a second; the public endpoint behind it is the
 *  retry). A public endpoint keeps viem's defaults. */
export function httpTransports(endpoints: readonly RpcEndpoint[]): Transport {
  const list = endpoints.map((e) =>
    e.viaProxy ? http(e.url, { batch: { batchSize: RPC_PROXY_MAX_BATCH }, retryCount: 0 }) : http(e.url, { batch: true }),
  );
  return list.length === 1 ? list[0]! : fallback(list);
}

const transports: Record<number, Transport> = {};
for (const c of SUPPORTED_CHAINS) transports[c.chainId] = httpTransports(c.rpcEndpoints);

type NonEmptyChains = readonly [Chain, ...Chain[]];

const defaultConfig = getDefaultConfig({
  chains: chains as unknown as NonEmptyChains,
  transports,
  walletConnectProjectId: WC_PROJECT_ID,
  appName: APP_NAME,
  appDescription: APP_DESCRIPTION,
  appUrl: APP_URL,
  appIcon: APP_ICON,
  enableAaveAccount: false,
  ssr: false,
});

export const wagmiConfig = createConfig({
  ...defaultConfig,
  connectors: [
    injected({ target: 'metaMask' }),
    coinbaseWallet({
      appName: APP_NAME,
      appLogoUrl: APP_ICON,
      preference: { options: 'all', telemetry: false },
    }),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            showQrModal: false,
            telemetryEnabled: false,
            metadata: {
              name: APP_NAME,
              description: APP_DESCRIPTION,
              url: APP_URL,
              icons: [APP_ICON],
              redirect: { universal: APP_URL },
            },
          }),
        ]
      : []),
    safe({
      allowedDomains: [/app\.safe\.global$/, /safe\.global$/],
      debug: false,
      shimDisconnect: true,
    }),
  ],
});
