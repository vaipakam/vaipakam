/**
 * Phase 7a — per-chain swap adapter registry.
 *
 * The diamond stores a priority-ordered array of `ISwapAdapter`
 * addresses; LibSwap iterates them in caller-supplied order. The
 * frontend needs to know which storage slot corresponds to which
 * adapter so it can pack the `AdapterCall.adapterIdx` field
 * correctly when submitting a ranked try-list.
 *
 * This registry is the frontend's mirror of the governance
 * `addSwapAdapter` ordering. Any deployment that registers adapters
 * in a different order must update this table in lockstep.
 *
 * Conventions:
 *   - Storage indices are FIXED per adapter *kind*: slot 0 is
 *     reserved for the aggregator kind the deployment prefers (we
 *     default to 0x), slot 1 for the secondary aggregator, slots
 *     2+ for on-chain AMM adapters. This stable mapping lets the
 *     frontend build an `AdapterCall[]` without querying
 *     `getSwapAdapters` first.
 *   - Addresses are deployment-specific and supplied via Vite env
 *     vars (`VITE_<CHAIN>_<KIND>_ADAPTER`). Missing env var = adapter
 *     not yet registered on that chain; the quote orchestrator skips
 *     that slot and the remaining slots still contribute to the
 *     try-list. Phase 7a.3 contracts compile against a legacy
 *     ZeroEx shim in tests, so chains that haven't fully migrated
 *     to the Settler-based adapter yet can still service
 *     liquidations via the shim in slot 0.
 */

export type SwapAdapterKind = 'zeroex' | 'oneinch' | 'univ3' | 'balancerv2';

export interface SwapAdapterEntry {
  kind: SwapAdapterKind;
  /** Fixed storage index inside `s.swapAdapters` for this kind. Null
   *  means the adapter isn't registered on the chain — skip in the
   *  orchestrator. */
  adapterIdx: number | null;
}

export interface ChainSwapRegistry {
  chainId: number;
  /** Canonical UniswapV3 QuoterV2 address on this chain. Used by the
   *  UniV3 quote fetch to read `quoteExactInputSingle` as a view call
   *  before submitting the swap. Null = no QuoterV2 on this chain. */
  uniV3Quoter: string | null;
  /** Canonical UniswapV3 SwapRouter02 address on this chain. Referenced
   *  by the deployed UniV3Adapter at its immutable `router`. The frontend
   *  doesn't call this directly but exposes it so the user can verify
   *  the adapter's target at review time. */
  uniV3Router: string | null;
  /** Canonical Balancer V2 Vault — same address on every EVM. */
  balancerVault: string;
  /** UniswapV3 fee tiers to probe when searching for the best pool,
   *  ordered by popularity. 500 (0.05%), 3000 (0.3%), 10000 (1%). */
  uniV3FeeTiers: readonly number[];
  /** Ordered adapter list — reflects the on-chain `s.swapAdapters`
   *  registration order. */
  adapters: readonly SwapAdapterEntry[];
}

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;

function optIdx(key: string, defaultIdx: number | null): number | null {
  const v = env[key];
  if (v == null || v === '') return defaultIdx;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : defaultIdx;
}

const BALANCER_V2_VAULT_CANONICAL =
  '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

// UniV3 addresses vary per chain; these are the canonical deployments.
// Null on chains without a canonical UniV3 deployment (e.g. BNB Chain
// uses PancakeSwap v3 instead — we don't currently route there).
const UNIV3_DEPLOYMENTS: Record<number, { quoter: string; router: string } | null> = {
  1: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  8453: {
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  },
  42161: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  10: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  1101: null, // Polygon zkEVM — no canonical UniV3 deployment
  56: null,   // BNB Chain — PancakeSwap instead
};

const COMMON_FEE_TIERS = [500, 3000, 10000] as const;

function buildEntry(chainId: number): ChainSwapRegistry {
  const univ3 = UNIV3_DEPLOYMENTS[chainId] ?? null;
  const chainUpper = _chainEnvPrefix(chainId);
  return {
    chainId,
    uniV3Quoter: univ3?.quoter ?? null,
    uniV3Router: univ3?.router ?? null,
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: [
      {
        kind: 'zeroex',
        adapterIdx: optIdx(`VITE_${chainUpper}_ZEROEX_ADAPTER_IDX`, 0),
      },
      {
        kind: 'oneinch',
        adapterIdx: optIdx(`VITE_${chainUpper}_ONEINCH_ADAPTER_IDX`, 1),
      },
      {
        kind: 'univ3',
        adapterIdx: optIdx(
          `VITE_${chainUpper}_UNIV3_ADAPTER_IDX`,
          univ3 ? 2 : null,
        ),
      },
      {
        kind: 'balancerv2',
        adapterIdx: optIdx(`VITE_${chainUpper}_BALANCERV2_ADAPTER_IDX`, 3),
      },
    ],
  };
}

function _chainEnvPrefix(chainId: number): string {
  switch (chainId) {
    case 1:
      return 'ETHEREUM';
    case 8453:
      return 'BASE';
    case 42161:
      return 'ARBITRUM';
    case 10:
      return 'OPTIMISM';
    case 1101:
      return 'ZKEVM';
    case 56:
      return 'BNB';
    default:
      return `CHAIN_${chainId}`;
  }
}

const REGISTRY_BY_CHAIN: Record<number, ChainSwapRegistry> = {
  1: buildEntry(1),
  8453: buildEntry(8453),
  42161: buildEntry(42161),
  10: buildEntry(10),
  1101: buildEntry(1101),
  56: buildEntry(56),
};

export function getSwapRegistry(chainId: number): ChainSwapRegistry | null {
  return REGISTRY_BY_CHAIN[chainId] ?? null;
}

export function adapterIdxFor(
  chainId: number,
  kind: SwapAdapterKind,
): number | null {
  const reg = REGISTRY_BY_CHAIN[chainId];
  if (!reg) return null;
  const e = reg.adapters.find((a) => a.kind === kind);
  return e?.adapterIdx ?? null;
}
