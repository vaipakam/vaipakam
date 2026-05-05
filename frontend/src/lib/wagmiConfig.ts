/**
 * wagmi v2 configuration — single source of truth for the chain + connector
 * set the UI talks to. Consumers wire this into the provider stack in
 * `main.tsx` via `<WagmiProvider config={wagmiConfig}>`.
 *
 * Design rules:
 *   - The chain list is mirrored from `contracts/config.ts` so wagmi,
 *     ConnectKit, and our existing screens agree on "supported chains"
 *     without two sources of truth drifting.
 *   - RPC transports route through the same env-configurable URLs we use
 *     for read-only calls, so wagmi-driven writes and our viem-based
 *     reads observe the same node (avoids the "wallet sees one state,
 *     UI sees another" class of bug).
 *   - Connectors are provided via ConnectKit's `getDefaultConfig` helper —
 *     it wires the injected + WalletConnect + Coinbase Wallet paths with
 *     ConnectKit's branded metadata so the picker shows wallet icons and
 *     names, and (on mobile) the curated deep-link list.
 */
import { createConfig, http } from "wagmi";
import { safe } from "wagmi/connectors";
import {
  mainnet,
  base,
  baseSepolia,
  polygonZkEvm,
  polygonZkEvmCardona,
  bsc,
  bscTestnet,
  arbitrum,
  arbitrumSepolia,
  optimism,
  optimismSepolia,
  sepolia,
  foundry,
  type Chain,
} from "wagmi/chains";
import { getDefaultConfig } from "connectkit";
import { CHAIN_REGISTRY } from "../contracts/config";

const WC_PROJECT_ID_RAW =
  (
    import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined
  )?.trim() || "";

/**
 * Heuristic: is this build running in a mobile browser?
 *
 * We only enable the WalletConnect connector on mobile. On desktop,
 * clicking a WC mobile-wallet entry navigates the browser to a custom
 * URI scheme (`wc:...`, `metamask://...`, `trust://...`, etc.), which
 * triggers Chrome's "Allow this site to access other apps and services
 * on this device?" prompt. That prompt is OS-level UI we can't reword,
 * and on desktop the user almost never has the target mobile wallet
 * installed locally anyway — so the popup looks intrusive ("is this
 * site peeping on my apps?") for zero functional benefit. Hardware
 * wallets on desktop don't go through WC at all (WebHID / WebUSB /
 * extension-bridge paths instead), so removing WC on desktop doesn't
 * regress the Ledger / Trezor flow.
 *
 * On mobile WC is genuinely required — the wallet IS a separate app on
 * the same device and the deep-link is the canonical handoff. So we
 * keep WC enabled there.
 *
 * UA sniffing covers the common cases; we add `(pointer: coarse)` as a
 * secondary signal to catch desktop Chrome with mobile-emulation on
 * (still desktop in spirit, no mobile wallets installed) and to handle
 * tablets where UA strings vary. The check is lazy / SSR-safe.
 */
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const uaMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|Windows Phone|Opera Mini|IEMobile/i.test(
    ua,
  );
  if (!uaMobile) return false;
  // Both UA hints AND a coarse pointer must agree for us to call it
  // mobile. A desktop dev with the UA spoofed for testing keeps the
  // desktop-no-WC behaviour because their pointer is still fine.
  const coarse =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : true;
  return coarse;
}

const IS_MOBILE = isMobileBrowser();

// Pass the project ID through only on mobile. Empty string disables
// the WalletConnect connector inside `getDefaultConfig` — it gets
// dropped from the connectors list rather than rendering a broken
// "WalletConnect" entry that fails to open.
const WC_PROJECT_ID = IS_MOBILE ? WC_PROJECT_ID_RAW : "";

const APP_NAME = "Vaipakam";
const APP_DESCRIPTION =
  "Peer-to-peer lending fully on-chain. Lend and borrow tokens, rent NFTs, " +
  "set your own terms — every position tracked by a unique NFT.";
const APP_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : "https://vaipakam.com";
const APP_ICON = `${APP_URL}/logo-light.png`;

/**
 * Chain-object table keyed by chainId. Maps the viem-provided chain objects
 * to the ones our UI already supports. Any chainId in CHAIN_REGISTRY that
 * isn't in this table would be skipped by the connector — keep in sync
 * when a new chain is added to contracts/config.ts.
 */
const CHAIN_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [polygonZkEvm.id]: polygonZkEvm,
  [polygonZkEvmCardona.id]: polygonZkEvmCardona,
  [bsc.id]: bsc,
  [bscTestnet.id]: bscTestnet,
  [arbitrum.id]: arbitrum,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [optimism.id]: optimism,
  [optimismSepolia.id]: optimismSepolia,
  [sepolia.id]: sepolia,
  // Anvil — viem's prebuilt chain id 31337. Surfaced so wagmi /
  // ConnectKit can switch the wallet to a local foundry node for
  // Range Orders Phase 1 smoke tests against
  // `contracts/script/anvil-bootstrap.sh`. Only paired with
  // CHAIN_REGISTRY's ANVIL entry on dev — production-built bundles
  // include it but no production user will ever see Anvil offered
  // unless they're already on chain 31337 in their wallet.
  [foundry.id]: foundry,
};

/** Build the ordered chain list from the registry. Preserves the canonical
 *  display order (compareChainsForDisplay) so the wallet-picker presents
 *  chains in the same order as the rest of the UI. */
const supportedChains = Object.values(CHAIN_REGISTRY)
  .map((c) => CHAIN_BY_ID[c.chainId])
  .filter((c): c is Chain => Boolean(c));

if (supportedChains.length === 0) {
  throw new Error(
    "wagmi config: CHAIN_REGISTRY resolved to zero viem-known chains — " +
      "extend CHAIN_BY_ID in this file when adding a new supported chain.",
  );
}

/** Transports override the viem default (public RPC) with the RPC URL we
 *  ship in CHAIN_REGISTRY (env-configurable). This keeps the wallet session
 *  and our dashboard's read layer pinned to the same upstream. */
const transports: Record<number, ReturnType<typeof http>> = {};
for (const c of Object.values(CHAIN_REGISTRY)) {
  if (CHAIN_BY_ID[c.chainId]) {
    transports[c.chainId] = http(c.rpcUrl);
  }
}

// Type assertion: `getDefaultConfig` expects `[Chain, ...Chain[]]`. We've
// guarded above that the array has at least one element.
type NonEmptyChains = readonly [Chain, ...Chain[]];

// ConnectKit wires the usual browser-extension + WalletConnect + Coinbase
// Wallet connectors via `getDefaultConfig`. Merge in wagmi's Safe-App
// connector so when Vaipakam is embedded in a Safe multisig UI as a
// Safe App, the iframe handshake auto-completes and the connected Safe
// becomes the signer. The Safe connector is a no-op outside a Safe
// iframe context (the iframe postMessage handshake never completes,
// the connector stays dormant), so adding it never affects the normal
// browser flow.
const defaultConnectKitConfig = getDefaultConfig({
  chains: supportedChains as unknown as NonEmptyChains,
  transports,
  walletConnectProjectId: WC_PROJECT_ID,
  appName: APP_NAME,
  appDescription: APP_DESCRIPTION,
  appUrl: APP_URL,
  appIcon: APP_ICON,
  // ConnectKit v1.9+ ships with `enableAaveAccount: true` as the default —
  // adding the @aave/account smart-wallet connector and rendering a
  // "Continue with Aave" CTA at the top of the picker. We do NOT want a
  // competing-protocol-branded button at the top of Vaipakam's connect
  // modal; opt out explicitly. Removes the connector AND the CTA.
  enableAaveAccount: false,
  // Keep wagmi's auto-reconnect on page reload (default true) so a user
  // who just refreshed doesn't have to re-pair their wallet every time.
  ssr: false,
});

export const wagmiConfig = createConfig({
  ...defaultConnectKitConfig,
  connectors: [
    ...(defaultConnectKitConfig.connectors ?? []),
    safe({
      // Trust only Safe's first-party domains for the iframe handshake.
      // Wider matches would let arbitrary sites impersonate a Safe
      // context. Re-review this list if Safe publishes new surface
      // domains.
      allowedDomains: [/app\.safe\.global$/, /safe\.global$/],
      debug: false,
    }),
  ],
});

/** Whether WalletConnect is available in *this session*. False on
 *  desktop (deliberately disabled to avoid the protocol-handler popup)
 *  AND when the env var is missing. Consumers that want to differentiate
 *  the two use `walletConnectConfigured` below. */
export const walletConnectAvailable = WC_PROJECT_ID.length > 0;

/** Whether the WC project id env var is set at all, regardless of
 *  whether we're using it in this session. Used by main.tsx's
 *  config-misuse warning so the warning only fires on a genuine
 *  misconfiguration (env var missing) — desktop's intentional
 *  WC-suppression doesn't trip it. */
export const walletConnectConfigured = WC_PROJECT_ID_RAW.length > 0;
