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
    /// @notice A governance-tunable parameter setter rejected the
    ///         write because the new value sits outside its
    ///         compiled-in min/max range. The `name` is a short
    ///         bytes32 tag for the parameter (e.g.
    ///         `bytes32("pythNumeraireMaxDeviationBps")`) so callers
    ///         can disambiguate without parsing reverts. Used as the
    ///         shared "every governance knob is bounded" error —
    ///         even a compromised admin / governance multisig can't
    ///         push a tunable beyond the policy range without a
    ///         contract upgrade.
    error ParameterOutOfRange(bytes32 name, uint256 value, uint256 min, uint256 max);

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

    // ─── T-034 — Periodic Interest Payment ──────────────────────────────────
    /// @notice Master kill-switch is off — cadence != None blocked at
    ///         `createOffer`, and `settlePeriodicInterest` (PR2) is
    ///         entirely closed. See LibVaipakam.ProtocolConfig
    ///         `periodicInterestEnabled`.
    error PeriodicInterestDisabled();

    /// @notice Filter 1 / Filter 2 violation at `createOffer`. The
    ///         lender picked a cadence whose interval is ≥ duration
    ///         (Filter 1 — interval not strictly less than duration),
    ///         OR whose duration / threshold combination is outside
    ///         the matrix in
    ///         docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
    /// @param cadence The cadence value the lender chose.
    /// @param duration The loan duration in days.
    /// @param principalNumeraire The principal value in numeraire-units
    ///        (1e18-scaled), as resolved at create time via the
    ///        configured `numeraireOracle` (or USD direct when unset).
    /// @param threshold The current
    ///        `minPrincipalForFinerCadence` value in numeraire-units.
    error CadenceNotAllowed(
        uint8 cadence,
        uint256 duration,
        uint256 principalNumeraire,
        uint256 threshold
    );

    /// @notice Filter 0 violation at `createOffer`. Either the lending
    ///         asset OR the collateral asset is illiquid AND the
    ///         lender tried to set a cadence other than `None`.
    ///         Periodic settlement is only meaningful when both sides
    ///         can be auto-liquidated; illiquid loans must run on the
    ///         terminal-only path. See design doc §3.0.
    /// @param principalLiquidity 0 = Liquid, 1 = Illiquid.
    /// @param collateralLiquidity 0 = Liquid, 1 = Illiquid.
    /// @param cadence The cadence value the lender chose.
    error CadenceNotAllowedForIlliquid(
        uint8 principalLiquidity,
        uint8 collateralLiquidity,
        uint8 cadence
    );

    /// @notice Cross-numeraire batched setter `setNumeraire` is
    ///         gated by the `numeraireSwapEnabled` flag. Threshold-
    ///         only updates via `setMinPrincipalForFinerCadence` are
    ///         NOT gated by this error. See design doc §10.2.
    error NumeraireSwapDisabled();

    /// @notice `setNumeraire` rejected the new oracle address — it has
    ///         no bytecode, OR `numeraireToUsdRate1e18()` returned
    ///         zero, OR the call reverted. Sanity check at setter time
    ///         so a misconfig can't lock the protocol with a broken
    ///         numeraire that reverts on every read.
    /// @param oracle The proposed oracle address.
    error NumeraireOracleInvalid(address oracle);

    /// @notice `settlePeriodicInterest` was called before the period's
    ///         grace window expired. Settler must wait until
    ///         `lastPeriodicInterestSettledAt + intervalDays(cadence) +
    ///         gracePeriod(intervalDays)` before retrying.
    /// @param loanId Loan identifier.
    /// @param dueAt Period boundary (inclusive of grace).
    /// @param graceEndsAt Earliest timestamp at which settle is allowed.
    error PeriodicSettleNotDue(uint256 loanId, uint256 dueAt, uint256 graceEndsAt);

    /// @notice `settlePeriodicInterest` cannot operate on this loan —
    ///         either the cadence is None (terminal-only repayment) or
    ///         the loan isn't in `Active` status.
    error PeriodicSettleNotApplicable(uint256 loanId);

    /// @notice Auto-liquidate path required a swap, but the settler
    ///         provided an empty `adapterCalls` list. Settle reverts
    ///         rather than emitting a soft-fail event because the
    ///         shortfall cannot be covered without selling collateral.
    error PeriodicSettleSwapPathRequired(uint256 loanId, uint256 shortfall);

    /// @notice Auto-liquidate path attempted but every adapter in the
    ///         supplied try-list reverted. Period is still due —
    ///         settler must retry with a fresh quote / different venues.
    error PeriodicSettleSwapFailed(uint256 loanId);

    /// @notice `refinanceLoan` called while the old loan's current
    ///         periodic-interest period is overdue past its grace
    ///         window. Caller must first run `settlePeriodicInterest`
    ///         on the old loan so the original lender is made whole
    ///         BEFORE the refinance overwrites the loan's state.
    /// @param oldLoanId The loan being refinanced.
    /// @param graceEndsAt Timestamp from which a settler call would be
    ///        accepted on the old loan (i.e. the moment the refinance
    ///        gate first failed).
    error RefinanceRequiresPeriodSettle(uint256 oldLoanId, uint256 graceEndsAt);
}
