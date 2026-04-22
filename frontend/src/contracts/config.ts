import { getAddress, isAddress } from 'ethers';

const env = import.meta.env;

/** Normalises an env-configured address to canonical EIP-55 checksum form.
 *  Ethers v6 throws `bad address checksum` on any mis-cased input, so even a
 *  single wrong letter in `.env.local` bricks every downstream `new Contract(...)`
 *  call. Lowercase-then-`getAddress` round-trips produce the correct form
 *  regardless of how the operator cased the env value, and bad hex still
 *  throws up-front at module load rather than at the first RPC call. */
function normalizeAddress(addr: string | null): string | null {
  if (addr == null) return null;
  const trimmed = addr.trim();
  if (trimmed.length === 0) return null;
  // Validate-before-normalize so an obviously malformed env value surfaces
  // at load with a clear error, not as a cryptic checksum failure elsewhere.
  if (!isAddress(trimmed.toLowerCase())) {
    throw new Error(`Invalid address in env: ${addr}`);
  }
  return getAddress(trimmed.toLowerCase());
}

/**
 * Registry of chains the Vaipakam app is aware of.
 *
 * Phase 1 deploys each Vaipakam Diamond per-chain (no cross-chain protocol
 * state — each network hosts its own independent Diamond instance). Only
 * the VPFI token is cross-chain, via LayerZero OFT V2:
 * Base hosts the canonical VPFIToken + OFT Adapter (lock/release); every other
 * chain hosts a pure OFT mirror (burn/mint). That split is captured by the
 * `isCanonicalVPFI` flag on each entry.
 *
 * Keying by `chainId` lets the wallet context resolve the connected network in
 * O(1). Entries whose Diamond hasn't been deployed yet carry
 * `diamondAddress: null` — `isChainSupported()` gates protocol calls on that.
 *
 * Env overrides (per-chain Diamond addresses land here as we roll out):
 *   VITE_ETHEREUM_DIAMOND_ADDRESS       / VITE_ETHEREUM_DEPLOY_BLOCK
 *   VITE_SEPOLIA_DIAMOND_ADDRESS        / VITE_SEPOLIA_DEPLOY_BLOCK
 *   VITE_BASE_DIAMOND_ADDRESS           / VITE_BASE_DEPLOY_BLOCK
 *   VITE_BASE_SEPOLIA_DIAMOND_ADDRESS   / VITE_BASE_SEPOLIA_DEPLOY_BLOCK
 *   VITE_POLYGON_DIAMOND_ADDRESS        / VITE_POLYGON_DEPLOY_BLOCK
 *   VITE_POLYGON_AMOY_DIAMOND_ADDRESS   / VITE_POLYGON_AMOY_DEPLOY_BLOCK
 *   VITE_ARBITRUM_DIAMOND_ADDRESS       / VITE_ARBITRUM_DEPLOY_BLOCK
 *   VITE_ARBITRUM_SEPOLIA_DIAMOND_ADDRESS / VITE_ARBITRUM_SEPOLIA_DEPLOY_BLOCK
 *   VITE_OPTIMISM_DIAMOND_ADDRESS       / VITE_OPTIMISM_DEPLOY_BLOCK
 *   VITE_OPTIMISM_SEPOLIA_DIAMOND_ADDRESS / VITE_OPTIMISM_SEPOLIA_DEPLOY_BLOCK
 *   VITE_*_RPC_URL                      — per-chain RPC override (same prefix)
 *   VITE_DEFAULT_CHAIN_ID               — force a specific chain for read-only
 *                                         fallback (must have a Diamond).
 *   VITE_DIAMOND_ADDRESS / VITE_DEPLOY_BLOCK — legacy single-chain overrides,
 *                                         applied to Sepolia.
 *   VITE_*_VPFI_BUY_ADAPTER             — mirror-chain VPFIBuyAdapter address
 *                                         (unset on canonical chains; the
 *                                         diamond's `buyVPFIWithETH` is used
 *                                         directly there).
 *   VITE_*_VPFI_BUY_PAYMENT_TOKEN       — optional ERC20 (e.g. WETH) the
 *                                         adapter pulls for `amountIn`.
 *                                         Unset = native-ETH mode.
 */

export interface ChainConfig {
  chainId: number;
  chainIdHex: string;
  name: string;
  shortName: string;
  rpcUrl: string;
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
  /** LayerZero V2 endpoint id, or null when no OFT endpoint is wired here. */
  lzEid: number | null;
  /** Testnet vs mainnet — used only for UI grouping. */
  testnet: boolean;
  /** VPFIBuyAdapter address on this chain, or null when buys here route
   *  directly through the Diamond (canonical) or the adapter hasn't been
   *  deployed yet. Mirror chains with a null adapter cannot originate
   *  cross-chain buys. */
  vpfiBuyAdapter: string | null;
  /** When set, the adapter pulls this ERC20 for `amountIn` (WETH mode) so
   *  the user only has to send the LayerZero native fee as `msg.value`.
   *  Null = native ETH mode (default). Ignored when `vpfiBuyAdapter` is null. */
  vpfiBuyPaymentToken: string | null;
}

function str(key: string, fallback: string): string {
  return (env[key] as string | undefined) ?? fallback;
}

function optStr(key: string, fallback: string | null): string | null {
  const v = env[key] as string | undefined;
  if (v && v.trim().length > 0) return v;
  return fallback;
}

function num(key: string, fallback: number): number {
  const v = env[key] as string | undefined;
  const parsed = v == null ? NaN : Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Mainnet ──────────────────────────────────────────────────────────────

const ETHEREUM: ChainConfig = {
  chainId: 1,
  chainIdHex: '0x1',
  name: 'Ethereum',
  shortName: 'eth',
  rpcUrl: str('VITE_ETHEREUM_RPC_URL', 'https://eth.llamarpc.com'),
  blockExplorer: 'https://etherscan.io',
  diamondAddress: optStr('VITE_ETHEREUM_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_ETHEREUM_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 30101,
  testnet: false,
  vpfiBuyAdapter: optStr('VITE_ETHEREUM_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_ETHEREUM_VPFI_BUY_PAYMENT_TOKEN', null),
};

const BASE: ChainConfig = {
  chainId: 8453,
  chainIdHex: '0x2105',
  name: 'Base',
  shortName: 'base',
  rpcUrl: str('VITE_BASE_RPC_URL', 'https://mainnet.base.org'),
  blockExplorer: 'https://basescan.org',
  diamondAddress: optStr('VITE_BASE_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_BASE_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: true,
  lzEid: 30184,
  testnet: false,
  vpfiBuyAdapter: null,
  vpfiBuyPaymentToken: null,
};

const POLYGON: ChainConfig = {
  chainId: 137,
  chainIdHex: '0x89',
  name: 'Polygon',
  shortName: 'polygon',
  rpcUrl: str('VITE_POLYGON_RPC_URL', 'https://polygon-rpc.com'),
  blockExplorer: 'https://polygonscan.com',
  diamondAddress: optStr('VITE_POLYGON_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_POLYGON_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 30109,
  testnet: false,
  vpfiBuyAdapter: optStr('VITE_POLYGON_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_POLYGON_VPFI_BUY_PAYMENT_TOKEN', null),
};

const ARBITRUM: ChainConfig = {
  chainId: 42161,
  chainIdHex: '0xa4b1',
  name: 'Arbitrum One',
  shortName: 'arb',
  rpcUrl: str('VITE_ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc'),
  blockExplorer: 'https://arbiscan.io',
  diamondAddress: optStr('VITE_ARBITRUM_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_ARBITRUM_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 30110,
  testnet: false,
  vpfiBuyAdapter: optStr('VITE_ARBITRUM_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_ARBITRUM_VPFI_BUY_PAYMENT_TOKEN', null),
};

const OPTIMISM: ChainConfig = {
  chainId: 10,
  chainIdHex: '0xa',
  name: 'Optimism',
  shortName: 'op',
  rpcUrl: str('VITE_OPTIMISM_RPC_URL', 'https://mainnet.optimism.io'),
  blockExplorer: 'https://optimistic.etherscan.io',
  diamondAddress: optStr('VITE_OPTIMISM_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_OPTIMISM_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 30111,
  testnet: false,
  vpfiBuyAdapter: optStr('VITE_OPTIMISM_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_OPTIMISM_VPFI_BUY_PAYMENT_TOKEN', null),
};

// ── Testnet ──────────────────────────────────────────────────────────────

// Sepolia is the only chain with a live Phase-1 Diamond today; legacy env
// vars `VITE_DIAMOND_ADDRESS` / `VITE_DEPLOY_BLOCK` are honored here so
// existing deploy configs keep working.
const SEPOLIA: ChainConfig = {
  chainId: 11155111,
  chainIdHex: '0xaa36a7',
  name: 'Sepolia',
  shortName: 'sep',
  rpcUrl: str('VITE_SEPOLIA_RPC_URL', 'https://rpc.sepolia.org'),
  blockExplorer: 'https://sepolia.etherscan.io',
  diamondAddress:
    optStr('VITE_SEPOLIA_DIAMOND_ADDRESS', null) ??
    optStr('VITE_DIAMOND_ADDRESS', '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD'),
  deployBlock:
    num('VITE_SEPOLIA_DEPLOY_BLOCK', 0) || num('VITE_DEPLOY_BLOCK', 10672636),
  isCanonicalVPFI: false,
  lzEid: 40161,
  testnet: true,
  vpfiBuyAdapter: optStr('VITE_SEPOLIA_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_SEPOLIA_VPFI_BUY_PAYMENT_TOKEN', null),
};

const BASE_SEPOLIA: ChainConfig = {
  chainId: 84532,
  chainIdHex: '0x14a34',
  name: 'Base Sepolia',
  shortName: 'base-sep',
  rpcUrl: str('VITE_BASE_SEPOLIA_RPC_URL', 'https://sepolia.base.org'),
  blockExplorer: 'https://sepolia.basescan.org',
  diamondAddress: optStr('VITE_BASE_SEPOLIA_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_BASE_SEPOLIA_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: true,
  lzEid: 40245,
  testnet: true,
  vpfiBuyAdapter: null,
  vpfiBuyPaymentToken: null,
};

const POLYGON_AMOY: ChainConfig = {
  chainId: 80002,
  chainIdHex: '0x13882',
  name: 'Polygon Amoy',
  shortName: 'amoy',
  rpcUrl: str('VITE_POLYGON_AMOY_RPC_URL', 'https://rpc-amoy.polygon.technology'),
  blockExplorer: 'https://amoy.polygonscan.com',
  diamondAddress: optStr('VITE_POLYGON_AMOY_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_POLYGON_AMOY_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 40267,
  testnet: true,
  vpfiBuyAdapter: optStr('VITE_POLYGON_AMOY_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_POLYGON_AMOY_VPFI_BUY_PAYMENT_TOKEN', null),
};

const ARBITRUM_SEPOLIA: ChainConfig = {
  chainId: 421614,
  chainIdHex: '0x66eee',
  name: 'Arbitrum Sepolia',
  shortName: 'arb-sep',
  rpcUrl: str('VITE_ARBITRUM_SEPOLIA_RPC_URL', 'https://sepolia-rollup.arbitrum.io/rpc'),
  blockExplorer: 'https://sepolia.arbiscan.io',
  diamondAddress: optStr('VITE_ARBITRUM_SEPOLIA_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_ARBITRUM_SEPOLIA_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 40231,
  testnet: true,
  vpfiBuyAdapter: optStr('VITE_ARBITRUM_SEPOLIA_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_ARBITRUM_SEPOLIA_VPFI_BUY_PAYMENT_TOKEN', null),
};

const OPTIMISM_SEPOLIA: ChainConfig = {
  chainId: 11155420,
  chainIdHex: '0xaa37dc',
  name: 'Optimism Sepolia',
  shortName: 'op-sep',
  rpcUrl: str('VITE_OPTIMISM_SEPOLIA_RPC_URL', 'https://sepolia.optimism.io'),
  blockExplorer: 'https://sepolia-optimistic.etherscan.io',
  diamondAddress: optStr('VITE_OPTIMISM_SEPOLIA_DIAMOND_ADDRESS', null),
  deployBlock: num('VITE_OPTIMISM_SEPOLIA_DEPLOY_BLOCK', 0),
  isCanonicalVPFI: false,
  lzEid: 40232,
  testnet: true,
  vpfiBuyAdapter: optStr('VITE_OPTIMISM_SEPOLIA_VPFI_BUY_ADAPTER', null),
  vpfiBuyPaymentToken: optStr('VITE_OPTIMISM_SEPOLIA_VPFI_BUY_PAYMENT_TOKEN', null),
};

// Normalise every env-configured address to canonical EIP-55 checksum so a
// mis-cased operator entry doesn't propagate to `new Contract(addr, ...)`
// and blow up with "bad address checksum" at first use. Done once at module
// load, before the registry publishes the chain objects.
for (const c of [ETHEREUM, BASE, POLYGON, ARBITRUM, OPTIMISM, SEPOLIA, BASE_SEPOLIA, POLYGON_AMOY, ARBITRUM_SEPOLIA, OPTIMISM_SEPOLIA]) {
  c.diamondAddress = normalizeAddress(c.diamondAddress);
  c.vpfiBuyAdapter = normalizeAddress(c.vpfiBuyAdapter);
  c.vpfiBuyPaymentToken = normalizeAddress(c.vpfiBuyPaymentToken);
}

export const CHAIN_REGISTRY: Record<number, ChainConfig> = {
  [ETHEREUM.chainId]: ETHEREUM,
  [BASE.chainId]: BASE,
  [POLYGON.chainId]: POLYGON,
  [ARBITRUM.chainId]: ARBITRUM,
  [OPTIMISM.chainId]: OPTIMISM,
  [SEPOLIA.chainId]: SEPOLIA,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
  [POLYGON_AMOY.chainId]: POLYGON_AMOY,
  [ARBITRUM_SEPOLIA.chainId]: ARBITRUM_SEPOLIA,
  [OPTIMISM_SEPOLIA.chainId]: OPTIMISM_SEPOLIA,
};

// Ethereum family (L1 + its canonical testnet) — pinned to the top of every
// chain list so "Ethereum" always reads first. Add new L1/testnet pairs here
// if future chainIds deserve the same placement.
const ETHEREUM_FAMILY_CHAIN_IDS: ReadonlySet<number> = new Set([
  ETHEREUM.chainId, // 1
  SEPOLIA.chainId, // 11155111
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

const ENV_DEFAULT_CHAIN_ID = Number(
  (env.VITE_DEFAULT_CHAIN_ID as string | undefined) ?? SEPOLIA.chainId,
);

/**
 * Read-only fallback chain — used when no wallet is connected, or the wallet
 * is on an unsupported chain. Resolves to the env-chosen chainId if that chain
 * has a Diamond, else falls back to Sepolia (the only always-live Phase-1
 * testnet today). Type is narrowed: `diamondAddress` is guaranteed non-null
 * so call sites that dereference it don't need a null check.
 */
export type DeployedChain = ChainConfig & { diamondAddress: string };

export const DEFAULT_CHAIN: DeployedChain = (() => {
  const envChain = CHAIN_REGISTRY[ENV_DEFAULT_CHAIN_ID];
  if (envChain && envChain.diamondAddress !== null) {
    return envChain as DeployedChain;
  }
  if (SEPOLIA.diamondAddress === null) {
    throw new Error('DEFAULT_CHAIN resolution failed — Sepolia has no diamondAddress');
  }
  return SEPOLIA as DeployedChain;
})();

/**
 * Chain config for the VPFI canonical chain on the current environment
 * (mainnet or testnet). Used by the VPFI panel to show where the canonical
 * adapter lives.
 */
export function getCanonicalVPFIChain(
  preference: 'mainnet' | 'testnet' = DEFAULT_CHAIN.testnet ? 'testnet' : 'mainnet',
): ChainConfig {
  const pool = Object.values(CHAIN_REGISTRY).filter(
    (c) => c.isCanonicalVPFI && c.testnet === (preference === 'testnet'),
  );
  return pool[0] ?? BASE_SEPOLIA;
}

/**
 * Back-compat accessor. Prefer `CHAIN_REGISTRY` + `getChainByChainId`.
 */
export const SUPPORTED_CHAINS = {
  ethereum: ETHEREUM,
  base: BASE,
  polygon: POLYGON,
  arbitrum: ARBITRUM,
  optimism: OPTIMISM,
  sepolia: SEPOLIA,
  baseSepolia: BASE_SEPOLIA,
  polygonAmoy: POLYGON_AMOY,
  arbitrumSepolia: ARBITRUM_SEPOLIA,
  optimismSepolia: OPTIMISM_SEPOLIA,
} as const;

/** Lookup a chain by its numeric chainId. Returns undefined for chains the
 *  app doesn't recognise at all (e.g. BNB, Avalanche — not in scope). */
export function getChainByChainId(
  chainId: number | null | undefined,
): ChainConfig | undefined {
  if (chainId == null) return undefined;
  return CHAIN_REGISTRY[chainId];
}

/** True iff a live Phase-1 Diamond exists on this chain. Chains registered
 *  but pending deploy (diamondAddress === null) are NOT supported yet —
 *  protocol calls must be gated on this. */
export function isChainSupported(chainId: number | null | undefined): boolean {
  const c = getChainByChainId(chainId);
  return c !== undefined && c.diamondAddress !== null;
}

/** True iff the chain is known to the app (in the registry) even if the
 *  Diamond isn't deployed there yet. Used to distinguish "unsupported chain"
 *  banners from "pending deploy" messaging. */
export function isChainRegistered(chainId: number | null | undefined): boolean {
  return getChainByChainId(chainId) !== undefined;
}
