import { createConfig, http } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import {
  mainnet,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  arbitrum,
  arbitrumSepolia,
  optimism,
  sepolia,
  type Chain,
} from 'wagmi/chains';
import { getDefaultConfig } from 'connectkit';
import { CHAIN_REGISTRY } from './chains';

const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim();
const APP_NAME = 'Vaipakam';
const APP_URL = typeof window !== 'undefined' ? window.location.origin : 'https://alpha01.vaipakam.com';
const APP_ICON = `${APP_URL}/logo-light.png`;

const CHAIN_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [optimism.id]: optimism,
  [sepolia.id]: sepolia,
};

const supportedChains = Object.values(CHAIN_REGISTRY)
  .map((c) => CHAIN_BY_ID[c.chainId])
  .filter((c): c is Chain => Boolean(c));

const transports: Record<number, ReturnType<typeof http>> = {};
for (const c of Object.values(CHAIN_REGISTRY)) {
  if (CHAIN_BY_ID[c.chainId]) transports[c.chainId] = http(c.rpcUrl);
}

type NonEmptyChains = readonly [Chain, ...Chain[]];

const defaultConnectKitConfig = getDefaultConfig({
  chains: supportedChains as unknown as NonEmptyChains,
  transports,
  walletConnectProjectId: WC_PROJECT_ID,
  appName: APP_NAME,
  appDescription: 'Borrow, lend, and rent on Vaipakam.',
  appUrl: APP_URL,
  appIcon: APP_ICON,
  enableAaveAccount: false,
  ssr: false,
});

export const wagmiConfig = createConfig({
  ...defaultConnectKitConfig,
  connectors: [
    injected({ target: 'metaMask' }),
    coinbaseWallet({ appName: APP_NAME, appLogoUrl: APP_ICON }),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            showQrModal: false,
            metadata: {
              name: APP_NAME,
              description: 'Borrow, lend, and rent on Vaipakam.',
              url: APP_URL,
              icons: [APP_ICON],
              redirect: { universal: APP_URL },
            },
          }),
        ]
      : []),
  ],
});

export const walletConnectConfigured = WC_PROJECT_ID.length > 0;