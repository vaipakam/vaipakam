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
    /// @notice #1503 item 12 — the sale-settlement reward migration self-call
    ///         failed WITHOUT returndata (with returndata the inner revert is
    ///         rethrown verbatim instead). Sale settlement is atomic with the
    ///         reward migration because every quote discloses the seller's
    ///         forfeiture and the buyer's residual entry; on a properly-cut
    ///         diamond the transfer body cannot revert, so in practice this
    ///         marks deploy drift (InteractionRewardsFacet unrouted).
    error RewardMigrationFailed();
    error NFTMintFailed();
    error NFTStatusUpdateFailed();
    error NFTRenterUpdateFailed();
    error NFTTransferFailed();
    error VaultResolutionFailed();
    error VaultWithdrawFailed();
    error VaultDepositFailed();
    error VaultTransferFailed();
    /// @dev Stuck-token recovery: caller passed an `amount` greater
    ///      than `max(0, balanceOf(vault, token) - tracked)`. The
    ///      cap is the load-bearing safety property — recovery can
    ///      never reach into protocol-tracked collateral / claims.
    error RecoveryAmountExceedsUnsolicited();
    /// @dev Stuck-token recovery: zero-amount call.
    error RecoveryAmountZero();
    /// @dev Stuck-token recovery: caller-supplied deadline already
    ///      passed.
    error RecoveryDeadlineExpired();
    /// @dev Stuck-token recovery: signature does not recover to
    ///      `msg.sender` for the supplied payload.
    error RecoverySignatureInvalid();
    /// @dev Stuck-token recovery: caller has no vault proxy
    ///      deployed — nothing to recover from.
    error RecoveryUserHasNoVault();
    /// @dev Stuck-token recovery: user declared a source address that
    ///      the sanctions oracle flags. Their vault has been LOCKED
    ///      under the existing sanctioned-address Tier-1 / Tier-2
    ///      semantics; the ban auto-unlocks when the address is
    ///      de-listed from the oracle.
    error VaultBannedDueToSanctionedSource();
    /// @dev Stuck-token recovery: sanctions oracle is currently
    ///      unset OR returned an error. Fail-safe: refuse to execute
    ///      until the oracle is reachable.
    error SanctionsOracleUnavailable();
    /// @dev Stuck-token recovery: caller's vault is already locked
    ///      under a previously-recorded sanctioned-source ban; the
    ///      ban hasn't lifted (oracle still flags the source).
    error VaultAlreadyBanned();
    error TreasuryTransferFailed();
    error LoanInitiationFailed();
    error OfferCreationFailed();
    error OfferAcceptFailed();
    error LTVCalculationFailed();
    error HealthFactorCalculationFailed();
    error LenderResolutionFailed();
    error UnauthorizedCrossFacetCall();
    /// @notice #1347 — the post-mint Full VPFI tariff cross-facet charge failed
    ///         without a typed reason (the specific opt-in failures —
    ///         disabled / above-auth / vault-short — bubble their own errors).
    error FeeEntitlementChargeFailed();
    /// @notice #1347 — a Full VPFI tariff opt-in was authorized without the
    ///         MANDATORY absolute `maxCStar` ceiling (rev-15 §3). Every Full
    ///         authorization must bound its worst-case tariff.
    error FullTariffMaxCStarRequired();
    /// @notice #1347 — attempted to enable the Full VPFI tariff on a
    ///         non-canonical (mirror) VPFI chain, where an absorbed `C*` would
    ///         strand in a mirror-local recycle bucket the Base reward governor
    ///         cannot fund until the cross-chain mesh is live.
    error FeeEntitlementRequiresCanonicalVpfiChain();

    // ─── Access / Identity ───────────────────────────────────────────────────
    error NotBorrower();
    error NotLender();
    error NotNFTOwner();
    /// @notice #594 — a standalone consolidation was attempted on a position in
    ///         an excluded live state (e.g. FallbackPending, a live prepay
    ///         listing, or a live swap-to-repay intent). Eager hooks skip these
    ///         silently; the explicit caller gets this revert.
    error ConsolidationNotAllowed();
    error NotOfferCreator();
    error InvalidAddress();
    error InvalidAmount();
    /// @notice A governance-tunable parameter setter rejected the
    ///         write because the new value sits outside its
    ///         compiled-in min/max range. The `name` is a short
    ///         bytes32 tag for the parameter (e.g.
    ///         `bytes32("pythCrossCheckMaxDeviationBps")`) so callers
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
    /// @notice Depth-tiered LTV (Piece B): the loan's init-LTV exceeds the
    ///         cap for the collateral's effective liquidity tier
    ///         (`min(assetRiskParams.loanInitMaxLtvBps, tierMaxInitLtvBps[
    ///         effectiveTier])`). Only thrown while `depthTieredLtvEnabled`;
    ///         a Tier-0 (illiquid / untierable) collateral makes the cap
    ///         `0`, so any positive LTV reverts this.
    error InitLtvAboveTier(uint256 ltv, uint256 tierCapBps);
    /// @notice #662 — the illiquid LTV/HF bypass was reached for a leg the
    ///         acceptor's signed `AcceptTerms` did not name as that exact
    ///         illiquid asset. Enforced at the bypass site
    ///         (`LoanFacet._maybeRunInitialRiskGates`) against the same
    ///         liquidity classification that authorises the bypass.
    error IlliquidAssetNotAcknowledged(address leg);
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
    error RiskAndTermsConsentRequired();
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
    /// @notice Canonical-chain-only operation attempted on a non-canonical
    ///         VPFI chain (the canonical chain is Base mainnet / Base Sepolia).
    /// @dev #687-A removed the issuer fixed-rate sale; this error now guards
    ///      the remaining canonical-only TreasuryFacet path.
    error NotCanonicalVPFIChain();
    /// @notice VPFI token has not been registered on this diamond yet
    ///         (VPFITokenFacet.setVPFIToken).
    error VPFITokenNotSet();
    /// @notice Interaction reward emissions have not been started by admin
    ///         (InteractionRewardsFacet.setInteractionLaunchTimestamp).
    error InteractionEmissionsNotStarted();
    /// @notice The caller has already claimed through the latest finalized
    ///         day — no new interaction rewards are available yet.
    error NoInteractionRewardsToClaim();
    /// @notice The 69M VPFI interaction rewards cap has been fully paid out.
    error InteractionPoolExhausted();

    /// @notice #1434 P1-b — RETAINED DELIBERATELY though currently unreached.
    ///         r18 moved the mirror's delivered-fresh refusal from a
    ///         whole-sweep revert to a PER-DAY defer inside the settlement
    ///         engine, so nothing raises this today. Kept rather than removed
    ///         because removing it rewrites all 41 facet ABIs for zero runtime
    ///         gain; retirement is tracked as a follow-up.
    /// @param needed    Armed fresh the action would have spent.
    /// @param available Remaining delivered-less-paid allowance.
    error DeliveredFreshShortfall(uint256 needed, uint256 available);

    /// @notice #1434 P1-b (Codex #1699 r2) — the one-shot pre-P1-b paid-side
    ///         migration seed has already run on this chain.
    /// @dev    One-shot on purpose: the seed ADDS to the paid counter, so a
    ///         second call would double-charge the bound and strand funding.
    error ArmedFreshPaidAlreadySeeded();
    /// @notice #1460 — the claim's FRESH component exceeds the un-earmarked
    ///         VPFI behind it (`balanceOf(diamond) - recycleBucket`), so
    ///         paying it would leave the recycle bucket claiming tokens that
    ///         are no longer there. Raised on ANY shortfall, partial or
    ///         total — `backingRoom` is frequently non-zero. Distinct from
    ///         {InteractionPoolExhausted}: the 69M schedule may have ample
    ///         headroom while the tokens to honour it have not arrived (a
    ///         mirror whose fresh remit is still in flight, or a deployment
    ///         thin on un-earmarked balance). A FUNDING state, not a
    ///         terminal one — the same claim succeeds once backing lands,
    ///         and the two figures below say how much must land first.
    /// @param requiredFresh Combined fresh BACKING this claim requires after
    ///                      the 69M cap has been applied: the claimant's
    ///                      fresh payout plus the fresh share of any forfeit
    ///                      credited to the recycle bucket. Not a payout
    ///                      figure — the forfeit share never leaves Diamond
    ///                      custody, it is re-labelled into the bucket — and
    ///                      not the raw entitlement, which the cap may
    ///                      already have reduced.
    /// @param backingRoom   Un-earmarked balance actually available.
    error InteractionRewardBackingShort(
        uint256 requiredFresh,
        uint256 backingRoom
    );
    /// @notice The caller's next claimable day does not yet have the
    ///         finalized global denominator broadcast into this chain's
    ///         `knownGlobal*InterestNumeraire18` slots. Per docs/TokenomicsTechSpec.md
    ///         §4a the local fallback path is gone — claimers wait for the
    ///         Base aggregator to finalize and broadcast the day.
    /// @param dayId First day on the claim cursor that is missing a global.
    error InteractionDayGlobalNotFinalized(uint256 dayId);
    /// @notice User attempted to withdraw more VPFI than their vault
    ///         currently holds.
    error VPFIVaultBalanceInsufficient();

    // ─── Cross-Chain Reward Accounting (docs/TokenomicsTechSpec.md §4a) ──────
    /// @notice Aggregator / finalize / broadcast-trigger surface called
    ///         on a non-canonical Diamond (Base is the canonical reward chain).
    error NotCanonicalRewardChain();
    /// @notice Trusted ingress handler invoked by an address other than
    ///         the Diamond's registered `rewardMessenger`.
    error NotAuthorizedRewardMessenger();
    /// @notice `rewardMessenger` has not been configured on this Diamond yet.
    error RewardMessengerNotSet();
    /// @notice Mirror-side Diamond has not been told the canonical
    ///         reward chain's EVM chain id (`baseChainId`) yet.
    error BaseChainIdNotSet();
    /// @notice Day id in the caller's request is not strictly less than
    ///         the current interaction day — only fully-elapsed days can
    ///         be reported or finalized.
    error RewardDayNotElapsed();
    /// @notice Same `(dayId, sourceChainId)` report already received — the
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
    /// @notice `sourceChainId` on an inbound chain report is not in the
    ///         Base aggregator's `expectedSourceChainIds` list.
    error SourceChainIdNotExpected();
    /// @notice Mirror-side rebroadcast attempted to overwrite a global
    ///         denominator that was already set for the same day with a
    ///         different value.
    error KnownGlobalAlreadySet();

    /// @notice #1222 M3 B2-b — a V2 broadcast packet's embedded destination
    ///         chain id does not match this chain (a delayed delivery after
    ///         a destination-list edit, or a governance replay, must never
    ///         apply another chain's funded figures here).
    error BroadcastDestinationMismatch(uint256 destChainId);

    // ─── #1434 P2-w1 — V3 broadcast + versioned lapse schedule ──────────────

    /// @notice `lapseWindowSeconds` outside the hard-coded `[3 days,
    ///         30 days]` bounds (design §7).
    error LapseWindowOutOfBounds(uint64 lapseWindowSeconds);
    /// @notice `dispatchCutoffGap` outside the hard-coded `[6 hours,
    ///         7 days]` bounds (design §7).
    error DispatchCutoffGapOutOfBounds(uint64 dispatchCutoffGap);
    /// @notice The relational bound `lapseWindowSeconds >= dispatchCutoffGap
    ///         + 48 hours` failed — such a version would place the dispatch
    ///         cutoff at (or before) finalization and forbid every
    ///         compensation for every day frozen under it, unrepairably
    ///         (frozen parameters are permanent). Refused, never stored.
    error LapseScheduleMarginViolated(
        uint64 lapseWindowSeconds, uint64 dispatchCutoffGap
    );
    /// @notice {broadcastGlobalTo} on a day with no frozen lapse clock (a
    ///         day finalized before the P2-w1 upgrade). There is no
    ///         authentic clock to heal with — such days broadcast on the V2
    ///         wire via the ordinary {broadcastGlobal}.
    error DayHasNoLapseClock(uint256 dayId);
    /// @notice {broadcastGlobalTo}'s destination has no day-scoped
    ///         historical standing for `dayId` (neither included in its
    ///         finalized denominator nor holding a chain-day commitments
    ///         record) — the permissionless heal only re-delivers facts a
    ///         destination already had a stake in.
    error DestinationHasNoDayStanding(uint256 dayId, uint256 destChainId);
    /// @notice {broadcastGlobalTo} needs the kind-10 single-destination
    ///         send, which this messenger proxy predates. Unlike the full
    ///         {broadcastGlobal}, the heal cannot fall back to the V2 wire —
    ///         kind-5 carries no clock, so a fallback would "succeed" while
    ///         healing nothing.
    error MessengerPredatesV3();
    /// @notice A V3 broadcast arrived carrying a zero `finalizedAt`. An
    ///         honest Base never sends one (clockless days ride the V2
    ///         wire), so this fails closed as a re-executable CCIP message.
    error BroadcastClockMissing(uint256 dayId);
    /// @notice A V3 broadcast named a different Base deployment than the one
    ///         already recorded for this day (§2h constraint 20 — a delayed
    ///         broadcast from a retired deployment must never install its
    ///         clock, schedule or zeroed marker into the new era).
    error BroadcastEraMismatch(
        uint256 dayId, address recordedEra, address packetEra
    );
    /// @notice A V3 broadcast's `baseDeployment` does not match this
    ///         mirror's configured CURRENT Base deployment — or that
    ///         config is unset (`expected == 0`), in which case the V3
    ///         ingress is deliberately dark (Codex #1632 r1: the per-day
    ///         era record cannot defend the FIRST install, so the ground
    ///         truth must be explicit, and fail-closed while unarmed).
    error BroadcastEraUnauthenticated(
        uint256 dayId, address expected, address packetEra
    );
    /// @notice A LEGACY broadcast (kind-5 / kind-2) attempted a FRESH
    ///         apply after this mirror rotated Base eras (Codex #1632 r2:
    ///         legacy packets carry no deployment identity, so a retired
    ///         era's delayed or manually re-executed delivery is
    ///         indistinguishable from a legitimate one — after a rotation
    ///         the only legitimate sender speaks V3, and the legacy wires
    ///         retire permanently). Replays of already-applied days stay
    ///         idempotent.
    error LegacyBroadcastRetired(uint256 dayId);
    /// @notice A re-delivered V3 broadcast disagreed with the day's already-
    ///         installed frozen clock facts (finalizedAt / schedule version /
    ///         inline parameters / zeroed marker).
    error BroadcastClockDivergence(uint256 dayId);
    /// @notice #1434 P2-w2 — a P2 compensation payload's per-side shares
    ///         sum past the delivered amount (malformed payload; both
    ///         shares floor when scaled, so an honest wire can never trip
    ///         this).
    error CompensationSharesExceedDelivery(
        uint256 lenderShare18, uint256 borrowerShare18, uint256 amount
    );
    /// @notice #1434 P2-w2 — the compensation broadcast-arrival hook is
    ///         Diamond-internal (the reporter facet invokes it through the
    ///         Diamond's own fallback); any other caller is rejected.
    error CompensationHookNotSelf(address caller);
    /// @notice #1634 r2 — a P2 compensation cannot dispatch for a day with
    ///         no frozen lapse clock: such a day can never emit the V3
    ///         broadcast that settles the mirror's classification, so the
    ///         credit would sit provisional forever (or quarantine
    ///         wrongly). A post-w1 zeroed day heals its clock first
    ///         (`broadcastGlobalTo`); a day finalized before the clock
    ///         machinery existed belongs to the w4 legacy-compensation
    ///         migration (`stampLegacyCompensation`), not this wire.
    error CompensationDayHasNoClock(uint256 dayId);
    /// @notice #1634 r3 — the R3 dispatch cutoff: a compensation must not
    ///         dispatch within `dispatchCutoffGap` of the day's frozen
    ///         expiry — bridge latency could carry it past expiry, where
    ///         the mirror quarantines it (reason 3) after Base has already
    ///         closed the day and consumed headroom.
    error CompensationDispatchPastCutoff(
        uint256 dayId, uint256 expiry, uint64 dispatchCutoffGap
    );

    // ─── #1434 P2-w3 — the compensation quote (§1.4) ────────────────────────

    /// @notice The quote surfaces only exist for a deliberately-zeroed day
    ///         (the V3 marker — §1.1).
    error CompQuoteDayNotZeroed(uint256 dayId);
    /// @notice R1d (§2.3) — the day's LOCAL interest close has not run;
    ///         zero totals would be ambiguous (unfolded vs genuinely
    ///         zero). `closeDay` is permissionless: anyone can produce the
    ///         missing fact and retry.
    error CompQuoteLocalCloseMissing(uint256 dayId);
    /// @notice The day has lapsed (or short-lapsed) — the compensation
    ///         window is over; the loss was recorded at the lapse.
    error CompQuoteDayLapsed(uint256 dayId);
    /// @notice Accumulation is closed: the quote was already dispatched
    ///         (its inputs are frozen, so there is nothing to
    ///         re-accumulate — re-DISPATCH is the retry lever).
    error CompQuoteAlreadyDispatched(uint256 dayId);

    /// @notice #1656 r11 — the day's lapse loss is recorded EXACT
    ///         (conservation proved), so its completed accumulation may
    ///         not be reset out from under the published record.
    error CompQuoteResetRefusedExactLoss(uint256 dayId);

    // ── #1434 P2-w5 — the R4 stranded return + recovery position ──

    /// @notice The caller is not the configured return-channel receiver.
    error OnlyStrandedReturnReceiver(address caller);

    /// @notice The return names a reservation issued by ANOTHER Base
    ///         deployment (pre-rotation dispatch) — settles via the R6e
    ///         rotation runbook, never here.
    error StrandedReturnWrongEra(address remitter);

    /// @notice No reservation exists under this remitId.
    error StrandedReturnUnknownReservation(uint256 remitId);

    /// @notice The authenticated source chain is not the chain this
    ///         reservation was dispatched to (Codex #1600 r1 P1 — the
    ///         chain binding).
    error StrandedReturnWrongSourceChain(uint32 got, uint32 want);

    /// @notice Wrong token, zero actual, or actual above declared.
    error StrandedReturnDeliveryInvalid();

    /// @notice #1660 r1 — the named reservation is not a COMPENSATION
    ///         dispatch (single-day, fresh-only, per-side declared): an
    ///         ordinary batch reservation's recycled component never
    ///         charged the lifetime cap, so crediting its total would
    ///         mint uncharged re-dispatch capacity (a 69M bypass).
    error StrandedReturnNotCompensation(uint256 remitId);

    /// @notice #1660 r2 — the reported day is not the reservation's own
    ///         single day: settlement and loss evidence must bind to the
    ///         authoritative obligation, never a wire-supplied one.
    error StrandedReturnWrongDay(uint256 got, uint256 want);

    /// @notice #1660 r3 - the receipt was CONSUMED (consumed ack or its
    ///         forced equivalent): its value backs mirror claims, so a
    ///         return against it would reuse the dispatch cap lineage.
    error StrandedReturnConsumedReceipt(uint256 remitId);

    /// @notice #1660 r4 - the return arrived before the receipt's ack:
    ///         positive NON-consumption evidence (an Acked-non-consumed
    ///         or Released reservation) is required before any credit,
    ///         because out-of-order transport could otherwise land a
    ///         faulty mirror's return ahead of its consumed attestation.
    ///         Re-executable once the permissionless ack lands.
    error StrandedReturnAwaitingAck(uint256 remitId, uint8 status);

    /// @notice #1660 r6 - the ack wire's classification word is zero or
    ///         out of range: zero is the retired generation-1 bool-false
    ///         shape, refused re-executably rather than misread.
    error RemitAckClassificationInvalid(uint8 classification);

    // -- #1434 P2-w6 - the recovery ceremony + R6e rotation --

    /// @notice Ceremony records apply to RELEASED reservations only.
    error CeremonyReservationNotReleased(uint256 remitId);

    /// @notice recovered + terminal loss would pass the reservation's
    ///         dispatched total - over-recording refused.
    error CeremonyExceedsStranded(uint256 remitId, uint256 sum, uint256 total);

    /// @notice The Diamond does not hold the value the ceremony claims
    ///         arrived - a books-only recovery must roll back here.
    error CeremonyInflowNotBacked(uint256 remitId, uint256 bal, uint256 need);

    /// @notice #1662 r1 — a ceremony component exceeds the reservation's
    ///         own dispatched provenance split (fresh vs recycled).
    error CeremonyProvenanceExceeded(
        uint256 remitId,
        uint256 component,
        uint256 bound
    );

    /// @notice #1662 r2 — an uncharged re-dispatch exceeds the NAMED
    ///         source receipt's own unspent recovery credit.
    error RecoveryReceiptCreditInsufficient(
        uint256 sourceRemitId,
        uint256 requested,
        uint256 unspent
    );

    /// @notice #1662 r2 — the imported tuple names the gate SENTINEL as
    ///         its old-era remit id (the operator read the retiring
    ///         deployment's visible gate instead of its imported record).
    error ImportedTupleIsSentinel();

    /// @notice #1662 r7 — this receipt predates per-receipt recovery
    ///         attribution, so its unspent figure is not reconstructible
    ///         and it may not fund an uncharged re-dispatch.
    error RecoveryReceiptPredatesAttribution(uint256 sourceRemitId);

    /// @notice #1662 r7 — attribution is a one-shot arming.
    error RecoveryAttributionAlreadyArmed();

    /// @notice #1662 r5 — this tuple was already imported once. One
    ///         parcel, one import: the gate returns to zero at settlement,
    ///         so a replay would mint a second attribution.
    error ImportedTupleAlreadySeen(uint32 dstChainId, uint256 oldRemitId);

    /// @notice Imported tuple names zero or THIS deployment (an own-era
    ///         reservation needs no import).
    error ImportedTupleInvalid(address oldRemitter);

    /// @notice No imported marker stands for this chain.
    error ImportedMarkerMissing(uint32 dstChainId);

    /// @notice A from-recovery dispatch exceeds the recovery position
    ///         balance (recovered − redispatched).
    error RecoveryPositionInsufficient(uint256 requested, uint256 available);
    /// @notice The side's conservation sum does not equal the day's folded
    ///         side total — the accumulation has not covered every entry.
    error CompQuoteIncomplete(
        uint256 dayId, uint8 side, uint256 conservation18, uint256 total18
    );
    /// @notice A quote arrived for a day Base has not finalized.
    error CompQuoteDayNotFinalized(uint256 dayId);
    /// @notice A quote arrived for a chain-day that was never zeroed out of
    ///         the denominator (and holds no prior quote record).
    error CompQuoteDayNotIneligible(uint256 dayId, uint32 chainId);
    /// @notice A re-quote arrived AFTER the day was funded — the funded
    ///         amount was bounded by the quote standing at dispatch, which
    ///         is the receipt-bound obligation supplements top up against.
    error CompQuoteDayAlreadyFunded(uint256 dayId, uint32 chainId);
    /// @notice #1434 P2-w3 — a manual compensation needs a STANDING quote:
    ///         the sizing evidence is the mirror's authenticated
    ///         counterfactual share, never operator judgment alone.
    error CompensationNotQuoted(uint256 dayId, uint32 chainId);
    /// @notice #1434 P2-w3 — the per-side amounts exceed the standing
    ///         quote (each side separately — an aggregate bound would
    ///         admit overfunding one side while shorting the other).
    error CompensationExceedsQuote(
        uint256 lenderAmount18,
        uint256 borrowerAmount18,
        uint256 quotedLender18,
        uint256 quotedBorrower18
    );
    /// @notice #1434 P2-w3 (#1636 r1) — the quote surface needs the day's
    ///         frozen pool stamp (the Δq numerator); pricing without it
    ///         would quote (0,0) and wrongly resolve a demand-carrying day
    ///         to zero.
    error CompQuoteDayPoolStampMissing(uint256 dayId);
    /// @notice #1434 P2-w3 (#1636 r1) — a re-delivered quote's sending
    ///         Diamond diverges from the era the standing quote is bound
    ///         to; a stale-era wire must not overwrite newer evidence.
    error CompQuoteEraMismatch(
        uint256 dayId,
        uint32 chainId,
        address boundEra,
        address arrivedEra
    );
    /// @notice #1434 P2-w3 (#1636 r2) — the quote ingress is FAIL-CLOSED
    ///         until the operator registers the sending chain's current
    ///         mirror Diamond: without a configured ground truth, a
    ///         delayed retired-era wire could be the FIRST arrival and
    ///         bind (or zero-clear) the day unchallenged.
    error CompQuoteMirrorEraUnset(uint32 chainId);
    /// @notice #1434 P2-w3 (#1636 r4) — a resolved-zero standing quote is
    ///         TERMINAL and refuses the era-rotation clear: its (0,0)
    ///         ingress already retired the day's manual-funding anchor,
    ///         deleting the record would strand the chain-day outside
    ///         every admission path, and a re-quote under ANY era is
    ///         deterministically (0,0) again — there is nothing to
    ///         restate.
    error CompQuoteResolvedZeroFinal(uint256 dayId, uint32 chainId);
    // ─── #1434 P2-w4 — lapse terminals + R6 gate + supplemental ─────────────
    /// @notice The full-lapse terminal needs a deliberately-zeroed day.
    error LapseDayNotZeroed(uint256 dayId);
    /// @notice A compensated day never takes the FULL lapse — its exits
    ///         are the supplemental top-up or the short-lapse terminal.
    error LapseDayCompensated(uint256 dayId);
    /// @notice R1d — no lapse before the day's local interest close ran
    ///         (a lapse without a fold would retire unfolded demand).
    error LapseDayLocalCloseMissing(uint256 dayId);
    /// @notice The day has no frozen clock, or froze under version 0
    ///         (pre-schedule) — not lapse-eligible; healable by re-broadcast.
    error LapseDayClockMissing(uint256 dayId);
    /// @notice The day's frozen expiry has not passed.
    error LapseDayNotExpired(uint256 dayId, uint256 expiry);
    /// @notice The day already reached a terminal (lapsed, short-lapsed,
    ///         or resolved-zero) — terminals are monotone.
    error LapseDayAlreadyTerminal(uint256 dayId);
    /// @notice The short-lapse terminal needs a CONFIRMED compensation.
    error ShortLapseNotCompensated(uint256 dayId);
    /// @notice The pools cover the standing per-side quotes — nothing is
    ///         short; the day prices at full Δq already.
    error ShortLapseNotShort(uint256 dayId);
    /// @notice §2.5's bounded deadline (min(lastQualifying + window,
    ///         first + 3×window)) has not passed.
    error ShortLapseDeadlineNotReached(uint256 dayId, uint256 deadline);
    /// @notice R6 — one compensation reservation in flight per chain; the
    ///         standing one must settle (ACK / return / recovery) first.
    error CompensationGateHeld(uint32 chainId, uint256 outstandingRemitId);
    /// @notice A supplemental tops up a day a manual remit already CLOSED.
    error SupplementalDayNotClosed(uint256 dayId, uint32 chainId);
    /// @notice The closing reservation must be ACKED (value consumed) —
    ///         for a dead reservation, release is the tool.
    error SupplementalReservationNotAcked(uint256 remitId, uint8 status);
    /// @notice Constraint-19 — the legacy stamp needs the day's COMPLETED
    ///         quote first (the legacy wire carried no per-side split; the
    ///         stamp cannot invent one).
    error LegacyStampQuoteMissing(uint256 dayId);
    /// @notice Constraint-19 — the named receipt does not exist, or was
    ///         already spent on a day (one receipt stamps one day).
    error LegacyReceiptUnusable(bytes32 receiptKey);
    /// @notice Constraint-19 — the day is not stampable: not zeroed,
    ///         already terminal, or already compensated.
    error LegacyDayNotStampable(uint256 dayId);
    /// @notice #1434 P2-w4 (#1656 r1) — a compensated day whose receipt
    ///         clocks predate the w4 upgrade (both zero) is not
    ///         short-lapse-eligible until {armShortLapseClock} starts its
    ///         bounded window — without this, the deadline formula would
    ///         read one window past the epoch and fire immediately.
    error ShortLapseClockUnarmed(uint256 dayId);
    /// @notice The clock armer is one-shot per day.
    error ShortLapseClockAlreadyArmed(uint256 dayId);
    /// @notice #1434 P2-w4 (#1656 r1) — the supplemental needs the
    ///         per-side funded record its bound reads; a pre-w4 funded day
    ///         has none until the ADMIN seed backfills it.
    error SupplementalFundedRecordMissing(uint256 dayId, uint32 chainId);
    /// @notice #1434 P2-w4 (#1656 r1) — the seed's figures must fit the
    ///         day's recorded scalar funding and the standing quote.
    error CompFundedSeedInvalid(uint256 dayId, uint32 chainId);
    /// @notice #1434 P2-w4 (#1656 r2) — the lapse terminals are DARK until
    ///         the ADMIN arms them (the constraint-19 activation gate,
    ///         on-chain): arming attests the legacy inventory read empty
    ///         and every delivered legacy receipt was stamped.
    error LapseTerminalsNotArmed();
    /// @notice The terminals arm once.
    error LapseTerminalsAlreadyArmed();

    // ─── Per-Asset Pause ────────────────────────────────────────────────────
    /// @notice Creation path touched an asset that has been paused by
    ///         governance. Exit paths (repay / liquidate / claim / withdraw)
    ///         remain open for existing positions; only NEW exposure through
    ///         this asset is blocked.
    /// @param asset The paused asset that triggered the revert.
    error AssetPaused(address asset);

    // ─── VPFI Fixed-Rate Buy: origin-chain guard ───────────────────────────
    /// @notice Fixed-rate VPFI buy reached the caps pipeline with an
    ///         origin chain id that cannot key the per-wallet cap bucket
    ///         — either zero, or wider than the `uint32` bucket key.
    ///         Zero would land every buy in storage bucket 0; an
    ///         over-wide id would truncate into the wrong bucket. Either
    ///         desyncs the frontend's per-chain allowance view from the
    ///         on-chain ledger. It cannot occur on a well-formed call —
    ///         direct buys pass `block.chainid`, bridged buys pass a
    ///         CcipMessenger-resolved source chain id — so this is a
    ///         defence-in-depth reject of a malformed origin.
    error VPFIInvalidOriginChainId();

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

    // ─── T-048 — Predominantly Available Denominator (PAD) ─────────────

    /// @notice Reverted when an industrial-fork deploy's
    ///         `numeraire ≠ PAD` AND the protocol can't compute the
    ///         PAD/<numeraire> FX rate — neither the direct
    ///         `padNumeraireRateFeed` is set, nor are both
    ///         `ethPadFeed` + `ethNumeraireFeed` populated for the
    ///         derived path. Configuration error caught at the first
    ///         priced read; nothing on-chain can recover except a
    ///         governance call to `setPredominantDenominator` with a
    ///         reachable rate path.
    error PadNumeraireRateUnavailable();

    /// @notice Reverted when `_primaryPrice` is asked to price an
    ///         asset on a `numeraire ≠ PAD` deploy but no PAD-side
    ///         feed (asset/PAD direct OR asset/ETH-pivot via PAD)
    ///         resolves on the active chain. Same shape as
    ///         {NoPriceFeed} but specific to the PAD-pivot path so
    ///         operator monitoring can distinguish "asset never had a
    ///         feed" from "feed setup mid-rotation."
    error PadPivotFeedUnavailable(address asset);

    /// @notice Reverted when the operator sets
    ///         `padNumeraireRateFeed` but the feed read returns a
    ///         non-positive answer or is stale beyond the
    ///         secondary-oracle staleness budget. Operator must point
    ///         at a fresh feed or clear the slot to fall back to the
    ///         derived rate.
    error PadNumeraireRateFeedStale();

    /// @notice T-090 v1.1 (#389) — every voluntary-close,
    ///         collateral-mutating, and lender-protection entry point
    ///         that touches `loan.borrower`'s vault MUST revert with
    ///         this error while an intent-based swap-to-repay commit
    ///         is live for the loan. The borrower committed their
    ///         collateral to a Fusion order; the diamond holds it
    ///         custodially and the loan's standard vault-pull paths
    ///         would either revert (vault empty) or orphan the
    ///         custodial slot (loan flips state but custody stays).
    ///
    ///         Caller resolutions:
    ///           • Voluntary callers (RepayFacet, PrecloseFacet,
    ///             RefinanceFacet, v1 SwapToRepayFacet,
    ///             AddCollateralFacet, PartialWithdrawalFacet) — wait
    ///             for the borrower's `cancelSwapToRepayIntent` or
    ///             the 24h `cancelExpiredIntent`. No lender-
    ///             protection urgency justifies overriding the
    ///             borrower's committed window.
    ///           • Lender-protection callers (RiskFacet's 4 HF-
    ///             liquidation entry points, RiskMatchLiquidationFacet
    ///             internal-match, RepayFacet's
    ///             `_autoLiquidatePeriodShortfall`,
    ///             `DefaultedFacet.triggerDefault`) — only revert
    ///             when the loan is still healthy enough to honour
    ///             the borrower's window. When the loan is already
    ///             liquidatable / defaultable on time grounds, the
    ///             entry point force-cancels the intent (returns
    ///             collateral, clears state, emits
    ///             `SwapToRepayIntentForceCancelled`) and proceeds.
    ///
    ///         See `docs/DesignsAndPlans/SwapToRepayIntentBased.md`
    ///         §5.8 for the block-vs-force-cancel matrix.
    error IntentPending(uint256 loanId);

    /// @notice #569 decision D-2 (2026-06-13) — VPFI may not be used as
    ///         the prepay asset for an NFT-rental offer. The rental
    ///         prepay pool is intentionally NOT protected by a collateral
    ///         lien (decision D-1), so allowing VPFI prepay would expose
    ///         it to the `VPFIDiscountFacet.withdrawVPFIFromVault`
    ///         staking-unwind drain with no protection. Enforced at BOTH
    ///         offer-create (`OfferCreateFacet._createOfferSetup`) AND
    ///         offer-accept (`OfferAcceptFacet._acceptOffer`) — the
    ///         accept-time check closes the window where an offer was
    ///         created before `vpfiToken` was configured (Codex #572 P1).
    ///         See `docs/DesignsAndPlans/EncumbranceLifecycleMap.md` §2.
    error VpfiNotAllowedAsRentalPrepay();

    /// @notice #1351 (M2 PR-2) — a post-`D*` reward day reached claim/sweep with
    ///         no explicit `dayCapMode` stamp. FAIL CLOSED: such a day is NOT a
    ///         legacy day. Finalize retires the ETH-ratio threshold on armed
    ///         days (`dayCapThreshold18 = max`), so silently treating a
    ///         mode-less armed day as `LegacyEthRatio` would price it with a
    ///         DISABLED cap — i.e. pay it uncapped.
    error DayCapModeUnsetPostCutover(uint256 dayId);

    /// @notice #1351 (M2 PR-2) — an entry handed to `processUserSideDay` broke
    ///         the transfer-set contract: it belongs to another user, sits on
    ///         the other side, or does not cover the day being priced. The
    ///         primitive keys the `(user, side, day)` budget off the FIRST
    ///         entry, so a mismatched set would charge the wrong ceiling and
    ///         pay slices the claimant never earned.
    error RewardEntrySetMismatch(uint256 entryId);

    // ─── #1222 M3 B2-d1 — mirror→Base commitment report ─────────────────────

    /// @notice The commitment report is a MIRROR-only surface: it computes this
    ///         chain's day-D claimable-liability and ships it to the canonical
    ///         (Base) reward chain. Reverts on Base (canonical) and on a
    ///         single-chain deploy (no baseChainId).
    error CommitmentReportOnlyMirror();

    /// @notice A commitment batch/report targeted a day that is not armed
    ///         (`governorCommitArmedFromDay == 0 || dayId < it`) — the
    ///         commitment gate is inert on unarmed days, so there is nothing to
    ///         report.
    error CommitmentDayNotArmed(uint256 dayId);

    /// @notice A commitment batch reached a day whose per-chain funding stamp
    ///         has not arrived yet (the Base→mirror broadcast is pending), so
    ///         the per-side pool — and thus the liability — cannot be priced.
    ///         The report must wait for the broadcast (delays, never zeroes).
    error CommitmentStampNotArrived(uint256 dayId);

    /// @notice The mirror's day-`dayId` local interest close has not run yet
    ///         (`chainReportSentAt[dayId] == 0`) — the demand-conservation
    ///         totals the report's completeness is proven against are not
    ///         final, so a quiet-LOOKING day must not ship the once-only
    ///         report (Codex #1425 r1: a Base grace/force-finalize stamps the
    ///         mirror even when its own close never ran).
    error CommitmentDayNotLocallyClosed(uint256 dayId);

    /// @notice A commitment batch's entry ids were not STRICTLY INCREASING
    ///         (within the batch and versus the stored per-(day, side)
    ///         cursor) — the monotonic ordering is the dedup that guarantees
    ///         each entry is accumulated exactly once. `entryId` is the
    ///         offending id.
    error CommitmentEntriesNotAscending(uint256 entryId);

    /// @notice An entry handed to a commitment batch is not on the claimed
    ///         `side` or does not cover the reported day — the
    ///         mirror recomputes each unit's contribution from its OWN storage,
    ///         so a mismatched entry (the keeper cannot inflate) is rejected.
    error CommitmentEntryMismatch(uint256 entryId);

    /// @notice `sendCommitmentReport` was called for a day whose per-side
    ///         commitments are not both COMPLETE (the demand-conservation proof
    ///         has not been satisfied on one or both sides).
    error CommitmentDayNotComplete(uint256 dayId);

    /// @notice A commitment batch or send targeted a day whose report was
    ///         already dispatched to Base (whole-day idempotency).
    error CommitmentReportAlreadySent(uint256 dayId);

    // ─── #1222 M3 B2-d2 — delivered-backing remit ledger ────────────────────

    /// @notice The referenced remit reservation does not exist or is not in
    ///         the state the operation requires (ack-finalize and release
    ///         both require a PENDING reservation).
    error RemitReservationNotPending(uint256 remitId);

    /// @notice A remit ack arrived from a chain other than the reservation's
    ///         destination — a mirror must only ack remittances addressed to
    ///         it (`expected` is the reservation's destination chain).
    error RemitAckChainMismatch(uint256 remitId, uint32 expected, uint32 got);

    /// @notice `sendRemitAck` was called for a `remitId` this mirror holds no
    ///         receipt record for (never delivered here, or a legacy pre-d2
    ///         delivery that carried no remitId).
    error ReceivedRemitNotFound(uint256 remitId);

    /// @notice A mirror-only remit surface (the ack path) was called on the
    ///         canonical chain or a single-chain deploy.
    error OnlyMirrorRewardChain();

    /// @notice A remit receipt's recorded source chain no longer matches the
    ///         configured base chain (owner base rotation): remit ids are
    ///         per-deployment, so acking a stale receipt toward the NEW base
    ///         could finalize an unrelated same-numbered reservation there.
    ///         The old deployment's reservation resolves through its own
    ///         operator valves.
    error ReceivedRemitStale(uint256 remitId, uint32 recordedSrcChainId);

    /// @notice A remit ack's echoed source-sender is not THIS deployment:
    ///         the receipt it was computed from belongs to a different
    ///         (pre-rotation) canonical deployment whose remit numbering is
    ///         unrelated — finalizing on it would mark a reservation
    ///         delivered that never was.
    error RemitAckSenderMismatch(uint256 remitId, address srcSender);

    /// @notice `releaseRemitReservation` was called before the reservation
    ///         aged past the reconciliation timeout (plan §M3: the operator
    ///         terminal runs only AFTER a timeout — a merely-delayed CCIP
    ///         message must not have its days re-opened while it can still
    ///         execute). `earliest` is the first allowed timestamp.
    error RemitReleaseTooEarly(uint256 remitId, uint256 earliest);

    /// @notice #1222 M3 B2-d5 — an arriving remit declared a RECYCLED share
    ///         larger than the VPFI actually delivered. The recycled share is
    ///         a COMPONENT of the delivery, so it can never exceed it; a
    ///         payload claiming otherwise would relocate custody the Diamond
    ///         never received and over-back the mirror's recycle bucket.
    ///         The receiver already scales the declared share to what landed,
    ///         so this is the Diamond's own independent bound on a
    ///         malformed or hostile ingress.
    error RecycledShareExceedsDelivery(uint256 recycledShare, uint256 amount);

    /// @notice #1434 P1-a — an arriving remit declared a FRESH share larger
    ///         than the part of the delivery the recycled share left over.
    ///         Twin of {RecycledShareExceedsDelivery}, and bounded against
    ///         the REMAINDER rather than against the delivery: two shares can
    ///         each be no larger than `amount` and still sum past it, which
    ///         would let one delivery be counted as both relocated recycled
    ///         custody and armed fresh funding.
    /// @param freshShare  The declared fresh component.
    /// @param freshRoom   `amount − recycledShare`, all that was left for it.
    error FreshShareExceedsDelivery(uint256 freshShare, uint256 freshRoom);

    /// @notice #1222 M3 B2-d3 — `setExpectedSourceChainIds` was given the
    ///         same chain id twice. The per-chain funding resolution treats
    ///         each entry independently, so a duplicate would double-count
    ///         that chain's demand target, self-fund its availability twice
    ///         (breaking SS7 #6's `sat(consumed − released) ≤ reported`),
    ///         and clobber the shared
    ///         per-(day, chain) funding stamp.
    error DuplicateExpectedChainId(uint32 chainId);

    /// @notice The manual-budget path requires the `(dayId, chainId)` still
    ///         marked remit-ineligible — the un-cleared flag is the on-chain
    ///         evidence the day was finalized with this chain ZEROED out of
    ///         the denominator (run the manual remit BEFORE any
    ///         `reconcileCommitmentRemitEligibility` clear).
    error RemitDayNotManualEligible(uint256 dayId, uint32 chainId);

    /// @notice The (chain, day) was already funded or terminally closed by a
    ///         remit batch — a day funds at most once (a RELEASED
    ///         reservation re-opens its days).
    error RemitDayAlreadyClosed(uint256 dayId, uint32 chainId);

    /// @notice #1780 — the lender-sale errors are shared by BOTH early-
    ///         withdrawal routes. The direct route ({EarlyWithdrawalDirectFacet})
    ///         and the listed route ({EarlyWithdrawalFacet}) were one facet
    ///         until the EIP-170 split, and each of these three is raised on
    ///         both sides; they live here so the split does not duplicate a
    ///         declaration, which is exactly what this interface exists to
    ///         prevent.
    /// @notice The buy offer or sale offer cannot serve as a sale vehicle for
    ///         this loan — wrong asset, wrong term, already spoken for, or not
    ///         in a fillable state.
    error InvalidSaleOffer();
    /// @notice The rate difference between the live loan and the sale vehicle
    ///         would cost the exiting lender more than the principal itself.
    error RateShortfallTooHigh();
    /// @notice #1503 item 4 — completing this sale would pay the exiting lender
    ///         less than the floor they recorded when they listed.
    /// @dev    Raised when the settlement cost has grown past what the seller
    ///         authorised. Ordinary accrual across the listing window CANNOT
    ///         trip this: the floor is derived at BOTH ends of the listing
    ///         window — whichever is worse for the seller, plus truncation
    ///         slack — so the whole window is inside it. What trips it is a step change
    ///         the seller never reviewed — a principal movement, or interest
    ///         parked rather than delivered, either of which disqualifies the
    ///         paid-through mark and re-opens the forfeiture window earlier.
    ///
    ///         The remedy is to cancel and relist at the new economics, NOT to
    ///         relax the bound: the larger cost is real, and the seller has
    ///         simply not agreed to it.
    /// @param minSellerNet The floor recorded on the listing.
    /// @param actual       What completion would actually pay the seller.
    error SaleBelowSellerFloor(uint256 minSellerNet, uint256 actual);
    /// @notice #1503 item 4 — completing this sale would hand the buyer more
    ///         held-for-lender balance than there was when the seller listed.
    /// @dev    That balance is money already set aside for the lender which
    ///         transfers with the position, so a park between listing and
    ///         acceptance silently enlarges what the seller gives up. Unlike
    ///         the forfeiture it does not grow with time, so the recorded value
    ///         is simply the balance at listing.
    /// @param maxHeld The ceiling recorded on the listing.
    /// @param actual  The balance that would transfer now.
    error SaleAboveHeldCeiling(uint256 maxHeld, uint256 actual);
    /// @notice #1810 — the listing would record a seller floor BELOW the quote
    ///         the seller reviewed, so state moved against them between quote
    ///         and listing (a partial repayment is enough — it disqualifies
    ///         the paid-through mark and widens the forfeiture).
    /// @dev    Raised only by `createLoanSaleOfferBound`; the unbound entry
    ///         records whatever the arithmetic comes to. Adverse drift only —
    ///         a floor above the reviewed one passes.
    /// @param recorded The floor the listing would record now.
    /// @param reviewed The floor the seller was quoted.
    error ListingFloorBelowReviewed(uint256 recorded, uint256 reviewed);
    /// @notice #1810 — the listing would record a held-transfer ceiling ABOVE
    ///         the quote the seller reviewed (interest parked into
    ///         held-for-lender between quote and listing enlarges what
    ///         transfers with the position).
    /// @param recorded The ceiling the listing would record now.
    /// @param reviewed The ceiling the seller was quoted.
    error ListingHeldAboveReviewed(uint256 recorded, uint256 reviewed);
    /// @notice #951 (Codex #959) — a loan already has a live sale listing. Only
    ///         one listing per loan at a time: `loanToSaleOfferId` is cleared on
    ///         cancel (OfferCancelFacet) and on completion, so a re-list after
    ///         either is allowed; a second concurrent listing would overwrite the
    ///         forward link and strand the reverse link, splitting accept/cancel
    ///         authority across two offers.
    error SaleOfferAlreadyExists();
}
