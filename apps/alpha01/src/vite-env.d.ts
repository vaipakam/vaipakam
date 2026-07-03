/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_CHAIN_ID: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_INDEXER_ORIGIN: string;
  readonly VITE_AGENT_ORIGIN: string;
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_ETHEREUM_RPC_URL?: string;
  readonly VITE_ARBITRUM_RPC_URL?: string;
  readonly VITE_OPTIMISM_RPC_URL?: string;
  readonly VITE_BNB_RPC_URL?: string;
  readonly VITE_BNB_TESTNET_RPC_URL?: string;
  readonly VITE_ARBITRUM_SEPOLIA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}