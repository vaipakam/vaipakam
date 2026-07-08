import OfferCreateFacetABI from './OfferCreateFacet.json';
// #396 v0.5 — gasless signed off-chain offer book fill surface.
import SignedOfferFacetABI from './SignedOfferFacet.json';
// #393 v1 — LenderIntentVault standing-terms surface.
import LenderIntentFacetABI from './LenderIntentFacet.json';
// #398 v1.5 — ERC-4626 aggregator adapter factory (facet) + the adapter impl
// (standalone per-aggregator contract; named export only, NOT spread into the
// combined Diamond ABI since its functions live on the adapter, not the Diamond).
import AggregatorAdapterFactoryFacetABI from './AggregatorAdapterFactoryFacet.json';
import AggregatorAdapterImplementationABI from './AggregatorAdapterImplementation.json';
import BackstopFacetABI from './BackstopFacet.json';
import ConsolidationFacetABI from './ConsolidationFacet.json';
// #671 — self-sovereign progressive risk-access facet.
import RiskAccessFacetABI from './RiskAccessFacet.json';
// #1104 — read-only risk preview cluster + cross-facet gate asserts, split
// off RiskAccessFacet for EIP-170 headroom.
import RiskPreviewFacetABI from './RiskPreviewFacet.json';
import BackstopVaultImplementationABI from './BackstopVaultImplementation.json';
import OfferAcceptFacetABI from './OfferAcceptFacet.json';
import OfferPreviewFacetABI from './OfferPreviewFacet.json';
import OfferCancelFacetABI from './OfferCancelFacet.json';
import OfferMatchFacetABI from './OfferMatchFacet.json';
import OfferMutateFacetABI from './OfferMutateFacet.json';
// T-086 Round-8 (#358) — borrow-OR-sell parallel-sale entry +
// non-destructive unwind. Carved off OfferCreateFacet so solc's viaIR
// jump-table reservation stays under the "Tag too large" ICE ceiling.
import OfferParallelSaleFacetABI from './OfferParallelSaleFacet.json';
import LoanFacetABI from './LoanFacet.json';
import RepayFacetABI from './RepayFacet.json';
// Issue #66 — periodic-interest + NFT-rental daily-deduction cluster
// split out of RepayFacet to stay under the EIP-170 runtime-size limit.
import RepayPeriodicFacetABI from './RepayPeriodicFacet.json';
// T-090 — Borrower-initiated swap-to-repay surface. Swaps collateral
// asset → principal asset and applies the proceeds to a full or partial
// loan repay in one transaction.
import SwapToRepayFacetABI from './SwapToRepayFacet.json';
// T-090 v1.1 (#389) — intent-based swap-to-repay sibling facet.
import SwapToRepayIntentFacetABI from './SwapToRepayIntentFacet.json';
// T-087 Sub 3.B — 1inch LOP v4 callback dispatcher.
import IntentDispatchFacetABI from './IntentDispatchFacet.json';
import AutoLifecycleFacetABI from './AutoLifecycleFacet.json';
import EncumbranceMutateFacetABI from './EncumbranceMutateFacet.json';
import IntentConfigFacetABI from './IntentConfigFacet.json';
import DefaultedFacetABI from './DefaultedFacet.json';
import RiskFacetABI from './RiskFacet.json';
import RiskMatchLiquidationFacetABI from './RiskMatchLiquidationFacet.json';
import RiskSplitLiquidationFacetABI from './RiskSplitLiquidationFacet.json';
import ClaimFacetABI from './ClaimFacet.json';
import OracleFacetABI from './OracleFacet.json';
import OracleAdminFacetABI from './OracleAdminFacet.json';
import VaultFactoryFacetABI from './VaultFactoryFacet.json';
import VaipakamNFTFacetABI from './VaipakamNFTFacet.json';
import ProfileFacetABI from './ProfileFacet.json';
import AdminFacetABI from './AdminFacet.json';
import AddCollateralFacetABI from './AddCollateralFacet.json';
import PartialWithdrawalFacetABI from './PartialWithdrawalFacet.json';
import PrecloseFacetABI from './PrecloseFacet.json';
import RefinanceFacetABI from './RefinanceFacet.json';
import EarlyWithdrawalFacetABI from './EarlyWithdrawalFacet.json';
import TreasuryFacetABI from './TreasuryFacet.json';
import PayrollFacetABI from './PayrollFacet.json';
import DiamondLoupeFacetABI from './DiamondLoupeFacet.json';
import MetricsFacetABI from './MetricsFacet.json';
import MetricsDashboardFacetABI from './MetricsDashboardFacet.json';
import VPFITokenFacetABI from './VPFITokenFacet.json';
import VPFIDiscountFacetABI from './VPFIDiscountFacet.json';
// T-087 Sub 1.B — accumulator facet carved off LibVPFIDiscount.
import VPFIDiscountAccumulatorFacetABI from './VPFIDiscountAccumulatorFacet.json';
// T-087 Sub 2.C — mirror-side tier-push receiver facet.
import MirrorTierReceiverFacetABI from './MirrorTierReceiverFacet.json';
// T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
import ProtocolBroadcastFacetABI from './ProtocolBroadcastFacet.json';
import InteractionRewardsFacetABI from './InteractionRewardsFacet.json';
// #687-A removed the cross-chain VPFI buy contracts (VpfiBuyAdapter /
// VpfiBuyReceiver) along with the fixed-rate sale.
import RewardReporterFacetABI from './RewardReporterFacet.json';
import RewardAggregatorFacetABI from './RewardAggregatorFacet.json';
import RewardRemittanceFacetABI from './RewardRemittanceFacet.json';
import ConfigFacetABI from './ConfigFacet.json';
import NumeraireConfigFacetABI from './NumeraireConfigFacet.json';
import LegalFacetABI from './LegalFacet.json';
// T-086 step 5 — executor↔diamond trust boundary for Seaport
// prepay collateral sales (see contracts/src/seaport/CollateralListingExecutor.sol).
import PrepayListingFacetABI from './PrepayListingFacet.json';
// T-086 step 6 — borrower-facing post / update / cancel / cancelExpired
// entry points for the FIXED-PRICE prepay listing flow.
import NFTPrepayListingFacetABI from './NFTPrepayListingFacet.json';
// T-086 Round-5 Block B (#309) — Dutch-decay post + update sibling
// facet. Shares LibVaipakam storage with NFTPrepayListingFacet;
// split for solc jump-table budget reasons (see facet natspec).
import NFTPrepayDutchListingFacetABI from './NFTPrepayDutchListingFacet.json';
// T-086 Round-6 / Block D (#345) — atomic match-rotation entry
// point via Seaport matchAdvancedOrders. Sibling facet sharing
// LibVaipakam storage with NFTPrepayListingFacet; kills the v1
// English-mode race window §15.3 deliberately accepted.
import NFTPrepayListingAtomicFacetABI from './NFTPrepayListingAtomicFacet.json';
// T-086 Round-7 (#355) — permissionless grace-period
// `autoListAtFloorOnGrace` entry point. Sibling facet sharing
// LibVaipakam storage with the other three prepay-listing facets.
import NFTPrepayAutoListFacetABI from './NFTPrepayAutoListFacet.json';
// FlashLoanLiquidationPath.md Phase 3 — standalone reference
// receiver. Named export only; deliberately NOT spread into
// DIAMOND_ABI below (it's not part of the diamond's selector set).
import FlashLoanLiquidatorABI from './FlashLoanLiquidator.json';
// #394 Lever B — standalone dual-factor risk-premium rate model (an
// `IRateModel` registered via `AdminFacet.setRateModel`). Named export only;
// deliberately NOT spread into DIAMOND_ABI below (not part of the diamond's
// selector set) — admin tooling / keeper call it as a separate contract.
import RiskPremiumRateModelABI from './RiskPremiumRateModel.json';

export {
  OfferCreateFacetABI,
  SignedOfferFacetABI,
  LenderIntentFacetABI,
  AggregatorAdapterFactoryFacetABI,
  AggregatorAdapterImplementationABI,
  BackstopFacetABI,
  BackstopVaultImplementationABI,
  ConsolidationFacetABI,
  RiskAccessFacetABI,
  RiskPreviewFacetABI,
  OfferAcceptFacetABI,
  OfferPreviewFacetABI,
  OfferCancelFacetABI,
  OfferMatchFacetABI,
  OfferMutateFacetABI,
  OfferParallelSaleFacetABI,
  LoanFacetABI,
  RepayFacetABI,
  RepayPeriodicFacetABI,
  SwapToRepayFacetABI,
  SwapToRepayIntentFacetABI,
  IntentDispatchFacetABI,
  AutoLifecycleFacetABI,
  EncumbranceMutateFacetABI,
  IntentConfigFacetABI,
  DefaultedFacetABI,
  RiskFacetABI,
  RiskMatchLiquidationFacetABI,
  RiskSplitLiquidationFacetABI,
  ClaimFacetABI,
  OracleFacetABI,
  OracleAdminFacetABI,
  VaultFactoryFacetABI,
  VaipakamNFTFacetABI,
  ProfileFacetABI,
  AdminFacetABI,
  AddCollateralFacetABI,
  PartialWithdrawalFacetABI,
  PrecloseFacetABI,
  RefinanceFacetABI,
  EarlyWithdrawalFacetABI,
  TreasuryFacetABI,
  PayrollFacetABI,
  DiamondLoupeFacetABI,
  MetricsFacetABI,
  MetricsDashboardFacetABI,
  VPFITokenFacetABI,
  VPFIDiscountFacetABI,
  VPFIDiscountAccumulatorFacetABI,
  MirrorTierReceiverFacetABI,
  ProtocolBroadcastFacetABI,
  InteractionRewardsFacetABI,
  RewardReporterFacetABI,
  RewardAggregatorFacetABI,
  RewardRemittanceFacetABI,
  ConfigFacetABI,
  NumeraireConfigFacetABI,
  LegalFacetABI,
  PrepayListingFacetABI,
  NFTPrepayListingFacetABI,
  NFTPrepayDutchListingFacetABI,
  NFTPrepayListingAtomicFacetABI,
  NFTPrepayAutoListFacetABI,
  FlashLoanLiquidatorABI,
  RiskPremiumRateModelABI,
};

import type { Abi } from 'viem';

/** Combined ABI — all facet functions routed through the Diamond proxy.
 *  Kept as the JSON-inferred shape because the ethers `Interface`/
 *  `Contract` constructors want `JsonFragment[]` (which the JSON imports
 *  match), while viem wants the narrower `Abi`. Viem consumers cast via
 *  `DIAMOND_ABI_VIEM` below; ethers consumers pass `DIAMOND_ABI`
 *  directly. Once Phase B-full is complete and the last ethers call site
 *  is gone, collapse this back to a single `Abi`-typed export. */
export const DIAMOND_ABI = [
  ...OfferCreateFacetABI,
  ...SignedOfferFacetABI,
  ...LenderIntentFacetABI,
  // #398 — AggregatorAdapterFactoryFacet IS a Diamond facet → spread into the
  // combined Diamond ABI. AggregatorAdapterImplementation is a STANDALONE
  // adapter contract (named export above only) — deliberately NOT spread here.
  ...AggregatorAdapterFactoryFacetABI,
  // #399 — BackstopFacet IS a Diamond facet → spread. BackstopVaultImplementation
  // is the STANDALONE treasury vault (named export above only) — NOT spread here.
  ...BackstopFacetABI,
  // #594 — ConsolidationFacet IS a Diamond facet -> spread.
  ...ConsolidationFacetABI,
  // #671 — RiskAccessFacet IS a Diamond facet -> spread.
  ...RiskAccessFacetABI,
  // #1104 — RiskPreviewFacet IS a Diamond facet -> spread.
  ...RiskPreviewFacetABI,
  ...OfferAcceptFacetABI,
  ...OfferPreviewFacetABI,
  ...OfferCancelFacetABI,
  ...OfferMatchFacetABI,
  ...OfferMutateFacetABI,
  ...OfferParallelSaleFacetABI,
  ...LoanFacetABI,
  ...RepayFacetABI,
  ...RepayPeriodicFacetABI,
  ...SwapToRepayFacetABI,
  ...SwapToRepayIntentFacetABI,
  ...IntentDispatchFacetABI,
  ...AutoLifecycleFacetABI,
  ...EncumbranceMutateFacetABI,
  ...IntentConfigFacetABI,
  ...DefaultedFacetABI,
  ...RiskFacetABI,
  ...RiskMatchLiquidationFacetABI,
  ...RiskSplitLiquidationFacetABI,
  ...ClaimFacetABI,
  ...OracleFacetABI,
  ...OracleAdminFacetABI,
  ...VaultFactoryFacetABI,
  ...VaipakamNFTFacetABI,
  ...ProfileFacetABI,
  ...AdminFacetABI,
  ...AddCollateralFacetABI,
  ...PartialWithdrawalFacetABI,
  ...PrecloseFacetABI,
  ...RefinanceFacetABI,
  ...EarlyWithdrawalFacetABI,
  ...TreasuryFacetABI,
  ...PayrollFacetABI,
  ...DiamondLoupeFacetABI,
  ...MetricsFacetABI,
  ...MetricsDashboardFacetABI,
  ...VPFITokenFacetABI,
  ...VPFIDiscountFacetABI,
  ...VPFIDiscountAccumulatorFacetABI,
  ...MirrorTierReceiverFacetABI,
  ...ProtocolBroadcastFacetABI,
  ...InteractionRewardsFacetABI,
  ...RewardReporterFacetABI,
  ...RewardAggregatorFacetABI,
  ...RewardRemittanceFacetABI,
  ...ConfigFacetABI,
  ...NumeraireConfigFacetABI,
  ...LegalFacetABI,
  ...PrepayListingFacetABI,
  ...NFTPrepayListingFacetABI,
  ...NFTPrepayDutchListingFacetABI,
  ...NFTPrepayListingAtomicFacetABI,
  ...NFTPrepayAutoListFacetABI,
];

/** Viem-typed alias for hooks using `encodeFunctionData` /
 *  `decodeFunctionResult` / `useReadContract`. Same data, narrower
 *  type so viem's type inference is happy. */
export const DIAMOND_ABI_VIEM = DIAMOND_ABI as unknown as Abi;
