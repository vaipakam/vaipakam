import OfferFacetABI from './OfferFacet.json';
import OfferCancelFacetABI from './OfferCancelFacet.json';
import OfferMatchFacetABI from './OfferMatchFacet.json';
import LoanFacetABI from './LoanFacet.json';
import RepayFacetABI from './RepayFacet.json';
import DefaultedFacetABI from './DefaultedFacet.json';
import RiskFacetABI from './RiskFacet.json';
import ClaimFacetABI from './ClaimFacet.json';
import OracleFacetABI from './OracleFacet.json';
import OracleAdminFacetABI from './OracleAdminFacet.json';
import EscrowFactoryFacetABI from './EscrowFactoryFacet.json';
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
import StakingRewardsFacetABI from './StakingRewardsFacet.json';
import InteractionRewardsFacetABI from './InteractionRewardsFacet.json';
// T-068 renamed these contracts VPFIBuyAdapter/VPFIBuyReceiver →
// VpfiBuyAdapter/VpfiBuyReceiver when the cross-chain buy flow moved
// from LayerZero to CCIP. The export identifiers stay stable so
// consumers are untouched; only the JSON source is re-pointed.
import VPFIBuyAdapterABI from './VpfiBuyAdapter.json';
import VPFIBuyReceiverABI from './VpfiBuyReceiver.json';
import RewardReporterFacetABI from './RewardReporterFacet.json';
import ConfigFacetABI from './ConfigFacet.json';
import LegalFacetABI from './LegalFacet.json';
// FlashLoanLiquidationPath.md Phase 3 — standalone reference
// receiver. Named export only; deliberately NOT spread into
// DIAMOND_ABI below (it's not part of the diamond's selector set).
import FlashLoanLiquidatorABI from './FlashLoanLiquidator.json';

export {
  OfferFacetABI,
  OfferCancelFacetABI,
  OfferMatchFacetABI,
  LoanFacetABI,
  RepayFacetABI,
  DefaultedFacetABI,
  RiskFacetABI,
  ClaimFacetABI,
  OracleFacetABI,
  OracleAdminFacetABI,
  EscrowFactoryFacetABI,
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
  StakingRewardsFacetABI,
  InteractionRewardsFacetABI,
  VPFIBuyAdapterABI,
  VPFIBuyReceiverABI,
  RewardReporterFacetABI,
  ConfigFacetABI,
  LegalFacetABI,
  FlashLoanLiquidatorABI,
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
  ...OfferFacetABI,
  ...OfferCancelFacetABI,
  ...OfferMatchFacetABI,
  ...LoanFacetABI,
  ...RepayFacetABI,
  ...DefaultedFacetABI,
  ...RiskFacetABI,
  ...ClaimFacetABI,
  ...OracleFacetABI,
  ...OracleAdminFacetABI,
  ...EscrowFactoryFacetABI,
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
  ...StakingRewardsFacetABI,
  ...InteractionRewardsFacetABI,
  ...RewardReporterFacetABI,
  ...ConfigFacetABI,
  ...LegalFacetABI,
];

/** Viem-typed alias for hooks using `encodeFunctionData` /
 *  `decodeFunctionResult` / `useReadContract`. Same data, narrower
 *  type so viem's type inference is happy. */
export const DIAMOND_ABI_VIEM = DIAMOND_ABI as unknown as Abi;
