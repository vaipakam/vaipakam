// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVaipakamErrors
 * @notice Shared custom errors used across multiple Vaipakam Diamond facets.
 * @dev Facets inherit this interface so each error is declared once.
 *      Facet-specific errors remain in their respective contracts.
 */
interface IVaipakamErrors {
    // ─── Cross-Facet ─────────────────────────────────────────────────────────
    // Legacy free-form fallback. New call sites should use the typed errors
    // below. `CrossFacetCallFailed` is kept only for the few remaining
    // niche sites so that existing integrators/tests keep a stable selector
    // while the migration lands; it is not introduced by LibFacet anymore.
    error CrossFacetCallFailed(string reason);

    // ─── Typed Cross-Facet Failures ──────────────────────────────────────────
    // One error per operation category. When an inner call reverts with its
    // own revert data, LibRevert still re-raises that data verbatim — these
    // typed errors only fire as the fallback when the inner call failed
    // without usable revert data, so they identify "which kind of hop went
    // wrong" rather than duplicating the inner reason string.
    error NFTBurnFailed();
    error NFTMintFailed();
    error NFTStatusUpdateFailed();
    error NFTRenterUpdateFailed();
    error NFTTransferFailed();
    error EscrowResolutionFailed();
    error EscrowWithdrawFailed();
    error EscrowTransferFailed();
    error TreasuryTransferFailed();
    error LoanInitiationFailed();
    error OfferCreationFailed();
    error OfferAcceptFailed();
    error LTVCalculationFailed();
    error HealthFactorCalculationFailed();
    error LenderResolutionFailed();
    error UnauthorizedCrossFacetCall();

    // ─── Access / Identity ───────────────────────────────────────────────────
    error NotBorrower();
    error NotLender();
    error NotNFTOwner();
    error NotOfferCreator();
    error InvalidAddress();
    error InvalidAmount();

    // ─── Loan State ──────────────────────────────────────────────────────────
    error LoanNotActive();
    error InvalidLoanStatus();

    // ─── Risk / Collateral ───────────────────────────────────────────────────
    error HealthFactorTooLow();
    error LTVExceeded();
    error IlliquidAsset();
    error NonLiquidAsset();
    /// @notice Risk-math (LTV / HF / volatility-collapse check) called on a
    ///         loan with at least one illiquid leg (no on-chain price feed).
    ///         The on-chain risk math has no defined value for these loans —
    ///         on default the full collateral is transferred in-kind to the
    ///         lender per the consent both parties signed at offer creation.
    ///         Distinct from `NonLiquidAsset`, which is reserved for runtime
    ///         liquidity-state checks (e.g. live pool depth at liquidation
    ///         time) where the asset *was* liquid at loan-init but isn't
    ///         anymore.
    error IlliquidLoanNoRiskMath();
    /// @notice `repayLoan` rejected because the caller is the loan's
    ///         lender or the current owner of the loan's lender-side
    ///         Vaipakam NFT. Repaying your own loan is economically
    ///         degenerate (lender pays themselves principal+interest minus
    ///         the 1% treasury cut, borrower's collateral is released back
    ///         free) and is almost certainly a misclick. Permissionless
    ///         third-party repayment is still supported for everyone else.
    error LenderCannotRepayOwnLoan();
    error InvalidAsset();
    /// @notice Offer create or accept rejected because the
    ///         abnormal-market liquidation-fallback consent was not granted
    ///         by both parties. Mandatory on every offer regardless of
    ///         liquidity classification.
    error FallbackConsentRequired();
    /// @notice Offer creation rejected because the lending and collateral
    ///         legs reference the same asset contract. Prevents
    ///         self-collateralized positions on a single fungible asset,
    ///         which the ETH-quoted oracle stack no longer special-cases
    ///         via asset classification (the older USDT "always-Illiquid"
    ///         hack is retired).
    error SelfCollateralizedOffer();

    // ─── Oracle ──────────────────────────────────────────────────────────────
    error UpdateNotAllowed();

    // ─── Liquidation / Default ───────────────────────────────────────────────
    error LiquidationFailed();
    error InsufficientProceeds();

    // ─── Compliance ──────────────────────────────────────────────────────────
    error KYCRequired();
    error CountriesNotCompatible();
    error KeeperAccessRequired();
    error KeeperAlreadyApproved();
    error KeeperNotApproved();
    error KeeperWhitelistFull();
    /// @notice Phase 6: the supplied keeper-action bitmask is zero or sets
    ///         bits outside `LibVaipakam.KEEPER_ACTION_ALL`.
    error InvalidKeeperActions();

    // ─── VPFI Discount (docs/TokenomicsTechSpec.md) ─────────────────────────
    /// @notice Fixed-rate VPFI buy attempted on a chain that is not the
    ///         canonical VPFI chain (Base mainnet / Base Sepolia).
    error NotCanonicalVPFIChain();
    /// @notice Fixed-rate VPFI buy attempted while the admin kill-switch is off.
    error VPFIBuyDisabled();
    /// @notice VPFI buy rate has not been configured yet (weiPerVpfi == 0).
    error VPFIBuyRateNotSet();
    /// @notice Fixed-rate buy would exceed the global 200K VPFI cap.
    error VPFIGlobalCapExceeded();
    /// @notice Fixed-rate buy would exceed the per-wallet 2K VPFI cap.
    error VPFIPerWalletCapExceeded();
    /// @notice Msg.value did not produce a non-zero integer number of VPFI.
    error VPFIBuyAmountTooSmall();
    /// @notice Protocol VPFI reserve on the diamond is below the requested
    ///         buy amount. Ops must top up before buys can resume.
    error VPFIReserveInsufficient();
    /// @notice VPFI token has not been registered on this diamond yet
    ///         (VPFITokenFacet.setVPFIToken).
    error VPFITokenNotSet();
    /// @notice No staking rewards pending for the caller at claim time.
    error NoStakingRewardsToClaim();
    /// @notice The 55.2M VPFI staking rewards cap has been fully paid out.
    error StakingPoolExhausted();
    /// @notice Interaction reward emissions have not been started by admin
    ///         (InteractionRewardsFacet.setInteractionLaunchTimestamp).
    error InteractionEmissionsNotStarted();
    /// @notice The caller has already claimed through the latest finalized
    ///         day — no new interaction rewards are available yet.
    error NoInteractionRewardsToClaim();
    /// @notice The 69M VPFI interaction rewards cap has been fully paid out.
    error InteractionPoolExhausted();
    /// @notice The caller's next claimable day does not yet have the
    ///         finalized global denominator broadcast into this chain's
    ///         `knownGlobal*InterestUSD18` slots. Per docs/TokenomicsTechSpec.md
    ///         §4a the local fallback path is gone — claimers wait for the
    ///         Base aggregator to finalize and broadcast the day.
    /// @param dayId First day on the claim cursor that is missing a global.
    error InteractionDayGlobalNotFinalized(uint256 dayId);
    /// @notice User attempted to withdraw more VPFI than their escrow
    ///         currently holds.
    error VPFIEscrowBalanceInsufficient();

    // ─── Cross-Chain Reward Accounting (docs/TokenomicsTechSpec.md §4a) ──────
    /// @notice Aggregator / finalize / broadcast-trigger surface called
    ///         on a non-canonical Diamond (Base is the canonical reward chain).
    error NotCanonicalRewardChain();
    /// @notice Trusted ingress handler invoked by an address other than
    ///         the Diamond's registered `rewardOApp`.
    error NotAuthorizedRewardOApp();
    /// @notice `rewardOApp` has not been configured on this Diamond yet.
    error RewardOAppNotSet();
    /// @notice Mirror-side Diamond has not been told the canonical
    ///         chain's LayerZero eid (`baseEid`) yet.
    error BaseEidNotSet();
    /// @notice Day id in the caller's request is not strictly less than
    ///         the current interaction day — only fully-elapsed days can
    ///         be reported or finalized.
    error RewardDayNotElapsed();
    /// @notice Same `(dayId, sourceEid)` report already received — the
    ///         idempotency key rejects replays to preserve claim determinism.
    error ChainDayAlreadyReported();
    /// @notice A chain report arrived AFTER `dailyGlobalFinalized[dayId]`
    ///         was set. Recorded for audit, not aggregated.
    error ReportAfterFinalization();
    /// @notice `finalizeDay(dayId)` called twice for the same day. The
    ///         first call is authoritative; this preserves downstream
    ///         claim determinism on the broadcast consumers.
    error DayAlreadyFinalized();
    /// @notice `finalizeDay(dayId)` called before every expected mirror
    ///         reported AND before the `rewardGraceSeconds` fallback
    ///         window elapsed.
    error DayNotReadyToFinalize();
    /// @notice `sourceEid` on an inbound chain report is not in the
    ///         Base aggregator's `expectedSourceEids` list.
    error SourceEidNotExpected();
    /// @notice Mirror-side rebroadcast attempted to overwrite a global
    ///         denominator that was already set for the same day with a
    ///         different value.
    error KnownGlobalAlreadySet();

    // ─── Bridged Fixed-Rate VPFI Buy ────────────────────────────────────────
    /// @notice `processBridgedBuy` invoked by an address other than the
    ///         Diamond's registered `bridgedBuyReceiver`.
    error NotBridgedBuyReceiver();
    /// @notice Bridged-buy receiver has not been configured on this Diamond.
    error BridgedBuyReceiverNotSet();

    // ─── Per-Asset Pause ────────────────────────────────────────────────────
    /// @notice Creation path touched an asset that has been paused by
    ///         governance. Exit paths (repay / liquidate / claim / withdraw)
    ///         remain open for existing positions; only NEW exposure through
    ///         this asset is blocked.
    /// @param asset The paused asset that triggered the revert.
    error AssetPaused(address asset);

    // ─── VPFI Fixed-Rate Buy: deploy gate ──────────────────────────────────
    /// @notice Fixed-rate VPFI buy attempted while the canonical Diamond's
    ///         `localEid` has not been configured yet. Without a non-zero
    ///         `localEid` direct-buy debits would land in storage bucket 0,
    ///         while the frontend reads the bucket keyed on the chain
    ///         registry's known LayerZero eid (e.g. 30184 for Base mainnet,
    ///         40245 for Base Sepolia). The buckets would silently desync,
    ///         showing full remaining allowance to a user whose bucket-0
    ///         on-chain total is already at the cap. Operators MUST call
    ///         `RewardReporterFacet.setLocalEid(...)` before flipping
    ///         `setVPFIBuyEnabled(true)` on the canonical Diamond.
    error VPFICanonicalEidNotSet();

    // ─── Permit2 ────────────────────────────────────────────────────────────
    /// @notice Permit2 path rejected because the signed `permit.permitted.token`
    ///         does not match the protocol-expected asset for the action.
    ///         Defends against a frontend bug or malicious frontend tricking
    ///         the user into signing a permit for the wrong ERC-20: without
    ///         this check Permit2 would faithfully pull the signed token,
    ///         while the protocol would record state as if the expected
    ///         asset had been funded.
    /// @param expected The asset the protocol entry point expected.
    /// @param signed   The asset the user signed over in the Permit2 digest.
    error Permit2TokenMismatch(address expected, address signed);
}
