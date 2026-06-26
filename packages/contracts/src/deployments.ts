/**
 * Per-chain deployment artifacts — Diamond proxy addresses, facet
 * addresses, vault implementation, LayerZero endpoint + adapter
 * addresses, VPFI token + mirror, reward OApp, mock-token addresses
 * for testnets, etc.
 *
 * Single source of truth: `contracts/deployments/<chain-slug>/addresses.json`
 * — every deploy script writes there. The merge step in
 * `contracts/script/exportFrontendDeployments.sh` consolidates those
 * per-chain files into the single `deployments.json` imported below,
 * keyed by `chainId`.
 *
 * Replaces the dozens of `VITE_<CHAIN>_DIAMOND_ADDRESS` /
 * `VITE_<CHAIN>_VAULT_IMPL` / `VITE_<CHAIN>_*_FACET_ADDRESS` env
 * vars that previously lived in `.env.local`. After a redeploy the
 * operator runs the export script and the frontend bundle picks up
 * the new addresses on the next `vite build` — no manual env edits.
 *
 * Chains absent from the JSON (because `contracts/deployments/<slug>/`
 * doesn't exist yet) simply return `undefined` from `getDeployment`.
 * The chain registry in `config.ts` treats that as "Phase-1 Diamond
 * not deployed here" and gates protocol calls accordingly.
 */
import deploymentsJson from './deployments.json';

/** A 0x-prefixed hex address. Re-declared locally so this module has
 *  no viem dependency — it's consumed by `config.ts`, which does the
 *  EIP-55 normalisation pass. */
type HexAddress = `0x${string}`;

/** Subset of the Diamond's facet selectors the frontend needs by
 *  address (Security-section verify-on-explorer links + the
 *  Transparency card on Analytics). Every facet a deploy script
 *  records is listed here as optional — older deployments or
 *  partial redeploys may not carry every key. */
export interface DeploymentFacets {
  accessControlFacet?: HexAddress;
  addCollateralFacet?: HexAddress;
  adminFacet?: HexAddress;
  claimFacet?: HexAddress;
  configFacet?: HexAddress;
  defaultedFacet?: HexAddress;
  diamondCutFacet?: HexAddress;
  diamondLoupeFacet?: HexAddress;
  earlyWithdrawalFacet?: HexAddress;
  vaultFactoryFacet?: HexAddress;
  interactionRewardsFacet?: HexAddress;
  legalFacet?: HexAddress;
  loanFacet?: HexAddress;
  metricsFacet?: HexAddress;
  offerAcceptFacet?: HexAddress;
  offerCreateFacet?: HexAddress;
  /** Pre-#67 deploys carried a single `offerFacet`; post-#67 deploys
   *  write `offerCreateFacet` + `offerAcceptFacet` instead. Kept so the
   *  type still describes a pre-split deployment's addresses.json. */
  offerFacet?: HexAddress;
  offerMatchFacet?: HexAddress;
  oracleAdminFacet?: HexAddress;
  oracleFacet?: HexAddress;
  ownershipFacet?: HexAddress;
  partialWithdrawalFacet?: HexAddress;
  precloseFacet?: HexAddress;
  profileFacet?: HexAddress;
  refinanceFacet?: HexAddress;
  repayFacet?: HexAddress;
  rewardAggregatorFacet?: HexAddress;
  rewardReporterFacet?: HexAddress;
  riskFacet?: HexAddress;
  stakingRewardsFacet?: HexAddress;
  treasuryFacet?: HexAddress;
  vaipakamNFTFacet?: HexAddress;
  vpfiDiscountFacet?: HexAddress;
  vpfiTokenFacet?: HexAddress;
}

/**
 * Per-chain deployment record. Required fields are present on every
 * chain Vaipakam ships to. Optional fields are scoped — narrow on the
 * boolean discriminators (`isCanonicalVPFI`, `isCanonicalReward`)
 * before consuming the scoped fields, OR check truthiness directly.
 */
export interface Deployment {
  // ── Universal (every chain) ─────────────────────────────────────
  chainId: number;
  chainSlug: string;
  diamond: HexAddress;
  deployBlock: number;
  vaultImpl: HexAddress;
  treasury: HexAddress;
  admin: HexAddress;
  facets: DeploymentFacets;

  // ── CCIP / LayerZero endpoint metadata (every chain that
  //    participates in cross-chain messaging — i.e. every non-anvil
  //    chain). `lzEndpoint` carries the legacy LayerZero V2 endpoint
  //    address for chains still wiring an OFT mirror at deploy time;
  //    the post-T-068 (LayerZero → CCIP, 2026-05-18) reads pass
  //    through the CCIP router resolved from the per-chain
  //    `chainSelector` instead. Optional because anvil leaves these
  //    unset. The `lzEid` field is gone (#230) — CCIP uses
  //    `chainSelector` instead of LayerZero V2 endpoint ids, and the
  //    LZ-era field had no remaining consumer in the post-#234
  //    workspace. ────────────────────────────────────────────────
  lzEndpoint?: HexAddress;

  /** OpenZeppelin TimelockController address. Sits between the
   *  governance multisig and the Diamond on every mainnet deploy.
   *  Optional because pre-handover deploys don't have one — when
   *  unset, the admin dashboard's pending-change indicator soft-
   *  skips. Written by `DeployTimelock.s.sol`. */
  timelock?: HexAddress;

  // ── Discriminators ──────────────────────────────────────────────
  /** True on the chain that hosts the canonical VPFIToken + OFT Adapter
   *  (lock/release). Mirror chains burn/mint via `vpfiMirror`. */
  isCanonicalVPFI?: boolean;
  /** True on the chain that aggregates cross-chain interaction rewards
   *  (Base / Base Sepolia today). Mirror chains report into the
   *  canonical chain via the reward OApp. */
  isCanonicalReward?: boolean;

  // ── VPFI token surface ──────────────────────────────────────────
  /** Live token / OFT-mirror address users hold balances on.
   *  - On the canonical-VPFI chain: equal to `vpfiOftAdapter` (lock/release).
   *  - On mirror chains: equal to `vpfiMirror` (burn/mint OFT).
   *  Always set on chains that participate in VPFI. */
  vpfiToken?: HexAddress;

  /** Canonical-VPFI chain only — UUPS implementation behind `vpfiToken`. */
  vpfiTokenImpl?: HexAddress;

  /** Canonical-VPFI chain only — OFT Adapter (lock/release proxy). */
  vpfiOftAdapter?: HexAddress;
  vpfiOftAdapterImpl?: HexAddress;

  /** Mirror chains only — OFT mirror proxy + UUPS impl behind it. */
  vpfiMirror?: HexAddress;
  vpfiMirrorImpl?: HexAddress;

  // #687: the VPFI buy surface (VpfiBuyReceiver/Adapter + payment token) and its
  // per-chain rate/cap config were removed with the fixed-rate sale — those
  // deployment keys no longer exist. The discount rate that replaced the sale
  // anchor (`setVPFIDiscountRate`) is on-chain runtime config read via
  // `getVPFIDiscountConfig`, not a deployment artifact, so it is not carried here.

  /** Asset whose price feeds the VPFI discount calculation. */
  vpfiDiscountEthPriceAsset?: HexAddress;

  // ── Reward OApp ─────────────────────────────────────────────────
  rewardOApp?: HexAddress;
  rewardOAppBootstrapImpl?: HexAddress;
  rewardOAppRealImpl?: HexAddress;
  // T-068: reward chains key by EVM chain id, not LayerZero endpoint id.
  // A chain's own identity is `block.chainid` (no `rewardLocalEid`).
  rewardBaseChainId?: number;
  rewardGraceSeconds?: number;
  rewardExpectedSourceChainIds?: number[];
  interactionLaunchTimestamp?: string;

  // ── Universal cross-chain plumbing ──────────────────────────────
  weth?: HexAddress;

  /** Optional override for the token-icon URL template used by
   *  `<TokenIcon>` on this specific chain. Two placeholders supported:
   *  `{chainSlug}` (mapped via `TRUST_WALLET_SLUG` in `TokenIcon.tsx`)
   *  and `{address}` (checksummed). Read-precedence on the frontend:
   *
   *    1. `VITE_TOKEN_ICON_URL_TEMPLATE` env var (chain-agnostic
   *       operator override — set in `.env.local` / Cloudflare build
   *       vars).
   *    2. This per-chain field (chain-specific override; useful when
   *       one chain needs a different icon source than the rest, e.g.
   *       a chain with self-hosted icons).
   *    3. Hardcoded default in `TokenIcon.tsx` — Trust Wallet's CDN.
   *
   *  Most deploys leave this unset and rely on the global default.
   *  The chain-slug map gates icon rendering regardless: chains absent
   *  from `TRUST_WALLET_SLUG` short-circuit before any URL is built. */
  tokenIconUrlTemplate?: string;

  // ── Testnet / anvil mock fixtures (omitted on mainnet) ──────────
  mockChainlinkAggregator?: HexAddress;
  mockUniswapV3Factory?: HexAddress;
  mockERC20A?: HexAddress;
  mockERC20B?: HexAddress;
  mockUSDCFeed?: HexAddress;
  mockWBTCFeed?: HexAddress;
  mockWETHFeed?: HexAddress;

  // ── FlashLoanLiquidator (Phase 3 of FlashLoanLiquidationPath.md) ──
  /** Address of the chain-local `FlashLoanLiquidator` receiver
   *  contract that the keeper bot drives for flash-loan-funded
   *  discount-path liquidations. Optional: chains where we haven't
   *  yet run `DeployFlashLoanLiquidator.s.sol` leave it `undefined`,
   *  and the keeper bot silently skips the flash-loan branch on
   *  those chains. External liquidators can deploy their own
   *  equivalent receivers — `triggerLiquidationDiscounted` is
   *  permissionless, this is just OUR reference deployment. */
  flashLoanLiquidator?: HexAddress;

  /** #625 WI-1 — the production keeper bot's signing EOA on this chain.
   *  The dapp's auto-lend surface reads it to delegate the keeper-driven
   *  actions a standing LenderIntent needs (auto-roll, and signed-fill
   *  when the intent is keeper-gated) via `ProfileFacet.approveKeeper`.
   *  Optional: chains where the keeper isn't yet provisioned, or where
   *  the operator hasn't published the address, leave it `undefined` —
   *  the dapp then offers intent registration + funding but hides the
   *  keeper-delegation step (auto-FILL still works; auto-ROLL needs the
   *  grant). It is NOT a contract artifact — the operator pastes the
   *  keeper's public address into each chain's `addresses.json`, and the
   *  merge step folds it through like any other deployment key. Never an
   *  on-chain registry value, so the dapp treats absence as "no keeper
   *  delegation available", not an error. */
  keeperAddress?: HexAddress;

  // ── Deploy metadata ─────────────────────────────────────────────
  deployedAt?: string;
}

/**
 * Raw JSON shape — keys are stringified chainIds (JSON object keys
 * can only be strings). The transform below normalises to numeric
 * keys for ergonomic O(1) lookup against `chainId: number`.
 */
const raw = deploymentsJson as Record<string, Deployment>;

export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = Object.freeze(
  Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [Number(k), v]),
  ),
);

/** Returns the deployment record for a chain, or `undefined` if the
 *  app has no `addresses.json` for that chain (i.e. no Phase-1 deploy
 *  has happened there). Callers that dereference fields must either
 *  null-check or use the discriminator narrowing pattern. */
export function getDeployment(
  chainId: number | null | undefined,
): Deployment | undefined {
  if (chainId == null) return undefined;
  return DEPLOYMENTS[chainId];
}
