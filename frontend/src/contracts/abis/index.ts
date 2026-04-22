import OfferFacetABI from './OfferFacet.json';
import LoanFacetABI from './LoanFacet.json';
import RepayFacetABI from './RepayFacet.json';
import DefaultedFacetABI from './DefaultedFacet.json';
import RiskFacetABI from './RiskFacet.json';
import ClaimFacetABI from './ClaimFacet.json';
import OracleFacetABI from './OracleFacet.json';
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
import DiamondLoupeFacetABI from './DiamondLoupeFacet.json';
import MetricsFacetABI from './MetricsFacet.json';
import VPFITokenFacetABI from './VPFITokenFacet.json';
import VPFIDiscountFacetABI from './VPFIDiscountFacet.json';
import StakingRewardsFacetABI from './StakingRewardsFacet.json';
import InteractionRewardsFacetABI from './InteractionRewardsFacet.json';
import VPFIBuyAdapterABI from './VPFIBuyAdapter.json';
import ConfigFacetABI from './ConfigFacet.json';

export {
  OfferFacetABI,
  LoanFacetABI,
  RepayFacetABI,
  DefaultedFacetABI,
  RiskFacetABI,
  ClaimFacetABI,
  OracleFacetABI,
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
  DiamondLoupeFacetABI,
  MetricsFacetABI,
  VPFITokenFacetABI,
  VPFIDiscountFacetABI,
  StakingRewardsFacetABI,
  InteractionRewardsFacetABI,
  VPFIBuyAdapterABI,
  ConfigFacetABI,
};

/** Combined ABI — all facet functions routed through the Diamond proxy */
export const DIAMOND_ABI = [
  ...OfferFacetABI,
  ...LoanFacetABI,
  ...RepayFacetABI,
  ...DefaultedFacetABI,
  ...RiskFacetABI,
  ...ClaimFacetABI,
  ...OracleFacetABI,
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
  ...DiamondLoupeFacetABI,
  ...MetricsFacetABI,
  ...VPFITokenFacetABI,
  ...VPFIDiscountFacetABI,
  ...StakingRewardsFacetABI,
  ...InteractionRewardsFacetABI,
  ...ConfigFacetABI,
];
