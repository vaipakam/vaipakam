/**
 * wagmi v2 + ConnectKit configuration for app.
 *
 * Mirrors the hard-won choices from apps/defi/src/lib/wagmiConfig.ts
 * (see the history notes there before changing connector behaviour):
 *   - transports use the SAME env-configurable RPC URLs as our read
 *     layer, so wallet writes and UI reads observe one node;
 *   - WalletConnect is wired only when a project id is configured,
 *     with `metadata.redirect` carrying ONLY `universal` (an empty
 *     `native` breaks WC-v2 pairing-URI generation);
 *   - wagmi's `metaMask()` SDK connector is deliberately NOT used
 *     (broken extension detection on desktop) — injected target only.
 */
import { createConfig, fallback, http, webSocket } from 'wagmi';
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
import { SUPPORTED_CHAINS, ensMainnetRpcUrl } from './chains';
import { connectionGeneration } from '../lib/dataRights';

const WC_PROJECT_ID =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ||
  '';

const APP_NAME = 'Vaipakam';
const APP_DESCRIPTION =
  'Lend, borrow, and rent NFTs directly with other people. ' +
  'Your assets stay in your own on-chain vault.';
const APP_URL =
  typeof window !== 'undefined' ? window.location.origin : 'https://app.vaipakam.com';
const APP_ICON = `${APP_URL}/logo.svg`;

/** viem chain objects for every chainId app can support. Keep in
 *  sync with CHAIN_META in chains.ts when adding a chain. */
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

const chains = SUPPORTED_CHAINS.map((c) => CHAIN_BY_ID[c.chainId]).filter(
  (c): c is Chain => Boolean(c),
);

if (chains.length === 0) {
  throw new Error(
    'app wagmi: no supported chain maps to a viem chain object — ' +
      'extend CHAIN_BY_ID when adding a chain.',
  );
}

// A deployed chain missing from CHAIN_BY_ID would be "supported" with
// no RPC client behind it — every read silently disabled, every write
// throwing. Fail loudly at module load instead.
for (const c of SUPPORTED_CHAINS) {
  if (!CHAIN_BY_ID[c.chainId]) {
    throw new Error(
      `app wagmi: deployed chain ${c.chainId} (${c.name}) has no viem ` +
        'chain object — extend CHAIN_BY_ID.',
    );
  }
}

// `batch: true` folds same-tick eth_calls into one JSON-RPC batch —
// the per-row token-meta reads on list pages go from hundreds of HTTP
// requests to a handful, with zero call-site changes.
//
// When a chain has a WebSocket RPC configured, wrap it in a `fallback`
// AHEAD of HTTP: viem's block watcher then uses `eth_subscribe`
// (newHeads) for push updates that drive the live query-invalidation
// layer (`LiveChainSync`), and any WS hiccup transparently drops to the
// HTTP transport (which the block watcher polls instead). No WS URL ⇒
// plain HTTP, identical to before.
const transports: Record<number, Transport> = {};
for (const c of SUPPORTED_CHAINS) {
  const httpTransport = http(c.rpcUrl, { batch: true });
  transports[c.chainId] = c.wsUrl
    ? fallback([webSocket(c.wsUrl), httpTransport])
    : httpTransport;
}

// ENS-READ-ONLY mainnet client: app doesn't deploy on Ethereum
// mainnet, but ENS reverse lookups (display sugar) resolve there —
// without a registered client, useEnsName({chainId: 1}) throws
// ChainNotConfiguredError and the feature is silently dead. The
// app's own supported-network gates derive from SUPPORTED_CHAINS
// (deployments) and are untouched: mainnet is not a working network
// here, it just backs ENS reads.
//
// The transport must be EXPLICIT: `http(undefined)` silently rides
// viem's built-in default for chain 1 (eth.merkle.io), a free shared
// endpoint that 429s under the burst a list page's first paint fires
// (one reverse lookup per distinct counterparty address). Resolve via
// the same env-overridable plumbing as every other chain
// (VITE_ETHEREUM_RPC_URL, else the chains.ts default), with a second
// public endpoint behind it so a throttled primary degrades to the
// fallback instead of to a dropped name. dRPC's public gateway as the
// secondary — maintained and CORS-open; cloudflare-eth.com was
// rejected here (Codex #1084 r1): Cloudflare's own migration guide
// lists it as a deprecated legacy gateway hostname.
const chainsWithEns = chains.some((c) => c.id === mainnet.id)
  ? chains
  : [...chains, mainnet];
if (!transports[mainnet.id]) {
  transports[mainnet.id] = fallback([
    http(ensMainnetRpcUrl(), { batch: true }),
    http('https://eth.drpc.org', { batch: true }),
  ]);
}

type NonEmptyChains = readonly [Chain, ...Chain[]];

const defaultConfig = getDefaultConfig({
  chains: chainsWithEns as unknown as NonEmptyChains,
  transports,
  walletConnectProjectId: WC_PROJECT_ID,
  appName: APP_NAME,
  appDescription: APP_DESCRIPTION,
  appUrl: APP_URL,
  appIcon: APP_ICON,
  // No third-party smart-wallet CTA in Vaipakam's connect modal
  // (same opt-out as apps/defi).
  enableAaveAccount: false,
  ssr: false,
});

export const wagmiConfig = createConfig({
  ...defaultConfig,
  connectors: [
    injected({ target: 'metaMask' }),
    // UX-033 — turn OFF the SDK's own analytics phone-home. The
    // Coinbase Wallet SDK's `preference.telemetry` flag gates its
    // functional-metrics beacons; keeping `options: 'all'` preserves
    // the current (default) wallet-selection behaviour so this is a
    // telemetry-only change, not a smart-wallet-mode change. Naive
    // users didn't opt into third-party analytics, and the beacons
    // also spam the console on locked-down networks.
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
            // UX-033 — WalletConnect's Core `telemetryEnabled` threads
            // through the EthereumProvider → SignClient → Core chain;
            // false stops the pulse.walletconnect.org event beacons.
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
    // Safe-App connector — auto-connects the Safe as signer when
    // app is embedded in a Safe multisig UI; a documented no-op
    // outside a Safe iframe (see apps/defi wagmiConfig).
    safe({
      allowedDomains: [/app\.safe\.global$/, /safe\.global$/],
      debug: false,
      // #1862 Part 2 round 3 P1 — WITHOUT this the Safe connector cannot be
      // disconnected in any way that survives a reload. `@wagmi/connectors`
      // defaults `shimDisconnect` to false for `safe()`, so its `disconnect`
      // only drops wagmi's in-memory connection and `isAuthorized` goes on
      // answering yes for as long as the page is embedded in a Safe — the
      // next mount reconnects. That is fine for a user who never asked to
      // leave, and wrong for one who deleted their data and was told they
      // had been signed out. With the shim, disconnecting writes
      // `safe.disconnected` and `isAuthorized` honours it, which is the same
      // contract `injected()` has had here all along (its default is true).
      shimDisconnect: true,
    }),
  ],
});

// #1862 Part 2 round 16 P2 — the data-rights erasure's reconnect fence is fed
// from here, and it has to be, because everything inside React has too short a
// life. The fence's question is "did a connection happen AFTER the erase
// request?", and it must stay answerable for as long as an abandoned wallet
// teardown can still settle — which is unbounded, and certainly longer than
// the page that started it. Erasing in a non-English locale resets the
// language first, `LanguageRemount` remounts the page tree on that event, and
// a subscription owned by the page is unsubscribed mid-erasure. The counter
// then freezes at the request's value, agrees with the stale `disconnected`
// that `@wagmi/core@2.22.1` publishes when a late teardown settles against its
// captured connections map, and lets the cleanup delete a session the user
// created in the replacement tree.
//
// Module scope, next to the config it observes: one subscription for the life
// of the tab, above the router and every remount, and no component to forget
// to mount. See `connectionGeneration` in `lib/dataRights.ts` for what it
// counts and why an event count rather than a status read.
wagmiConfig.subscribe(
  (state) => state.connections,
  (connections, previous) =>
    connectionGeneration.observe(connections, previous),
);
