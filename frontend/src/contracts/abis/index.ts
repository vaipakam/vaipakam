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

/** Viem-typed alias for hooks using `encodeFunctionData` /
 *  `decodeFunctionResult` / `useReadContract`. Same data, narrower
 *  type so viem's type inference is happy. */
export const DIAMOND_ABI_VIEM = DIAMOND_ABI as unknown as Abi;
