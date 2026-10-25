/**
 * Phase 3 of `docs/DesignsAndPlans/FlashLoanLiquidationPath.md` —
 * per-chain table of flash-loan provider addresses + our own
 * `FlashLoanLiquidator` deployment address.
 *
 * The keeper bot consults this table at every distressed-loan
 * decision point to determine whether the discount path is
 * viable on the current chain. Three things must align:
 *
 *   1. Our `FlashLoanLiquidator` receiver contract is deployed on
 *      this chain (the `liquidator` field is set).
 *   2. At least one flash-loan provider is configured (Aave V3 or
 *      Balancer V2 — usually both, but BNB Chain has no Balancer
 *      V2 and Polygon zkEVM has neither).
 *   3. On-chain `triggerLiquidationDiscounted` has been enabled by
 *      governance (`ConfigFacet.discountPathEnabled` true on that
 *      diamond) — read live from the diamond per loan, as the
 *      `Disabled` status of its discounted-liquidation preview
 *      (#2697), not from this table.
 *
 * All addresses default to `undefined` until we actually deploy
 * the receiver. A chain whose `liquidator` is `undefined` is
 * silently skipped by the discount-path branch in `keeper.ts` —
 * the bot falls through to the existing partial/split/atomic
 * flow.
 *
 * Why this isn't sourced from `@vaipakam/contracts/deployments`:
 * Aave V3 Pool and Balancer V2 Vault are **peer protocol**
 * addresses, not Vaipakam-deployed artifacts. Mixing them into
 * `deployments.json` would conflate "addresses we own" with
 * "addresses external protocols own" — different update cadence,
 * different audit responsibility, different on-chain provenance.
 * Keeping them here in the keeper-bot config makes the boundary
 * explicit.
 */

export interface FlashLoanProviderConfig {
  /**
   * Our deployed `FlashLoanLiquidator` receiver address on this chain.
   * `undefined` = "not deployed yet, skip the discount-path branch
   * entirely on this chain". Will be populated after each chain's
   * deploy step (operational follow-up — the contract is ready,
   * deployments are sequential per the audit-and-flip schedule).
   */
  liquidator?: `0x${string}`;

  /**
   * Aave V3 Pool address on this chain. Sourced from
   * https://aave.com/docs/resources/addresses — verify before
   * pasting. `undefined` means Aave V3 isn't deployed here OR we
   * deliberately don't want to use it; the keeper falls through
   * to Balancer V2 if available.
   */
  aaveV3Pool?: `0x${string}`;

  /**
   * Balancer V2 Vault address. Same on every chain Balancer V2 is
   * deployed on (canonical CREATE2-deployed address). `undefined`
   * = "not on this chain" (BNB doesn't have Balancer V2 per
   * docs.balancer.fi as of training data; Polygon zkEVM unknown).
   */
  balancerV2Vault?: `0x${string}`;
}

/**
 * Per-chain flash-loan config table. Each entry's `liquidator`
 * starts as `undefined` and gets filled in by the operator after
 * a per-chain `DeployFlashLoanLiquidator.s.sol` run lands.
 *
 * Aave V3 Pool addresses sourced from Aave's official address
 * registry. Balancer V2 Vault is the canonical CREATE2 address
 * (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`) on every chain
 * Balancer V2 is deployed on.
 */
export const FLASH_LOAN_PROVIDERS: Record<number, FlashLoanProviderConfig> = {
  // Ethereum mainnet
  1: {
    aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },
  // Base mainnet
  8453: {
    aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },
  // Arbitrum One
  42161: {
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },
  // Optimism
  10: {
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },
  // BNB Chain mainnet — Aave V3 deployed (later launch than the
  // earlier chains); Balancer V2 not deployed per docs.balancer.fi
  // as of training data.
  56: {
    aaveV3Pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  },
  // Polygon PoS mainnet — Aave V3 deployed; Balancer V2 canonical
  // address present.
  137: {
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    balancerV2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },
  // Testnets — flash-loan providers exist but their Aave V3
  // testnet Pools are different per network. Left empty until
  // someone runs the rehearsal; the discount-path branch
  // tolerates `undefined` gracefully.
  84532: {}, // Base Sepolia
  11155111: {}, // Sepolia
  421614: {}, // Arbitrum Sepolia
  11155420: {}, // Optimism Sepolia
  97: {}, // BNB Testnet
};

/** The static half of the discount path on a chain: who to call and how. */
export interface FlashLoanRoute {
  /** Our FlashLoanLiquidator on this chain. */
  liquidator: `0x${string}`;
  /** The provider the run borrows from: Aave V3 first, Balancer V2 otherwise. */
  via: 'aave-v3' | 'balancer-v2';
}

/**
 * #2633 r2 — the ONE reading of this table. The discount branch in
 * `keeper.ts` and the machine's start-up posture line (`discountPath.ts`)
 * both resolve a chain here, so the line cannot call a chain ready that the
 * branch would skip. A chain needs an entry, our liquidator, and at least one
 * provider; `missing` names the first that is absent.
 *
 * Aave V3 is preferred (broader asset coverage, 5 BPS premium), Balancer V2
 * the fallback (zero fee, narrower asset list).
 */
export function flashLoanRoute(
  chainId: number,
  table: Readonly<Record<number, FlashLoanProviderConfig>> = FLASH_LOAN_PROVIDERS,
): { route: FlashLoanRoute } | { missing: string } {
  const cfg = table[chainId];
  if (!cfg) return { missing: 'this build has no flash-loan entry for the chain' };
  if (!cfg.liquidator) return { missing: 'no FlashLoanLiquidator configured' };
  if (cfg.aaveV3Pool) return { route: { liquidator: cfg.liquidator, via: 'aave-v3' } };
  if (cfg.balancerV2Vault) return { route: { liquidator: cfg.liquidator, via: 'balancer-v2' } };
  return { missing: 'no flash-loan provider (Aave V3 pool or Balancer V2 vault) configured' };
}
