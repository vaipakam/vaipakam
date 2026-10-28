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

/**
 * The read-only RPC proxy's origin (#1724), or `null` when this build reads
 * chains directly.
 *
 * A provider URL set in a `VITE_*` variable ships in the bundle, key and
 * all: Vite compiles the whole `import.meta.env` object in wherever it is
 * passed, so a configured key is readable by anyone who opens the page,
 * whether or not a request ever uses it. The proxy (`apps/rpc-proxy`) holds
 * the keys as Worker secrets instead, so a build that sets this carries the
 * proxy's origin and no key. {@link rpcConfigProblems} refuses a build that
 * sets both.
 */
export function rpcProxyOrigin(env: BuildEnv): string | null {
  const url = configured(env, 'VITE_RPC_PROXY_ORIGIN');
  return url === null ? null : withoutTrailingSlash(url);
}

interface ChainRpc {
  rpcUrlEnvKey: string;
  rpcUrlDefault: string;
  /** Whether the chain carries real value. A build serving one must read
   *  through the proxy (pinned against `chain/chains.ts` by a test). */
  mainnet: boolean;
  /** Optional WebSocket RPC key; defaults to the RPC key with `_RPC_URL`
   *  swapped for `_WSS_URL`. A socket is opt-in per deploy: no default. */
  wsUrlEnvKey?: string;
}

/** Per-chain RPC configuration. The display metadata lives in
 *  `chain/chains.ts`; this table is only where the app connects. */
const CHAIN_RPC: Readonly<Record<number, ChainRpc>> = {
  1: { rpcUrlEnvKey: 'VITE_ETHEREUM_RPC_URL', rpcUrlDefault: 'https://ethereum-rpc.publicnode.com', mainnet: true },
  8453: { rpcUrlEnvKey: 'VITE_BASE_RPC_URL', rpcUrlDefault: 'https://mainnet.base.org', mainnet: true },
  42161: { rpcUrlEnvKey: 'VITE_ARBITRUM_RPC_URL', rpcUrlDefault: 'https://arb1.arbitrum.io/rpc', mainnet: true },
  10: { rpcUrlEnvKey: 'VITE_OPTIMISM_RPC_URL', rpcUrlDefault: 'https://mainnet.optimism.io', mainnet: true },
  56: { rpcUrlEnvKey: 'VITE_BNB_RPC_URL', rpcUrlDefault: 'https://bsc-dataseed.bnbchain.org', mainnet: true },
  84532: { rpcUrlEnvKey: 'VITE_BASE_SEPOLIA_RPC_URL', rpcUrlDefault: 'https://sepolia.base.org', mainnet: false },
  421614: {
    rpcUrlEnvKey: 'VITE_ARBITRUM_SEPOLIA_RPC_URL',
    rpcUrlDefault: 'https://sepolia-rollup.arbitrum.io/rpc',
    mainnet: false,
  },
  97: {
    rpcUrlEnvKey: 'VITE_BNB_TESTNET_RPC_URL',
    rpcUrlDefault: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    mainnet: false,
  },
};

/** The chain ids this module has RPC configuration for. */
export const RPC_CHAIN_IDS: readonly number[] = Object.keys(CHAIN_RPC).map(Number);

function chainRpc(chainId: number): ChainRpc {
  const rpc = CHAIN_RPC[chainId];
  if (!rpc) throw new Error(`no RPC configuration for chain ${chainId}`);
  return rpc;
}

function wsUrlEnvKey(rpc: ChainRpc): string {
  return rpc.wsUrlEnvKey ?? rpc.rpcUrlEnvKey.replace('_RPC_URL', '_WSS_URL');
}

/** Whether `chainId` carries real value. */
export function isMainnetChain(chainId: number): boolean {
  return chainRpc(chainId).mainnet;
}

/** One HTTP endpoint a chain's reads go to. `viaProxy` marks the proxy's
 *  route, whose batch size the transport must keep within the proxy's cap. */
export interface RpcEndpoint {
  url: string;
  viaProxy: boolean;
}

/**
 * A chain's HTTP RPC endpoints, in the order the app tries them.
 *
 *   - Through the proxy: the proxy's route for the chain, then the chain's
 *     keyless public default, so a proxy that is down, over budget or not
 *     configured for the chain degrades the app to today's public reads
 *     instead of to no reads.
 *   - Direct: the configured URL, else the public default.
 */
export function rpcEndpointsFor(chainId: number, env: BuildEnv): readonly RpcEndpoint[] {
  const rpc = chainRpc(chainId);
  const proxy = rpcProxyOrigin(env);
  if (proxy !== null) {
    return [
      { url: `${proxy}/rpc/${chainId}`, viaProxy: true },
      { url: rpc.rpcUrlDefault, viaProxy: false },
    ];
  }
  return [{ url: configured(env, rpc.rpcUrlEnvKey) ?? rpc.rpcUrlDefault, viaProxy: false }];
}

/** A chain's WebSocket RPC URL, or `undefined` when none is configured
 *  (the live layer then polls over HTTP). Always `undefined` through the
 *  proxy, which forwards no socket: a socket URL carries a key too. */
export function wsUrlFor(chainId: number, env: BuildEnv): string | undefined {
  if (rpcProxyOrigin(env) !== null) return undefined;
  return configured(env, wsUrlEnvKey(chainRpc(chainId))) ?? undefined;
}

/** The second public endpoint behind the ENS primary. dRPC's public
 *  gateway: maintained and CORS-open (cloudflare-eth.com is a deprecated
 *  legacy hostname, Codex #1084 r1). */
export const ENS_FALLBACK_RPC_URL = 'https://eth.drpc.org';

/** The ENS-read-only mainnet client's endpoints: chain 1's, so ENS rides the
 *  same plumbing as every other read, then a second public endpoint so a
 *  throttled one degrades to it instead of to a dropped name. */
export function ensMainnetRpcEndpoints(env: BuildEnv): readonly RpcEndpoint[] {
  const chain1 = rpcEndpointsFor(1, env);
  return chain1.some((e) => e.url === ENS_FALLBACK_RPC_URL)
    ? chain1
    : [...chain1, { url: ENS_FALLBACK_RPC_URL, viaProxy: false }];
}

/**
 * Why this build's RPC configuration must not ship, or `[]` when it may.
 * The production build refuses on any entry (`vite.config.ts`).
 *
 *   - Through the proxy, a per-chain RPC or socket URL is refused: it would
 *     ship in the bundle unused, and it is exactly the key the proxy exists
 *     to keep out of it.
 *   - A build serving a mainnet chain must read through the proxy (owner
 *     decision on #1724: the proxy before mainnet, on Workers Paid).
 */
export function rpcConfigProblems(env: BuildEnv, deployedChainIds: readonly number[]): string[] {
  const problems: string[] = [];
  if (rpcProxyOrigin(env) !== null) {
    for (const rpc of Object.values(CHAIN_RPC)) {
      for (const key of [rpc.rpcUrlEnvKey, wsUrlEnvKey(rpc)]) {
        if (configured(env, key) !== null) {
          problems.push(
            `${key} is set while VITE_RPC_PROXY_ORIGIN routes reads through the proxy; ` +
              'a provider URL in the build environment ships in the bundle whether or not it is used. Unset it.',
          );
        }
      }
    }
  } else {
    for (const chainId of deployedChainIds) {
      if (CHAIN_RPC[chainId]?.mainnet) {
        problems.push(
          `chain ${chainId} is a mainnet and VITE_RPC_PROXY_ORIGIN is not set; ` +
            'a mainnet build reads through the RPC proxy so no provider key ships in the bundle (#1724).',
        );
      }
    }
  }
  return problems;
}

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
 * endpoints (the proxy and its public fallback, or the direct URL) and
 * socket, when configured, of every deployed chain, the ENS-read mainnet
 * client's endpoints, the third-party APIs the app calls,
 * then the wallet SDKs' own hosts.
 */
export function connectSources(env: BuildEnv, deployedChainIds: readonly number[]): string[] {
  const out: string[] = [];
  for (const origin of [indexerOrigin(env), indexerWsOrigin(env), agentOrigin(env)]) {
    if (origin !== null) out.push(origin);
  }
  for (const chainId of deployedChainIds) {
    out.push(...rpcEndpointsFor(chainId, env).map((e) => e.url));
    const ws = wsUrlFor(chainId, env);
    if (ws !== undefined) out.push(ws);
  }
  // The ENS-read client exists only while chain 1 has no Diamond; a
  // deployed chain 1 reads through its own transport above.
  if (!deployedChainIds.includes(1)) {
    out.push(...ensMainnetRpcEndpoints(env).map((e) => e.url));
  }
  out.push(GOPLUS_ORIGIN, COINGECKO_API_BASE);
  if (walletConnectProjectId(env) !== null) {
    out.push(...WALLETCONNECT_SOURCES.map((s) => s.source));
  }
  out.push(...COINBASE_SOURCES.map((s) => s.source));
  return out;
}
