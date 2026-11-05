/**
 * Where this build reads from, resolved in ONE place (RB-RAILS, #1724).
 *
 * The same functions serve the bundle (which chain goes to which RPC) and
 * the build (which hosts the page's `connect-src` names), so the policy
 * cannot describe another deployment. No provider key may ship in the
 * bundle: a `VITE_*` value is public, so reads go through the read-only RPC
 * proxy (`apps/rpc-proxy`) and fall back to each chain's keyless public
 * endpoint. The user's OWN state is read through the wallet's provider first
 * (`ownRail.ts`); this module is the world and pre-sign rails' fallback.
 *
 * This file is import-safe from `vite.config.ts` (no `import.meta.env`
 * reads at module scope: every function takes the env it should read).
 */

export type EnvLike = Record<string, string | undefined>;

function configured(env: EnvLike, key: string): string | null {
  const raw = env[key]?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** The indexer Worker's origin (the world rail), or `null`: this build then
 *  has no offer book, no push rail and no capability snapshot, and every
 *  world surface says so (RB-FUNDS: an unstated unknown is a defect). */
export function indexerOrigin(env: EnvLike): string | null {
  return configured(env, 'VITE_INDEXER_ORIGIN');
}

/** The agent Worker's origin (alerts, Telegram link), or `null`. */
export function agentOrigin(env: EnvLike): string | null {
  return configured(env, 'VITE_AGENT_ORIGIN');
}

/** The read-only RPC proxy's origin, or `null` when this build reads the
 *  public endpoints directly (testnets only; a mainnet build is refused
 *  without it, see {@link rpcConfigProblems}). */
export function rpcProxyOrigin(env: EnvLike): string | null {
  return configured(env, 'VITE_RPC_PROXY_ORIGIN');
}

interface ChainRpcMeta {
  /** The chain's keyless public endpoint: the fallback behind the proxy. */
  publicUrl: string;
  mainnet: boolean;
}

/** Every chain this app can read. A chain becomes selectable only when the
 *  deployments bundle carries a Diamond for it (`chains.ts`). */
const CHAIN_RPC: Readonly<Record<number, ChainRpcMeta>> = {
  1: { publicUrl: 'https://ethereum-rpc.publicnode.com', mainnet: true },
  8453: { publicUrl: 'https://mainnet.base.org', mainnet: true },
  42161: { publicUrl: 'https://arb1.arbitrum.io/rpc', mainnet: true },
  10: { publicUrl: 'https://mainnet.optimism.io', mainnet: true },
  56: { publicUrl: 'https://bsc-dataseed.bnbchain.org', mainnet: true },
  84532: { publicUrl: 'https://sepolia.base.org', mainnet: false },
  421614: { publicUrl: 'https://sepolia-rollup.arbitrum.io/rpc', mainnet: false },
  97: { publicUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', mainnet: false },
};

export function isMainnetChain(chainId: number): boolean {
  return CHAIN_RPC[chainId]?.mainnet ?? false;
}

export function knowsChain(chainId: number): boolean {
  return chainId in CHAIN_RPC;
}

/** One HTTP endpoint a chain's reads go to. `viaProxy` marks the proxy's
 *  route, whose batch size the transport keeps within the proxy's cap. */
export interface RpcEndpoint {
  url: string;
  viaProxy: boolean;
}

/** The HTTP endpoints for a chain, in the order the transport tries them:
 *  the proxy's route for the chain (when this build has a proxy), then the
 *  chain's keyless public default. */
export function rpcEndpointsFor(chainId: number, env: EnvLike): readonly RpcEndpoint[] {
  const meta = CHAIN_RPC[chainId];
  if (!meta) throw new Error(`endpoints: chain ${chainId} has no RPC configuration`);
  const proxy = rpcProxyOrigin(env);
  const list: RpcEndpoint[] = [];
  if (proxy !== null) list.push({ url: `${proxy}/rpc/${chainId}`, viaProxy: true });
  list.push({ url: meta.publicUrl, viaProxy: false });
  return list;
}

/** Build-time refusals (vite.config.ts). A problem is a sentence naming the
 *  variable and the rule, never a silent downgrade. */
export function rpcConfigProblems(env: EnvLike, deployedChainIds: readonly number[]): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(env)) {
    if (/^VITE_.*_RPC_URL$/.test(key) && env[key]) {
      problems.push(
        `${key} is set: a per-chain RPC URL ships in the bundle with its key. ` +
          'Reads go through VITE_RPC_PROXY_ORIGIN or the keyless public endpoint only.',
      );
    }
  }
  if (rpcProxyOrigin(env) === null) {
    for (const chainId of deployedChainIds) {
      if (isMainnetChain(chainId)) {
        problems.push(
          `chain ${chainId} is a mainnet and VITE_RPC_PROXY_ORIGIN is not set; ` +
            'a mainnet build reads through the RPC proxy so no provider key ships in the bundle (#1724).',
        );
      }
    }
  }
  return problems;
}

/** The hosts the wallet SDKs this app registers connect to. Each entry says
 *  why it is on the list, so a reviewer can strike one when a connector is
 *  removed. */
const WALLET_SDK_SOURCES: readonly { source: string; why: string }[] = [
  { source: 'https://verify.walletconnect.com', why: 'the Verify API (legacy host)' },
  { source: 'https://verify.walletconnect.org', why: 'the Verify API, which tells the wallet which site is asking' },
  { source: 'https://rpc.walletconnect.org', why: "the WalletConnect SDK's own chain API" },
  { source: 'wss://relay.walletconnect.com', why: 'the WalletConnect relay (legacy host)' },
  { source: 'wss://relay.walletconnect.org', why: 'the WalletConnect relay' },
  { source: 'https://api.web3modal.org', why: "ConnectKit's wallet list and images" },
  { source: 'https://www.walletlink.org', why: 'WalletLink, the Coinbase mobile pairing bridge' },
  { source: 'wss://www.walletlink.org', why: 'WalletLink socket' },
  { source: 'https://rpc.wallet.coinbase.com', why: 'the Coinbase smart-wallet signer' },
  { source: 'https://chain-proxy.wallet.coinbase.com', why: 'the Coinbase wallet SDK chain proxy' },
];

/** Every host the page may connect to under RB-INTEGRITY: its own Workers,
 *  the RPC route of each deployed chain (a public endpoint names its origin
 *  only), and the wallet SDK hosts. Written report-only into `_headers` by
 *  the build; enforced before the cutover. */
export function connectSources(env: EnvLike, deployedChainIds: readonly number[]): string[] {
  const out = new Set<string>();
  const addOrigin = (url: string | null) => {
    if (!url) return;
    try {
      out.add(new URL(url).origin);
    } catch {
      /* a malformed value is refused by its own guard; never a CSP entry */
    }
  };
  addOrigin(indexerOrigin(env));
  const indexer = indexerOrigin(env);
  if (indexer?.startsWith('https://')) out.add('wss://' + indexer.slice('https://'.length));
  addOrigin(agentOrigin(env));
  for (const chainId of deployedChainIds) {
    if (!knowsChain(chainId)) continue;
    for (const e of rpcEndpointsFor(chainId, env)) addOrigin(e.url);
  }
  for (const s of WALLET_SDK_SOURCES) out.add(s.source);
  return [...out];
}
