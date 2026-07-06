/**
 * Chain-config TYPE + pure helpers.
 *
 * Lives in @vaipakam/contracts (alongside the ABI bundle and
 * deployments JSON) so consumers in any app — apps/defi,
 * apps/www, apps/agent, apps/keeper, apps/indexer — can describe
 * a chain config without pulling apps/defi's Vite-bundled runtime
 * registry.
 *
 * The runtime instantiation (CHAIN_REGISTRY, DEFAULT_CHAIN, etc.)
 * stays in apps/defi/src/contracts/config.ts because it references
 * `import.meta.env.VITE_*_RPC_URL` which is Vite-specific. That
 * file re-exports {ChainConfig} and {compareChainsForDisplay} from
 * here so existing import paths keep working.
 */

/**
 * Static chain descriptor. Some fields come from
 * the per-chain deployments JSON (Diamond proxy address, facet
 * addresses, vault impl, LZ adapter addresses); others are
 * deploy-time-stable metadata (chain name, RPC default, native
 * gas symbol, OfferBook default-pair addresses).
 */
export interface ChainConfig {
  chainId: number;
  chainIdHex: string;
  name: string;
  shortName: string;
  rpcUrl: string;
  /** Optional WebSocket RPC URL (#1031 reverse-port). When set, the
   *  frontend's wagmi transport prefers it (`eth_subscribe` newHeads
   *  push updates) with transparent HTTP fallback; when null, plain
   *  HTTP block polling — identical to before. Opt-in per deploy via
   *  the chain's `_WSS_URL` env var; never defaulted. */
  wsUrl?: string | null;
  blockExplorer: string;
  /** Diamond proxy address on this chain, or null if Phase 1 hasn't deployed
   *  here yet. Callers must gate protocol calls on non-null. */
  diamondAddress: string | null;
  /** Block containing the Diamond creation tx. 0 when diamondAddress is null. */
  deployBlock: number;
  /** True on the chain that hosts the canonical VPFIToken + OFT Adapter
   *  (lock/release). False on mirror chains (burn/mint). Exactly one
   *  mainnet entry and one testnet entry should be true. */
  isCanonicalVPFI: boolean;
  /** Testnet vs mainnet — used only for UI grouping. */
  testnet: boolean;
  // #687: vpfiBuyAdapter + vpfiBuyPaymentToken removed with the fixed-rate sale.
  /** Standalone MetricsFacet implementation address (not the Diamond) on
   *  this chain. Surfaces on the Analytics page's Transparency & Source
   *  card so users can land directly on the facet's `#readContract` tab
   *  on the block explorer. Null falls back to the Diamond proxy. */
  metricsFacetAddress: string | null;
  /** UUPS vault implementation deployed by `VaultFactoryFacet`. Null
   *  falls back to the Diamond proxy in the Security card. */
  vaultImplAddress: string | null;
  /** Standalone RiskFacet implementation address. Null falls back to
   *  the Diamond proxy. */
  riskFacetAddress: string | null;
  /** Standalone ProfileFacet implementation address. Null falls back
   *  to the Diamond proxy. */
  profileFacetAddress: string | null;
  /** Symbol of this chain's native gas token — used in the BuyVPFI
   *  card and balance displays so the UI says "ETH" / "BNB" / "POL"
   *  appropriately rather than always "ETH". On native-gas-mode buy
   *  adapter chains this is also what the user actually pays in. */
  nativeGasSymbol: string;
  /** CoinGecko coin slug for this chain's native gas token. Used to
   *  render a deep-link from the BuyVPFI asset symbol so users can
   *  cross-reference exactly which asset they need to acquire (and
   *  on which chain, since WETH on BNB ≠ WETH on Polygon — different
   *  bridged contracts even though both use the symbol "WETH").
   *  Null when no canonical CoinGecko page exists. */
  nativeGasCoinGeckoSlug: string | null;
  /** CoinGecko slug for the chain's canonical bridged WETH9 ERC20.
   *  Only meaningful when the BuyAdapter is in WETH-pull mode
   *  (`vpfiBuyPaymentToken != null`); the BuyVPFI card uses this
   *  to link the "WETH" label to the right CoinGecko page for the
   *  chain's specific bridged variant. Null on chains where the
   *  adapter is in native-gas mode (no WETH user-facing) or where
   *  no canonical CoinGecko page tracks the bridged WETH. */
  bridgedWethCoinGeckoSlug: string | null;
  /** Canonical wrapped-native ERC20 address on this chain (WETH on
   *  ETH-side chains, WBNB on BNB, WPOL/WMATIC on Polygon PoS, etc.).
   *  Used for chain-native-asset rendering (e.g. "gas-equivalent
   *  ERC-20" balance views) — NOT as the OfferBook default collateral
   *  (that's now `bridgedWethAddress`; see below). Null when no
   *  canonical wrapped-native ERC20 is published yet (testnets where
   *  mocks shift per deploy, or local Anvil). */
  wrappedNativeAddress: string | null;
  /** Canonical **bridged-WETH9** ERC20 address on this chain.
   *
   *  Per the 2026-05-14 WETH chain-safety audit
   *  (`docs/internal/WethChainSafetyAudit-2026-05-14.md`), used as
   *  the OfferBook's default COLLATERAL pre-fill so users see
   *  bridged-ETH-collateral loans on landing, cross-chain-consistent.
   *  On ETH-native chains (Ethereum / Base / Arbitrum / Optimism /
   *  Polygon zkEVM) `wrappedNativeAddress` IS bridged-WETH; this field
   *  can be `null` and consumers fall back to `wrappedNativeAddress`.
   *  On non-ETH-native chains (BNB Chain mainnet — chainId 56 — and
   *  Polygon PoS mainnet — chainId 137), this MUST be the chain's
   *  canonical bridged-WETH9 (e.g.
   *  `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` on BNB), NOT
   *  `wrappedNativeAddress` (which is WBNB / WPOL respectively —
   *  wrong asset).
   *
   *  Consumer pattern: `bridgedWethAddress ?? wrappedNativeAddress`. */
  bridgedWethAddress: string | null;
  /** Predominantly-used stablecoin ERC20 address on this chain
   *  (USDC on most EVMs, USDT on BNB). Used as the default LENDING
   *  asset pre-fill for the OfferBook's required
   *  (lending, collateral) filter. Same null-fallback semantics as
   *  {wrappedNativeAddress}. */
  predominantStableAddress: string | null;
}

// Ethereum family (L1 + its canonical testnet) — pinned to the top
// of every chain list so "Ethereum" always reads first. Add new
// L1/testnet pairs here if future chainIds deserve the same
// placement. Hard-coded EIP-155 chainIds (1 = mainnet, 11155111 =
// Sepolia) since this constant is type-only and shouldn't depend on
// the apps/defi runtime registry.
const ETHEREUM_FAMILY_CHAIN_IDS: ReadonlySet<number> = new Set([
  1,        // Ethereum mainnet
  11155111, // Sepolia testnet
]);

/**
 * Canonical display order for any list of ChainConfig:
 *   1. Mainnets before testnets.
 *   2. Within each tier, Ethereum family (mainnet + Sepolia) pinned first.
 *   3. Rest alphabetical by display name.
 *
 * Import and use this wherever chains are surfaced to the user — selectors,
 * badges, analytics tables — so the ordering stays consistent across every
 * surface and the user always sees Ethereum at the top of its tier.
 */
export function compareChainsForDisplay(
  a: ChainConfig,
  b: ChainConfig,
): number {
  const tierDiff = Number(a.testnet) - Number(b.testnet);
  if (tierDiff !== 0) return tierDiff;
  const aEth = ETHEREUM_FAMILY_CHAIN_IDS.has(a.chainId);
  const bEth = ETHEREUM_FAMILY_CHAIN_IDS.has(b.chainId);
  if (aEth !== bEth) return aEth ? -1 : 1;
  return a.name.localeCompare(b.name);
}
