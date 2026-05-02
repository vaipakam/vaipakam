/**
 * Per-chain deployment artifacts — Diamond proxy addresses, facet
 * addresses, escrow implementation, LayerZero endpoint + adapter
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
 * `VITE_<CHAIN>_ESCROW_IMPL` / `VITE_<CHAIN>_*_FACET_ADDRESS` env
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
  escrowFactoryFacet?: HexAddress;
  interactionRewardsFacet?: HexAddress;
  legalFacet?: HexAddress;
  loanFacet?: HexAddress;
  metricsFacet?: HexAddress;
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
  escrowImpl: HexAddress;
  treasury: HexAddress;
  admin: HexAddress;
  facets: DeploymentFacets;

  // ── LayerZero V2 (every chain that participates in cross-chain
  //    messaging — i.e. every non-anvil chain). Optional because
  //    anvil leaves these unset. ─────────────────────────────────
  lzEndpoint?: HexAddress;
  lzEid?: number;

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

  // ── VPFI buy surface ────────────────────────────────────────────
  /** Canonical-VPFI chain only — receiver that mints sold VPFI. */
  vpfiBuyReceiver?: HexAddress;
  vpfiBuyReceiverImpl?: HexAddress;
  vpfiBuyReceiverEid?: number;

  /** Mirror chains only — buy adapter that originates cross-chain buys. */
  vpfiBuyAdapter?: HexAddress;
  vpfiBuyAdapterImpl?: HexAddress;

  /** Address used to pay for buys via the adapter. Solidity convention:
   *  `0x0000…0000` means "pay in native gas (ETH/BNB)" — preserved as
   *  the zero-address sentinel here because that's a meaningful runtime
   *  value, not a missing field. Consumers map zero → null at the
   *  boundary if they prefer the JS-idiom representation. */
  vpfiBuyPaymentToken?: HexAddress;

  /** Asset whose price feeds the VPFI discount calculation. */
  vpfiDiscountEthPriceAsset?: HexAddress;

  /** Per-chain hard caps and rate config for the buy adapter. */
  vpfiBuyWeiPerVpfi?: number | string;
  vpfiBuyGlobalCap?: number | string;
  vpfiBuyPerWalletCap?: number | string;
  vpfiBuyEnabled?: boolean;

  // ── Reward OApp ─────────────────────────────────────────────────
  rewardOApp?: HexAddress;
  rewardOAppBootstrapImpl?: HexAddress;
  rewardOAppRealImpl?: HexAddress;
  rewardLocalEid?: number;
  rewardBaseEid?: number;
  rewardGraceSeconds?: number;
  rewardExpectedSourceEids?: number[];
  interactionLaunchTimestamp?: string;

  // ── Universal cross-chain plumbing ──────────────────────────────
  weth?: HexAddress;

  // ── Testnet / anvil mock fixtures (omitted on mainnet) ──────────
  mockChainlinkAggregator?: HexAddress;
  mockUniswapV3Factory?: HexAddress;
  mockERC20A?: HexAddress;
  mockERC20B?: HexAddress;
  mockUSDCFeed?: HexAddress;
  mockWBTCFeed?: HexAddress;
  mockWETHFeed?: HexAddress;

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
