/// <reference types="vite/client" />

/** The `VITE_*` variables this build reads. Every one is optional: a missing
 *  value is a stated posture (no indexer, no proxy), never a crash, and the
 *  build-time guards in vite.config.ts refuse the combinations that would
 *  ship a key or serve a mainnet unproxied. */
interface ImportMetaEnv {
  readonly VITE_BUILD_HASH?: string;
  readonly VITE_BUILD_TIME?: string;
  readonly VITE_INDEXER_ORIGIN?: string;
  readonly VITE_AGENT_ORIGIN?: string;
  readonly VITE_RPC_PROXY_ORIGIN?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_DEFAULT_CHAIN_ID?: string;
}
