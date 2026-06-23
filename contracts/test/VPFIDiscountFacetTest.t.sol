// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title VPFIDiscountFacetTest
/// @notice Exercises the borrower VPFI discount mechanism end-to-end
///         (docs/TokenomicsTechSpec.md):
///          - depositVPFIToVault / withdrawVPFIFromVault (encumbrance-aware)
///          - the discount price-anchor config (setVPFIDiscountRate /
///            setVPFIDiscountETHPriceAsset) feeding the quote view
///          - quote view eligibility (rate-set / tier / offer existence)
///          - OfferAcceptFacet.acceptOffer discount path gated by the platform-
///            level VPFI-discount consent flag (happy + silent-fallback
///            branches)
///          - emitDiscountApplied access gating
/// @dev #687-A removed the issuer fixed-rate ETH → VPFI sale; this suite now
///      covers only the consumptive fee-discount utility that remains.
contract VPFIDiscountFacetTest is SetupTest {
    // #229: VPFIDiscountFacet is cut + constructed inside
    // `SetupTest.setupHelper()` now; the prior local declaration +
    // local cut was a workaround for the pre-#229 gap and is dropped.
    // References to `vpfiDiscountFacet` below resolve to the inherited
    // SetupTest field.
    VPFIToken internal vpfiToken;
    ERC20Mock internal weth; // ETH price-reference asset

    // Discount price anchor: 1 VPFI = 0.001 ETH → 1e15 wei per VPFI (18 dec).
    // Seeds `setVPFIDiscountRate` so the fee-discount conversion chain has a
    // non-zero VPFI price (the issuer fixed-rate sale was removed in #687-A).
    uint256 internal constant RATE_WEI_PER_VPFI = 1e15;
    // Diamond VPFI reserve seeded for discount rebates / interaction rewards.
    uint256 internal constant DIAMOND_VPFI_RESERVE = 200_000 ether;

    // Price constants for the conversion chain. mockERC20 is the lending
    // asset (already priced in SetupTest at $1 with 8 decimals). WETH is
    // set to $2000 with 8 decimals so the USD→ETH leg produces a sane,
    // non-zero feeWei under default fuzz inputs.
    uint256 internal constant ETH_USD_PRICE = 2000e8;

    address internal treasuryRecipient;

    event VPFIDepositedToVault(
        address indexed user,
        uint256 amount,
        uint256 newVaultBalance
    );
    event VPFIDiscountApplied(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );
    event VPFIYieldFeeDiscountApplied(
        uint256 indexed loanId,
        address indexed lender,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    function setUp() public {
        setupHelper();

        // Point the protocol's treasury at a real address so the yield-fee /
        // LIF treasury legs don't clash with the diamond balance assertions.
        treasuryRecipient = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        // Deploy VPFI token behind an ERC1967 proxy (UUPS).
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        // Register VPFI on the diamond + mark this chain as canonical. Fund
        // the diamond's reserve so discount rebates / interaction rewards have
        // VPFI to draw from.
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        vpfiToken.transfer(address(diamond), DIAMOND_VPFI_RESERVE + 1_000 ether);

        // Give `lender`/`borrower` some VPFI in their wallets for deposit
        // + discount tests.
        vpfiToken.transfer(lender, 5_000 ether);
        vpfiToken.transfer(borrower, 5_000 ether);

        // #229 — VPFIDiscountFacet is now cut by `SetupTest.setupHelper()`.
        // The prior local `new VPFIDiscountFacet()` + local diamondCut
        // here would double-cut the same selectors and revert. Dropped.

        // Configure the discount price anchor + ETH reference asset.
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);
        _facet().setVPFIDiscountRate(RATE_WEI_PER_VPFI);
        _facet().setVPFIDiscountETHPriceAsset(address(weth));

        // Mock the WETH oracle feed. SetupTest already mocks mockERC20 at
        // $1/8dec; we overlay a WETH feed at $2000/8dec.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, address(weth)),
            abi.encode(ETH_USD_PRICE, uint8(8))
        );
    }

    // ─── Shorthand ───────────────────────────────────────────────────────────

    function _facet() internal view returns (VPFIDiscountFacet) {
        return VPFIDiscountFacet(address(diamond));
    }

    function _buyerVault(address user) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
    }

    // ─── depositVPFIToVault ─────────────────────────────────────────────────

    function testDepositVPFIToVaultHappyPath() public {
        uint256 amount = 100 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), amount);

        vm.expectEmit(true, false, false, true, address(diamond));
        // Fresh borrower → post-deposit vault balance == amount.
        emit VPFIDepositedToVault(borrower, amount, /* newVaultBalance */ amount);

        vm.prank(borrower);
        _facet().depositVPFIToVault(amount);

        address vault = _buyerVault(borrower);
        assertEq(vpfiToken.balanceOf(vault), amount);
    }

    function testDepositVPFIToVaultRevertsOnZero() public {
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        _facet().depositVPFIToVault(0);
    }

    // ─── #569 §6 F-1 — withdrawVPFIFromVault respects collateral lien ────────

    /// @notice F-1: VPFI staked into the vault that is ALSO pledged as
    ///         ERC-20 loan collateral (recorded in the encumbrance
    ///         aggregate) cannot be unstaked past the free balance.
    function test_F1_withdrawVPFIFromVault_refusesEncumberedPortion() public {
        uint256 staked = 100 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), staked);
        vm.prank(borrower);
        _facet().depositVPFIToVault(staked);

        // Simulate 40 VPFI backing a live loan as collateral — the
        // encumbrance aggregate the withdraw guard / F-1 consult reads.
        uint256 encumbered = 40 ether;
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower, address(vpfiToken), 0, encumbered
        );
        uint256 free = staked - encumbered; // 60

        // Unstaking more than the free balance is refused with the
        // specific F-1 error (before the chokepoint guard would).
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIDiscountFacet.VPFIEncumberedByActiveLoan.selector,
                free + 1 ether,
                free
            )
        );
        _facet().withdrawVPFIFromVault(free + 1 ether);

        // Unstaking exactly the free balance succeeds.
        vm.prank(borrower);
        _facet().withdrawVPFIFromVault(free);
        assertEq(
            vpfiToken.balanceOf(_buyerVault(borrower)),
            encumbered,
            "vault retains exactly the encumbered (pledged) VPFI"
        );
    }

    /// @notice F-1 boundary: with zero encumbrance the full staked
    ///         balance is freely unstakable (no behavioural change for
    ///         users with no VPFI-collateralized loan).
    function test_F1_withdrawVPFIFromVault_fullDrainWhenUnencumbered() public {
        uint256 staked = 50 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), staked);
        vm.prank(borrower);
        _facet().depositVPFIToVault(staked);

        vm.prank(borrower);
        _facet().withdrawVPFIFromVault(staked);
        assertEq(vpfiToken.balanceOf(_buyerVault(borrower)), 0);
    }

    // ─── #569 D-2 — VPFI forbidden as an NFT-rental prepay asset ─────────────

    /// @notice D-2: creating an NFT-rental offer whose prepay asset is
    ///         the platform VPFI token is rejected at offer-create. The
    ///         gate fires before any asset pull, so no NFT funding is
    ///         needed to exercise it.
    /// @dev    The 33-field `CreateOfferParams` literal is built in the
    ///         `_vpfiRentalOfferParams` helper (its own stack frame) so
    ///         this already-large test file stays under viaIR's stack
    ///         ceiling (see #568).
    function test_D2_rentalOfferWithVpfiPrepay_reverts() public {
        LibVaipakam.CreateOfferParams memory p = _vpfiRentalOfferParams();
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.VpfiNotAllowedAsRentalPrepay.selector);
        OfferCreateFacet(address(diamond)).createOffer(p);
    }

    /// @dev NFT-rental lender offer whose prepay asset is VPFI (the
    ///      D-2 violation). Extracted to keep `test_D2_*`'s stack shallow.
    function _vpfiRentalOfferParams()
        private
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockNft721,
            amount: 10,
            interestRateBps: 500,
            collateralAsset: mockERC20,
            collateralAmount: 1500,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC721,
            tokenId: 1,
            quantity: 1,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(vpfiToken), // ← D-2 violation
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: 10,
            interestRateBpsMax: 500,
            collateralAmountMax: 1500,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    // ─── quoteVPFIDiscount ───────────────────────────────────────────────────

    function testQuoteVPFIDiscountForLenderOfferWithKnownBorrower() public {
        // For a Lender offer the borrower is unknown at the base view — use
        // the acceptor-aware {quoteVPFIDiscountFor}. Pre-fund borrower vault
        // to tier 1 (>= 100 VPFI) so the tier gate does not short-circuit.
        uint256 offerId = _createLenderErc20Offer(10_000 ether);
        // T-087 Sub 1.B — stake via the sanctioned `depositVPFIToVault`
        // path so the ring-buffer accumulator is populated. The raw
        // `vpfiToken.transfer + recordVaultDepositERC20` backdoor that
        // pre-T-087 Phase-5 tests used skips the rollup and leaves
        // EFFECTIVE_TIER at 0.
        vpfiToken.transfer(borrower, 500 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 500 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        vm.stopPrank();
        // Elapse the min-history gate (default 3 days) so EFFECTIVE_TIER
        // releases.
        vm.warp(block.timestamp + 4 days);

        (bool eligible, uint256 vpfi, uint256 bal, uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertTrue(eligible, "eligible");
        assertGt(vpfi, 0, "vpfi required non-zero");
        assertEq(bal, 500 ether, "surfaces borrower vault VPFI balance");
        assertEq(tier, 1, "tier 1");

        // Base view surfaces (false, 0, 0, 0) for Lender offers because the
        // acceptor is unknown at quote time.
        (bool eligibleBase, , , uint8 tierBase) = _facet().quoteVPFIDiscount(
            offerId
        );
        assertFalse(eligibleBase);
        assertEq(tierBase, 0);
    }

    function testQuoteVPFIDiscountIneligibleWhenRateNotSet() public {
        _facet().setVPFIDiscountRate(0);
        uint256 offerId = _createLenderErc20Offer(10_000 ether);
        address borrowerVault = _buyerVault(borrower);
        vpfiToken.transfer(borrowerVault, 500 ether);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), 500 ether); // tier 1

        (bool eligible, , , ) = _facet().quoteVPFIDiscountFor(offerId, borrower);
        assertFalse(eligible);
    }

    function testQuoteVPFIDiscountIneligibleForMissingOffer() public {
        (bool eligible, , , ) = _facet().quoteVPFIDiscount(9999);
        assertFalse(eligible);
    }

    function testQuoteVPFIDiscountIneligibleWhenBorrowerInTier0() public {
        // Borrower holds 0 VPFI in vault → tier 0, quote returns
        // (false, 0, 0, 0) without reverting. Uses acceptor-aware view since
        // base view returns false-for-known-borrower only on Borrower offers.
        uint256 offerId = _createLenderErc20Offer(10_000 ether);
        (bool eligible, uint256 vpfi, uint256 bal, uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertFalse(eligible);
        assertEq(vpfi, 0);
        assertEq(bal, 0);
        assertEq(tier, 0);
    }

    function testGetVPFIDiscountTier() public {
        address vault = _buyerVault(borrower);

        // Tier 0 — empty vault.
        (uint8 t0, uint256 bal0, uint256 bps0) = _facet().getVPFIDiscountTier(
            borrower
        );
        assertEq(t0, 0);
        assertEq(bal0, 0);
        assertEq(bps0, 0);

        // Tier 1: >= 100 and < 1,000 → 10%.
        vpfiToken.transfer(vault, 500 ether);
        (uint8 t1, , uint256 bps1) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t1, 1);
        assertEq(bps1, 1000);

        // Tier 2: >= 1,000 and < 5,000 → 15%. Bump to 2k.
        vpfiToken.transfer(vault, 1_500 ether);
        (uint8 t2, , uint256 bps2) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t2, 2);
        assertEq(bps2, 1500);

        // Tier 3 boundary: 20,000 inclusive. Currently at 2k → top up
        // to exactly 20,000.
        vpfiToken.transfer(vault, 18_000 ether);
        (uint8 t3, uint256 bal3, uint256 bps3) = _facet().getVPFIDiscountTier(
            borrower
        );
        assertEq(bal3, 20_000 ether);
        assertEq(t3, 3, "20k inclusive is tier 3");
        assertEq(bps3, 2000);

        // Tier 4: strictly > 20,000. Add 1 wei.
        vpfiToken.transfer(vault, 1);
        (uint8 t4, , uint256 bps4) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t4, 4);
        assertEq(bps4, 2400);
    }

    // ─── acceptOffer with platform-level consent: happy path ────────────────

    function testAcceptOfferWithVPFIDiscountApplied() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderErc20Offer(principal);

        // Seed borrower vault to tier 1 so the tier gate unlocks, then quote.
        // Phase 5: quote returns the FULL 0.1% LIF equivalent in VPFI
        // (no tier discount at init). Tier is still surfaced to show
        // what time-weighted rebate the borrower is positioned to earn.
        address borrowerVault = _buyerVault(borrower);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        // T-087 Sub 1.B — stake via the sanctioned `depositVPFIToVault`
        // path so the ring-buffer accumulator is populated.
        vpfiToken.transfer(borrower, 500 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 500 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        vm.stopPrank();
        // Clear min-history gate.
        vm.warp(block.timestamp + 4 days);

        (bool eligible, uint256 vpfiRequired, , uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertTrue(eligible);
        assertEq(tier, 1);
        assertGt(vpfiRequired, 0);

        // Top up so the vault has the tier-1 seed + enough to cover the
        // FULL VPFI-denominated LIF (not a discounted slice).
        vpfiToken.transfer(borrowerVault, vpfiRequired * 2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), vpfiRequired * 2);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 vaultVpfiBefore = vpfiToken.balanceOf(borrowerVault);
        uint256 lenderVaultBalBefore = IERC20(mockERC20).balanceOf(
            lenderVault
        );
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        // Borrower opts in to the platform-level VPFI-discount consent.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(
            offerId,
            true
        );

        // Lender vault is drained by exactly the full principal — no fee
        // skimmed before delivery.
        assertEq(
            lenderVaultBalBefore -
                IERC20(mockERC20).balanceOf(lenderVault),
            principal,
            "lender vault debited by principal only"
        );
        // Treasury did NOT receive any lending-asset fee (VPFI path takes
        // the fee in VPFI from borrower instead of lender-side haircut).
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient),
            treasuryErc20Before,
            "treasury ERC20 fee untouched on VPFI path"
        );
        // Phase 5: VPFI moves borrower vault → Diamond custody, NOT
        // treasury directly. Treasury credit happens at settlement when
        // the held amount splits between borrower rebate + treasury.
        assertEq(
            vaultVpfiBefore - vpfiToken.balanceOf(borrowerVault),
            vpfiRequired,
            "borrower vault debited VPFI"
        );
        assertEq(
            vpfiToken.balanceOf(address(diamond)) - diamondVpfiBefore,
            vpfiRequired,
            "Diamond holds VPFI pending settlement"
        );
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "treasury NOT credited VPFI at init on Phase 5 path"
        );
        (uint256 rebateAmount, uint256 vpfiHeld) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(vpfiHeld, vpfiRequired, "custody recorded against loanId");
        assertEq(rebateAmount, 0, "rebate not credited until settlement");
        assertGt(loanId, 0, "loan created");
    }

    // ─── acceptOffer overload: silent fallback branches ──────────────────────

    function testAcceptOfferFallsBackWhenBorrowerHasInsufficientVPFI() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderErc20Offer(principal);

        // Borrower opts in to platform consent but holds ZERO VPFI in
        // vault — tryApply must return (false, 0) and the lender-paid fee
        // path fires.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Fee = 0.1% of principal flows into treasury in the lending
        // asset, MINUS the 1% Range Orders Phase 1 matcher kickback
        // that goes to msg.sender (the borrower in this test).
        uint256 expectedFee = (principal * 10) / 10_000;
        uint256 expectedMatcherCut = (expectedFee * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryCut = expectedFee - expectedMatcherCut;
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            expectedTreasuryCut,
            "treasury credited 99% of LIF on fallback (1% matcher kickback)"
        );
        // No VPFI moved when fallback fires.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "no VPFI deducted on fallback"
        );
    }

    function testAcceptOfferFallsBackWhenLendingAssetIlliquid() public {
        // Switch the lending asset's mocked liquidity to Illiquid; the
        // discount path bails silently and normal flow runs.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        // Collateral flag also needs consent; we already pass true below.

        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderErc20Offer(principal);

        address borrowerVault = _buyerVault(borrower);
        vpfiToken.transfer(borrowerVault, 5_000 ether);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), 5_000 ether); // plenty

        // Borrower opts in; discount still skipped because asset is illiquid.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // No VPFI moved — discount path skipped entirely.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "treasury VPFI unchanged"
        );
    }

    // ─── emitDiscountApplied access control ──────────────────────────────────

    function testEmitDiscountAppliedRevertsWhenCalledDirectly() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _facet().emitDiscountApplied(1, address(this), mockERC20, 1 ether);
    }

    function testEmitYieldFeeDiscountAppliedRevertsWhenCalledDirectly() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _facet().emitYieldFeeDiscountApplied(
            1,
            address(this),
            mockERC20,
            1 ether
        );
    }

    // ─── Lender Yield Fee Discount (Tokenomics §6) ───────────────────────────

    /// @notice Happy path: lender has consent + funded vault → on full
    ///         repayment the 1% treasury cut is paid in VPFI from the
    ///         lender's vault, and the lender keeps 100% of interest in
    ///         the lending asset.
    function testRepayAppliesLenderYieldFeeDiscount() public {
        uint256 principal = 10_000 ether;

        // Lender funds vault via the sanctioned deposit path BEFORE the
        // offer is accepted — this is the only path that wires the lender
        // into `rollupUserDiscount`, which stamps their current tier so
        // it applies for the full loan window. Raw `transfer(vault, …)`
        // bypasses the rollup entirely and (correctly) yields a zero
        // time-weighted average at settlement.
        vpfiToken.transfer(lender, 5_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(5_000 ether);
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        // T-087 Sub 1.B — elapse the min-history gate so the lender's
        // EFFECTIVE_TIER releases before the loan opens.
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);

        // Borrower accepts normally (no borrower discount).
        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        // Advance past the full loan duration so interest fully accrues.
        vm.warp(block.timestamp + 30 days);

        // Borrower pre-approves the repay amount (principal + interest).
        // interestRateBps = 500 (5%), duration 30d → interest ≈ principal
        // * 500 * 30 / (365 * 10000) ≈ 0.4% of principal. Approve the
        // full principal + a generous interest pad.
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryERC20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 lenderVaultBefore = IERC20(mockERC20).balanceOf(lenderVault);
        uint256 lenderVpfiBefore = vpfiToken.balanceOf(lenderVault);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Treasury did NOT receive any lending-asset yield-fee cut.
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient),
            treasuryERC20Before,
            "treasury ERC20 untouched on lender discount path"
        );
        // Treasury DID receive VPFI (exact amount matches vault debit).
        uint256 treasuryVpfiDelta = vpfiToken.balanceOf(treasuryRecipient) -
            treasuryVpfiBefore;
        uint256 lenderVpfiDelta = lenderVpfiBefore -
            vpfiToken.balanceOf(lenderVault);
        assertGt(treasuryVpfiDelta, 0, "treasury got VPFI");
        assertEq(
            treasuryVpfiDelta,
            lenderVpfiDelta,
            "VPFI conserved: lender vault delta == treasury delta"
        );
        // Lender vault received principal + full interest (no haircut).
        uint256 lenderVaultDelta = IERC20(mockERC20).balanceOf(lenderVault) -
            lenderVaultBefore;
        assertGe(
            lenderVaultDelta,
            principal,
            "lender vault at least principal"
        );
    }

    /// @notice Fallback: lender has consent but ZERO VPFI in vault → the
    ///         normal 1% split fires. Treasury receives the ERC-20 cut and
    ///         the lender vault receives principal + 99% of interest.
    function testRepayFallsBackWhenLenderHasNoVPFI() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderErc20Offer(principal);

        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        // Lender opts in, but holds ZERO VPFI in vault.
        vm.prank(lender);
        _facet().setVPFIDiscountConsent(true);

        vm.warp(block.timestamp + 30 days);
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryERC20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Fallback fired → treasury received the lending-asset cut.
        assertGt(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryERC20Before,
            0,
            "treasury ERC20 credited on fallback"
        );
    }

    /// @notice Helper: borrower accepts a lender ERC-20 offer and the loan
    ///         lands in `Active` status. No VPFI-discount consent is set.
    function _approveAndAcceptForLoan(
        uint256 offerId,
        uint256 principal
    ) internal {
        // Borrower needs to post collateral equal to principal.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    // ─── Phase 5 — Borrower LIF time-weighted rebate ─────────────────────────

    /// @notice Long-hold happy path: borrower funds vault via the sanctioned
    ///         deposit (which wires the discount rollup so the stamp is live
    ///         for the whole loan window), accepts via the VPFI path, holds
    ///         through the full loan duration, repays properly. The rebate
    ///         at claim-time should be the tier-1 percentage (10%) of the
    ///         VPFI paid up-front.
    function testBorrowerLifRebateCreditedOnProperRepayLongHold() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via the sanctioned deposit path so the
        // discount accumulator is stamped correctly.
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1 (≥ 100 < 1000)
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        // T-087 Sub 1.B — clear min-history gate so the quote/accept
        // path sees a non-zero EFFECTIVE_TIER.
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);

        // Top up enough to cover the full 0.1% LIF in VPFI.
        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        vpfiToken.transfer(_buyerVault(borrower), vpfiRequired * 2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), vpfiRequired * 2);

        // Also fund borrower collateral for acceptOffer.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Phase 5 custody: the Diamond holds the full LIF in VPFI.
        (uint256 rebateAtInit, uint256 heldAtInit) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(rebateAtInit, 0, "no rebate until settlement");
        assertEq(heldAtInit, vpfiRequired, "custody records full LIF");

        // Advance past the full duration so the borrower accrued tier-1 across
        // the entire loan.
        vm.warp(block.timestamp + 30 days);

        // Borrower repays the loan fully. settleBorrowerLifProper should split
        // the held amount: rebateAmount = held × avgBps / BPS, treasury share
        // = remainder.
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (uint256 rebateAfterRepay, uint256 heldAfterRepay) = ClaimFacet(
            address(diamond)
        ).getBorrowerLifRebate(loanId);
        assertEq(heldAfterRepay, 0, "custody drained at settlement");
        assertGt(rebateAfterRepay, 0, "rebate credited");
        // Tier 1 = 1000 bps discount ⇒ rebate == held × 10%.
        // Allow 1% slack for same-block accrual edge effects.
        uint256 expected = (vpfiRequired * 1000) / 10_000;
        assertApproxEqRel(rebateAfterRepay, expected, 0.01e18, "rebate ~10% of held");

        // Treasury received (held − rebate) in VPFI MINUS the 1% Range
        // Orders matcher kickback. Per design §"1% match fee mechanic"
        // the matcher gets 1% of any LIF flowing to treasury; on the
        // VPFI path this fires at proper-close (here). msg.sender at
        // accept = borrower = matcher, so the borrower receives the
        // matcher cut directly in VPFI.
        uint256 fullTreasuryShare = vpfiRequired - rebateAfterRepay;
        uint256 expectedMatcherCut =
            (fullTreasuryShare * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryDelta = fullTreasuryShare - expectedMatcherCut;
        uint256 treasuryDelta = vpfiToken.balanceOf(treasuryRecipient) -
            treasuryVpfiBefore;
        assertEq(
            treasuryDelta,
            expectedTreasuryDelta,
            "treasury got (held - rebate) MINUS 1% matcher kickback in VPFI"
        );
    }

    /// @notice Stamp-refresh fix verification (Option X): borrower tops up to
    ///         tier 1 just before loan acceptance, accepts the VPFI path,
    ///         then immediately withdraws back to tier 0. On settlement
    ///         after the full duration the time-weighted avg BPS must be
    ///         ≈ 0 (not tier-1 BPS) because the stamp re-seeded at post-
    ///         mutation balance after each mutation. This is the exact
    ///         gaming vector Phase 5 was designed to block.
    function testBorrowerLifGamingBlockedByStampRefresh() public {
        uint256 principal = 10_000 ether;

        // Tier-1 seed via deposit so the accumulator is live.
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        // T-087 Sub 1.B — clear min-history gate so the borrower can
        // open the loan at tier 1. The post-acceptance immediate-
        // unstake still drives EFFECTIVE_TIER back to 0 at settlement
        // time (full-unstake reset per design §4.1), so the rebate
        // remains 0 by parity with the Phase-5 stamp-refresh outcome.
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);

        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        // Top up so the vault can cover the LIF itself.
        vpfiToken.transfer(_buyerVault(borrower), vpfiRequired * 2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), vpfiRequired * 2);

        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Immediately unstake the lot — stamp-refresh fix should set the
        // post-withdraw stamp at tier 0, so the whole loan period accrues
        // at tier-0 BPS (0).
        uint256 withdrawable = vpfiToken.balanceOf(_buyerVault(borrower));
        vm.prank(borrower);
        _facet().withdrawVPFIFromVault(withdrawable);

        // Full term at tier 0.
        vm.warp(block.timestamp + 30 days);

        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (uint256 rebate, uint256 held) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(held, 0, "custody drained");
        // With stamp-refresh fix, the post-mutation stamp is tier 0, so the
        // rebate should be ≈ 0. We accept a tiny non-zero value from the
        // pre-withdraw same-block tier-1 window but not anywhere close to
        // the full tier-1 rate.
        uint256 fullTier1 = (vpfiRequired * 1000) / 10_000;
        assertLt(rebate, fullTier1 / 100, "gaming blocked: rebate well under tier-1");
    }

    /// @notice Forfeit path: VPFI-path loan that defaults routes the full
    ///         held amount to treasury with zero rebate. The Diamond must
    ///         not retain any VPFI for the loan, and the borrower's claim
    ///         slot carries zero rebateAmount.
    function testBorrowerLifForfeitedOnDefault() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via deposit (stamp live).
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        // Use an illiquid-principal offer so default goes through
        // DefaultedFacet.markDefaulted rather than the HF-liquidation path,
        // and acceptOffer takes the VPFI path.
        uint256 offerId = _createLenderErc20Offer(principal);

        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        vpfiToken.transfer(_buyerVault(borrower), vpfiRequired * 2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(borrower, address(vpfiToken), vpfiRequired * 2);

        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Skip past grace period so time-based default fires.
        vm.warp(block.timestamp + 60 days);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        // Lender calls triggerDefault — triggers forfeitBorrowerLif.
        vm.prank(lender);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        (uint256 rebate, uint256 held) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(held, 0, "custody drained on default");
        assertEq(rebate, 0, "no rebate on default");

        // Full held amount left the Diamond — drained correctly.
        // Range Orders Phase 1: 1% goes to the recorded matcher
        // (msg.sender at accept = borrower), 99% to treasury. Both
        // outflow paths together drain the full vpfiRequired.
        assertEq(
            diamondVpfiBefore - vpfiToken.balanceOf(address(diamond)),
            vpfiRequired,
            "Diamond drained the full custody"
        );
        uint256 expectedMatcherCut =
            (vpfiRequired * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryDelta = vpfiRequired - expectedMatcherCut;
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient) - treasuryVpfiBefore,
            expectedTreasuryDelta,
            "treasury got 99% of forfeited VPFI (1% matcher kickback)"
        );
    }

    function _createLenderErc20Offer(uint256 amount) internal returns (uint256) {
        // Lender funds the offer with `amount` of mockERC20; collateral is
        // the same asset to keep test wiring minimal.
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        return
            OfferCreateFacet(address(diamond)).createOffer(
                LibVaipakam.CreateOfferParams({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    amount: amount,
                    interestRateBps: 500,
                    collateralAsset: mockCollateralERC20,
                    collateralAmount: amount,
                    durationDays: 30,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    creatorRiskAndTermsConsent: true,
                    prepayAsset: mockERC20,
                    collateralAssetType: LibVaipakam.AssetType.ERC20,
                    collateralTokenId: 0,
                    collateralQuantity: 0,
                    allowsPartialRepay: false,
                    allowsPrepayListing: false,
                    allowsParallelSale: false,
                    amountMax: amount,
                    interestRateBpsMax: 500,
                    collateralAmountMax: amount,
                    periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                    expiresAt: 0,
                    fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
                })
            );
    }
}
