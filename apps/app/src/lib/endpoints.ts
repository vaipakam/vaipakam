/**
 * Every network endpoint the connected app talks to, resolved from the
 * build configuration in ONE place (#43 / ET-017).
 *
 * Two readers need the same answer. The bundle reads it to know where to
 * send a request; the build reads it to write the page's
 * Content-Security-Policy `connect-src`, the list of hosts the page may
 * reach at all. If each kept its own copy, the first preview or
 * deployment pointed at another host would leave the policy describing a
 * different app from the one it ships with. So this module takes the
 * build's environment as an argument, never `import.meta.env` itself: the
 * app passes `import.meta.env`, and `vite.config.ts` passes the same
 * variables through `loadEnv`, which is what Vite compiles into the
 * bundle.
 *
 * Kept free of browser globals and package imports for the same reason:
 * the Vite config loads it in Node.
 */

/** The build environment, as `import.meta.env` or `loadEnv` gives it. */
export type BuildEnv = Readonly<Record<string, unknown>>;

/** A configured value, trimmed, or `null` when unset or empty. A copied
 *  `.env.example` sets its keys to empty strings, which must read as
 *  unset rather than as an endpoint called ''. */
function configured(env: BuildEnv, key: string): string | null {
  const v = env[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// ── Vaipakam's own Workers ───────────────────────────────────────────────

/** The indexer Worker's origin, or `null` when this build has none (list
 *  pages then say they could not load rather than show an empty market). */
export function indexerOrigin(env: BuildEnv): string | null {
  const url = configured(env, 'VITE_INDEXER_ORIGIN');
  return url === null ? null : withoutTrailingSlash(url);
}

/**
 * #757 Phase B — the origin of the indexer's realtime push channel. An
 * explicit `VITE_INDEXER_WS_ORIGIN` wins (an operator may front the socket
 * on another host); otherwise it is the indexer origin with its scheme
 * swapped. `null` = the channel is off and the app keeps polling.
 */
export function indexerWsOrigin(env: BuildEnv): string | null {
  const explicit = configured(env, 'VITE_INDEXER_WS_ORIGIN');
  if (explicit !== null) return withoutTrailingSlash(explicit);
  const http = indexerOrigin(env);
  if (http === null) return null;
  if (http.startsWith('https://')) return 'wss://' + http.slice('https://'.length);
  if (http.startsWith('http://')) return 'ws://' + http.slice('http://'.length);
  return null; // not an http origin, so no socket scheme can be derived
}

/** The agent Worker's origin (alerts, support, diagnostics erasure, the
 *  quote proxy), or `null` when this build has none; each feature then
 *  says it is not set up here and sends nothing. */
export function agentOrigin(env: BuildEnv): string | null {
  const url = configured(env, 'VITE_AGENT_ORIGIN');
  return url === null ? null : withoutTrailingSlash(url);
}

// ── Chain RPC ────────────────────────────────────────────────────────────

interface ChainRpc {
  rpcUrlEnvKey: string;
  rpcUrlDefault: string;
  /** Optional WebSocket RPC key; defaults to the RPC key with `_RPC_URL`
   *  swapped for `_WSS_URL`. A socket is opt-in per deploy: no default. */
  wsUrlEnvKey?: string;
}

/** Per-chain RPC configuration. The display metadata lives in
 *  `chain/chains.ts`; this table is only where the app connects. */
const CHAIN_RPC: Readonly<Record<number, ChainRpc>> = {
  1: { rpcUrlEnvKey: 'VITE_ETHEREUM_RPC_URL', rpcUrlDefault: 'https://ethereum-rpc.publicnode.com' },
  8453: { rpcUrlEnvKey: 'VITE_BASE_RPC_URL', rpcUrlDefault: 'https://mainnet.base.org' },
  42161: { rpcUrlEnvKey: 'VITE_ARBITRUM_RPC_URL', rpcUrlDefault: 'https://arb1.arbitrum.io/rpc' },
  10: { rpcUrlEnvKey: 'VITE_OPTIMISM_RPC_URL', rpcUrlDefault: 'https://mainnet.optimism.io' },
  56: { rpcUrlEnvKey: 'VITE_BNB_RPC_URL', rpcUrlDefault: 'https://bsc-dataseed.bnbchain.org' },
  84532: { rpcUrlEnvKey: 'VITE_BASE_SEPOLIA_RPC_URL', rpcUrlDefault: 'https://sepolia.base.org' },
  421614: {
    rpcUrlEnvKey: 'VITE_ARBITRUM_SEPOLIA_RPC_URL',
    rpcUrlDefault: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  97: {
    rpcUrlEnvKey: 'VITE_BNB_TESTNET_RPC_URL',
    rpcUrlDefault: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  },
};

/** The chain ids this module has RPC configuration for. */
export const RPC_CHAIN_IDS: readonly number[] = Object.keys(CHAIN_RPC).map(Number);

function chainRpc(chainId: number): ChainRpc {
  const rpc = CHAIN_RPC[chainId];
  if (!rpc) throw new Error(`no RPC configuration for chain ${chainId}`);
  return rpc;
}

/** A chain's HTTP RPC URL: the configured one, else the public default. */
export function rpcUrlFor(chainId: number, env: BuildEnv): string {
  const rpc = chainRpc(chainId);
  return configured(env, rpc.rpcUrlEnvKey) ?? rpc.rpcUrlDefault;
}

/** A chain's WebSocket RPC URL, or `undefined` when none is configured
 *  (the live layer then polls over HTTP). */
export function wsUrlFor(chainId: number, env: BuildEnv): string | undefined {
  const rpc = chainRpc(chainId);
  const key = rpc.wsUrlEnvKey ?? rpc.rpcUrlEnvKey.replace('_RPC_URL', '_WSS_URL');
  return configured(env, key) ?? undefined;
}

/** The ENS-read-only mainnet client's primary RPC: chain 1's, so ENS rides
 *  the same env-overridable plumbing as every other read. */
export function ensMainnetRpcUrl(env: BuildEnv): string {
  return rpcUrlFor(1, env);
}

/** The second public endpoint behind the ENS primary, so a throttled
 *  primary degrades to it instead of to a dropped name. dRPC's public
 *  gateway: maintained and CORS-open (cloudflare-eth.com is a deprecated
 *  legacy hostname, Codex #1084 r1). */
export const ENS_FALLBACK_RPC_URL = 'https://eth.drpc.org';

// ── Third-party APIs the app calls itself ────────────────────────────────

/** GoPlus token-security screen (`data/tokenSecurity.ts`). */
export const GOPLUS_ORIGIN = 'https://api.gopluslabs.io';

/** CoinGecko contract lookup for the token screen
 *  (`data/tokenReputation.ts`). */
export const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// ── Wallet SDKs ──────────────────────────────────────────────────────────

/** A host a wallet SDK connects to from the page, and why. */
export interface WalletSdkSource {
  source: string;
  why: string;
}

/** WalletConnect, wired only when the build has a project id. Telemetry is
 *  off in `chain/wagmi.ts`, so its event host (pulse) is not listed. */
export const WALLETCONNECT_SOURCES: readonly WalletSdkSource[] = [
  { source: 'wss://relay.walletconnect.org', why: 'the relay socket that pairing and every session message run over' },
  { source: 'https://verify.walletconnect.org', why: 'the Verify API, which tells the wallet which site is asking' },
  { source: 'https://rpc.walletconnect.org', why: "the SDK's own chain API, used by the session provider" },
];

/** Coinbase Wallet SDK (always wired). Telemetry is off in
 *  `chain/wagmi.ts`, so its analytics hosts are not listed. */
export const COINBASE_SOURCES: readonly WalletSdkSource[] = [
  { source: 'https://www.walletlink.org', why: 'WalletLink, the mobile-app pairing bridge (HTTP side)' },
  { source: 'wss://www.walletlink.org', why: 'WalletLink, the mobile-app pairing bridge (socket side)' },
  { source: 'https://rpc.wallet.coinbase.com', why: 'the smart-wallet signer asks it for the session permissions' },
];

/** The WalletConnect project id, or `null` when WalletConnect is off. */
export function walletConnectProjectId(env: BuildEnv): string | null {
  return configured(env, 'VITE_WALLETCONNECT_PROJECT_ID');
}

// ── The policy list ──────────────────────────────────────────────────────

/**
 * Every endpoint a build with `env`, serving `deployedChainIds`, may
 * connect to — the `connect-src` list the build writes into the page's
 * policy. Each entry is a URL on the endpoint; the policy reduces it to
 * its origin.
 *
 * In order: Vaipakam's own Workers that this build configures, the RPC
 * (and socket, when configured) of every deployed chain, the ENS-read
 * mainnet client and its fallback, the third-party APIs the app calls,
 * then the wallet SDKs' own hosts.
 */
export function connectSources(env: BuildEnv, deployedChainIds: readonly number[]): string[] {
  const out: string[] = [];
  for (const origin of [indexerOrigin(env), indexerWsOrigin(env), agentOrigin(env)]) {
    if (origin !== null) out.push(origin);
  }
  for (const chainId of deployedChainIds) {
    out.push(rpcUrlFor(chainId, env));
    const ws = wsUrlFor(chainId, env);
    if (ws !== undefined) out.push(ws);
  }
  // The ENS-read client exists only while chain 1 has no Diamond; a
  // deployed chain 1 reads through its own transport above.
  if (!deployedChainIds.includes(1)) {
    out.push(ensMainnetRpcUrl(env), ENS_FALLBACK_RPC_URL);
  }
  out.push(GOPLUS_ORIGIN, COINGECKO_API_BASE);
  if (walletConnectProjectId(env) !== null) {
    out.push(...WALLETCONNECT_SOURCES.map((s) => s.source));
  }
  out.push(...COINBASE_SOURCES.map((s) => s.source));
  return out;
}
