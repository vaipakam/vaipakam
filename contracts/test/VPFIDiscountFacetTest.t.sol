// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

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
    // RL-2 — VPFI tracked-balance debit observability (VaultFactoryFacet).
    event VaultVpfiDebited(
        address indexed user,
        uint256 amount,
        address recipient
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

    // ─── #800 — Tier-1 sanctions gate on the VPFI value-in / value-out paths ──
    //
    // SanctionsOracle.t.sol can't reach these (its diamond doesn't cut the
    // VPFIDiscountFacet selectors), so the VPFI deposit/withdraw Tier-1 gates
    // are pinned here, alongside the rest of the facet's fixture. Deposit is a
    // fresh value-IN path; withdraw routes vault VPFI back OUT to the caller —
    // both must revert `SanctionedAddress` for a flagged wallet.

    function test_depositVPFIToVault_RevertsWhenSanctioned() public {
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);

        vm.prank(borrower);
        vpfiToken.approve(address(diamond), 100 ether);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibVaipakam.SanctionedAddress.selector,
                borrower
            )
        );
        _facet().depositVPFIToVault(100 ether);
    }

    function test_withdrawVPFIFromVault_RevertsWhenSanctioned() public {
        // Deposit while clean, THEN flag — mirrors a wallet added to the SDN
        // list mid-position. The value-OUT withdraw must still be blocked.
        uint256 staked = 100 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), staked);
        vm.prank(borrower);
        _facet().depositVPFIToVault(staked);

        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibVaipakam.SanctionedAddress.selector,
                borrower
            )
        );
        _facet().withdrawVPFIFromVault(staked);
    }

    // ─── RL-2 — VaultVpfiDebited observability event ─────────────────────────

    /// @notice RL-2 (VpfiRecyclingLoopClosureDesign §6): every tracked VPFI
    ///         debit through the single decrement chokepoint emits
    ///         {VaultVpfiDebited} so the off-chain reward-retention ledger
    ///         sees vault outflows. A wallet unstake is the canonical debit —
    ///         recipient is the unstaking user.
    function test_RL2_withdrawEmitsVaultVpfiDebited() public {
        uint256 staked = 100 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), staked);
        vm.prank(borrower);
        _facet().depositVPFIToVault(staked);

        uint256 unstake = 40 ether;
        vm.expectEmit(true, false, false, true, address(diamond));
        emit VaultVpfiDebited(borrower, unstake, borrower);
        vm.prank(borrower);
        _facet().withdrawVPFIFromVault(unstake);
    }

    /// @notice The debit event is VPFI-only by design: a plain ERC-20 vault
    ///         deposit/withdraw of a non-VPFI token must NOT emit it (the
    ///         loop-closure ledger tracks the protocol token, not general
    ///         vault traffic).
    function test_RL2_nonVpfiWithdrawDoesNotEmit() public {
        // Route a non-VPFI ERC-20 through the same chokepoint via the
        // diamond-internal surface (prank as the diamond itself).
        uint256 amount = 25 ether;
        ERC20Mock(mockERC20).mint(borrower, amount);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), amount);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(
            borrower, address(mockERC20), amount
        );

        vm.recordLogs();
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower, address(mockERC20), borrower, amount
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 debitedTopic =
            keccak256("VaultVpfiDebited(address,uint256,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != debitedTopic,
                "non-VPFI withdraw must not emit VaultVpfiDebited"
            );
        }
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

        // HoldOnly hybrid (#1352, §F3): a consenting, tier-holding borrower on
        // a LIQUID lending asset pays the DISCOUNTED lending-asset LIF at
        // accept — the retired peg-custody VPFI path (borrower vault → Diamond
        // custody → time-weighted rebate) no longer runs, so no VPFI leaves the
        // borrower's vault and `vpfiHeld` stays 0.
        address borrowerVault = _buyerVault(borrower);
        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);
        // Stake borrower to tier 1 via the sanctioned `depositVPFIToVault`
        // path so the ring-buffer accumulator is populated and the hold-tier
        // discount is live.
        vpfiToken.transfer(borrower, 500 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 500 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        vm.stopPrank();
        // Clear min-history gate so the effective tier releases.
        vm.warp(block.timestamp + 4 days);

        // Borrower opts in to the platform-level VPFI-discount consent.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        // Compute the expected charge from the same inputs the shared helper
        // (`LibVPFIDiscount.holdOnlyBorrowerLif`) uses: base LIF = principal ×
        // LIF bps, discounted by the borrower's hold-tier bps (liquid asset),
        // then the 99/1 treasury/matcher split.
        (, , uint256 dBorrower) = _facet().getVPFIDiscountTier(borrower);
        assertEq(dBorrower, 1000, "tier 1 hold discount = 10%");
        uint256 baseLif = (principal * LibVaipakam.LOAN_INITIATION_FEE_BPS) /
            10_000;
        uint256 discountedLif = (baseLif * (10_000 - dBorrower)) / 10_000;
        uint256 matcherCut = (discountedLif *
            LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryLif = discountedLif - matcherCut;

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 vaultVpfiBefore = vpfiToken.balanceOf(borrowerVault);
        uint256 lenderVaultBalBefore = IERC20(mockERC20).balanceOf(
            lenderVault
        );
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Lender vault is drained by exactly the full principal — the LIF is a
        // borrower cash haircut sourced from the lender's funded principal
        // (treasury cut + matcher cut + net-to-borrower == principal).
        assertEq(
            lenderVaultBalBefore -
                IERC20(mockERC20).balanceOf(lenderVault),
            principal,
            "lender vault debited by principal (fee sourced from principal)"
        );
        // HoldOnly retirement: the treasury GETS the discounted lending-asset
        // LIF (99% after the 1% matcher kickback) — NOT zero, and NOT in VPFI.
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            expectedTreasuryLif,
            "treasury credited 99% of the discounted lending-asset LIF"
        );
        // No VPFI leaves the borrower vault, none enters Diamond custody, none
        // reaches treasury — the peg-custody path is retired for new loans.
        assertEq(
            vpfiToken.balanceOf(borrowerVault),
            vaultVpfiBefore,
            "borrower vault VPFI untouched (no custody taken)"
        );
        assertEq(
            vpfiToken.balanceOf(address(diamond)),
            diamondVpfiBefore,
            "Diamond takes no VPFI custody on the HoldOnly path"
        );
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "no VPFI to treasury"
        );
        // The custody receipt stays empty for a new HoldOnly loan.
        (uint256 rebateAmount, uint256 vpfiHeld) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(vpfiHeld, 0, "new loan takes NO VPFI custody (vpfiHeld == 0)");
        assertEq(rebateAmount, 0, "no rebate slot for a HoldOnly loan");
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

        _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Fee = 0.2% of principal (rev-8 freeze, #1352) flows into treasury
        // in the lending asset, MINUS the 1% Range Orders Phase 1 matcher
        // kickback that goes to msg.sender (the borrower in this test).
        uint256 expectedFee = (principal * 20) / 10_000;
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

        _signAndAcceptOffer(borrower, borrowerPk, offerId);

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

    /// @notice #1352 (Codex P2) — the lender yield-fee discount is clamped at
    ///         the uniform 50% ceiling (`MAX_FEE_DISCOUNT_BPS`), even when
    ///         governance configures a tier discount above it (the setter
    ///         permits up to `MAX_DISCOUNT_BPS = 9000`). Differential proof
    ///         over the direct-reduction path (peg unset, so both loans take
    ///         the SAME settlement branch): two identical loans by the same
    ///         tier-4 lender — one with the tier-4 discount set to exactly 50%,
    ///         one set to 90% — must leave the SAME lending-asset yield fee in
    ///         the treasury. Without the clamp the 90% loan would let the
    ///         treasury collect only 10% (a 90% reduction) vs. 50%, so equality
    ///         ⇒ the 90% tier was clamped to 50%. The full yield fee is
    ///         identical across the two loans (same principal / rate / duration).
    function testLenderYieldFeeDiscountClampedAtFiftyPercent() public {
        uint256 principal = 10_000 ether;

        // Stake the lender above the tier-4 threshold (20,000e18) so both loans
        // resolve at tier 4, and consent so the discount path engages.
        vpfiToken.transfer(lender, 30_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 30_000 ether);
        _facet().depositVPFIToVault(25_000 ether); // tier 4 (> 20,000e18)
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days); // clear min-history gate

        // Force the DIRECT-REDUCTION branch (E-1 #1203): with the VPFI price
        // peg unset, `tryApplyYieldFee` fails and settlement reduces the
        // lending-asset treasury cut by the (clamped) tier bps. This keeps both
        // loans on one path, so the treasury delta is a clean, monotonic proxy
        // for the applied discount.
        _facet().setVPFIDiscountRate(0);

        // ── Loan A: tier-4 discount = exactly 50% (the clamp boundary) ──
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 5000);
        uint256 treasuryFeeA = _openRepayAndMeasureTreasuryYieldFee(principal, 1);

        // ── Loan B: tier-4 discount = 90% (above the clamp) ──
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 9000);
        uint256 treasuryFeeB = _openRepayAndMeasureTreasuryYieldFee(principal, 2);

        assertGt(treasuryFeeA, 0, "clamp test: treasury collected the un-discounted half");
        assertEq(
            treasuryFeeB,
            treasuryFeeA,
            "90% tier clamps to the same 50% yield-fee discount as the 50% tier"
        );
    }

    /// @dev Opens a fresh lender-funded loan, advances a full 30-day term,
    ///      repays it, and returns the lending-asset yield fee the treasury
    ///      actually collected at settlement. Used by the yield-fee clamp
    ///      differential above. `expectedLoanId` is the sequential id.
    function _openRepayAndMeasureTreasuryYieldFee(
        uint256 principal,
        uint256 expectedLoanId
    ) internal returns (uint256 treasuryFee) {
        uint256 offerId = _createLenderErc20Offer(principal);
        _approveAndAcceptForLoan(offerId, principal);

        // Warp to THIS loan's due, read from storage. Deriving the target from
        // an SLOAD (`loan.startTime`) rather than `block.timestamp + 30 days`
        // is deliberate: this helper runs twice, and viaIR folds a
        // `block.timestamp`-derived warp target (even via a local) back to a
        // single cached `TIMESTAMP`, so the second warp lands at
        // now + 30 days instead of open + 30 days — overshooting the grace
        // period. The per-loan due is full-interest and exactly at maturity.
        LibVaipakam.Loan memory ln = LoanFacet(address(diamond)).getLoanDetails(
            expectedLoanId
        );
        vm.warp(ln.startTime + ln.durationDays * 1 days); // due; full interest, within grace

        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(treasuryRecipient);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(expectedLoanId);

        treasuryFee = IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before;
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

    // ─── E-1 (#1203) — direct-reduction delivery when no VPFI price source ────

    /// @notice Full loan setup with a consenting, tiered lender BUT no VPFI
    ///         price source configured: the hold-tier discount is delivered as
    ///         a direct reduction of the lending-asset treasury fee — treasury
    ///         gets `fullFee × (1 − effBps)`, the lender keeps the difference,
    ///         and NO VPFI moves.
    function testRepayDirectReductionWhenNoPriceSource() public {
        // Unset the price source seeded in setUp → direct-reduction regime.
        _facet().setVPFIDiscountRate(0);

        uint256 principal = 10_000 ether;

        // Lender funds vault via the sanctioned deposit (wires the rollup) +
        // consents, then elapses the min-history gate so the tier releases.
        vpfiToken.transfer(lender, 5_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(5_000 ether);
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);
        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        // The lender holds 5,000 VPFI steadily from before the loan through
        // settlement (no VPFI moves on the direct path), past the min-history
        // gate, so the effective settlement discount equals the raw tier bps.
        (, , uint256 effBps) = _facet().getVPFIDiscountTier(lender);
        assertGt(effBps, 0, "lender should hold a non-zero tier");

        address lenderVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(lender);

        vm.warp(block.timestamp + 30 days);
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(treasuryRecipient);
        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 lenderVpfiBefore = vpfiToken.balanceOf(lenderVault);
        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Fee base = interest (+ any late fee) = what the borrower paid over
        // principal; the discount is a treasury→lender reallocation, so the
        // borrower's total is unchanged by it.
        uint256 feeBase = (borrowerBefore -
            IERC20(mockERC20).balanceOf(borrower)) - principal;
        uint256 fullFee = (feeBase * 200) / 10000; // TREASURY_FEE_BPS = 200 (rev-8 freeze, #1352)
        // Mirror the contract's rounding EXACTLY: it computes the reduction as
        // `floor(fullFee × effBps / 10000)` then subtracts it, rather than
        // `floor(fullFee × (10000 − effBps) / 10000)` (which can differ by 1 wei).
        uint256 reduction = (fullFee * effBps) / 10000;
        uint256 expectedTreasury = fullFee - reduction;

        // Treasury received the REDUCED lending-asset fee (exact).
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            expectedTreasury,
            "treasury got the tier-reduced lending-asset fee"
        );
        // And strictly less than the undiscounted fee, but non-zero.
        assertLt(expectedTreasury, fullFee, "fee is reduced");
        assertGt(expectedTreasury, 0, "fee not fully waived (partial reduction)");
        // NO VPFI moved on either side — this is a fee schedule, not a payment.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "no VPFI to treasury"
        );
        assertEq(
            vpfiToken.balanceOf(lenderVault),
            lenderVpfiBefore,
            "no VPFI debited from lender vault"
        );
    }

    /// @notice No price source + lender has NOT consented → the full
    ///         lending-asset treasury fee is charged (direct-reduction inert).
    function testRepayFullFeeWhenConsentOffNoPriceSource() public {
        _facet().setVPFIDiscountRate(0);

        uint256 principal = 10_000 ether;
        // Lender holds a tier but never consents.
        vpfiToken.transfer(lender, 5_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(5_000 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);
        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        vm.warp(block.timestamp + 30 days);
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(treasuryRecipient);
        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint256 feeBase = (borrowerBefore -
            IERC20(mockERC20).balanceOf(borrower)) - principal;
        uint256 fullFee = (feeBase * 200) / 10000; // TREASURY_FEE_BPS = 200 (rev-8 freeze, #1352)
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            fullFee,
            "full fee charged when consent off"
        );
    }

    /// @notice No price source + consent but ZERO vaulted VPFI (tier 0) → the
    ///         full fee is charged (direct-reduction returns 0 on tier 0).
    function testRepayFullFeeWhenTierZeroNoPriceSource() public {
        _facet().setVPFIDiscountRate(0);

        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderErc20Offer(principal);
        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        // Consent but no VPFI in vault → tier 0 → no discount.
        vm.prank(lender);
        _facet().setVPFIDiscountConsent(true);

        vm.warp(block.timestamp + 30 days);
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(treasuryRecipient);
        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint256 feeBase = (borrowerBefore -
            IERC20(mockERC20).balanceOf(borrower)) - principal;
        uint256 fullFee = (feeBase * 200) / 10000; // TREASURY_FEE_BPS = 200 (rev-8 freeze, #1352)
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            fullFee,
            "full fee charged when tier 0"
        );
    }

    /// @notice Helper: borrower accepts a lender ERC-20 offer and the loan
    ///         lands in `Active` status. No VPFI-discount consent is set.
    function _approveAndAcceptForLoan(
        uint256 offerId,
        uint256 principal
    ) internal {
        // Borrower needs to post collateral equal to principal.
        // #998 S15 floor: the offer requires 2x principal collateral now.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal * 2);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal * 2);

        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    // ─── Phase 5 — Borrower LIF time-weighted rebate ─────────────────────────

    /// @notice Grandfathered custody settlement (#1352): new HoldOnly loans
    ///         never take VPFI custody, but an OPEN loan that already carries
    ///         `vpfiHeld > 0` (a pre-#1352 origination) still settles through
    ///         the UNTOUCHED `settleBorrowerLifProper` helper on proper repay.
    ///         Simulated here by seeding `vpfiHeld` via the test mutator on a
    ///         tier-1 borrower who holds through the full loan window: the
    ///         rebate at settlement is the tier-1 percentage (10%) of the held
    ///         VPFI, with the remainder split 99/1 treasury/matcher.
    function testBorrowerLifRebateCreditedOnProperRepayLongHold() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via the sanctioned deposit path so the
        // discount accumulator is stamped correctly (drives avgBps at settle).
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1 (≥ 100 < 1000)
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        // T-087 Sub 1.B — clear min-history gate so EFFECTIVE_TIER releases.
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);

        // Fund borrower collateral for acceptOffer.
        // #998 S15 floor: the offer requires 2x principal collateral now.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal * 2);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal * 2);

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // New HoldOnly loan takes NO custody at accept.
        (uint256 rebateAtInit, uint256 heldAtInit) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(rebateAtInit, 0, "no rebate at init");
        assertEq(heldAtInit, 0, "new HoldOnly loan takes no custody");

        // Seed a grandfathered custody balance directly to exercise the
        // still-live `settleBorrowerLifProper` path (a pre-#1352 open loan).
        uint256 held = 20 ether;
        TestMutatorFacet(address(diamond)).setBorrowerLifVpfiHeldRaw(loanId, held);

        // Advance past the full duration so the borrower accrued tier-1 across
        // the entire loan (avgBps == tier-1 bps at settle).
        vm.warp(block.timestamp + 30 days);

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
        // Tier 1 = 1000 bps discount ⇒ rebate == held × 10%. Steady tier-1
        // hold + cleared min-history ⇒ the time-weighted avg is exactly the
        // raw tier bps, so this is exact (no slack needed).
        uint256 expected = (held * 1000) / 10_000;
        assertEq(rebateAfterRepay, expected, "rebate == 10% of held");

        // Treasury received (held − rebate) in VPFI MINUS the 1% Range
        // Orders matcher kickback. Per design §"1% match fee mechanic"
        // the matcher gets 1% of any LIF flowing to treasury; on the
        // custody path this fires at proper-close (here). msg.sender at
        // accept = borrower = matcher, so the borrower receives the
        // matcher cut directly in VPFI.
        uint256 fullTreasuryShare = held - rebateAfterRepay;
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

    /// @notice Stamp-refresh anti-gaming (unchanged by #1352): the
    ///         `settleBorrowerLifProper` avgBps read is the borrower's LIVE
    ///         effective tier, so a borrower who holds tier 1 at accept then
    ///         immediately unstakes back to tier 0 earns ≈ 0 rebate on a
    ///         grandfathered custody balance — not the tier-1 rate. The custody
    ///         balance is seeded via the mutator (new HoldOnly loans take no
    ///         custody); the accumulator behaviour under test is untouched.
    function testBorrowerLifGamingBlockedByStampRefresh() public {
        uint256 principal = 10_000 ether;

        // Tier-1 seed via deposit so the accumulator is live.
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        // T-087 Sub 1.B — clear min-history gate so the borrower opens at
        // tier 1. The post-acceptance immediate-unstake still drives
        // EFFECTIVE_TIER back to 0 at settlement time (full-unstake reset
        // per design §4.1), so the rebate remains ≈ 0.
        vm.warp(block.timestamp + 4 days);

        uint256 offerId = _createLenderErc20Offer(principal);

        // #998 S15 floor: the offer requires 2x principal collateral now.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal * 2);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal * 2);

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Seed a grandfathered custody balance so the settle helper runs.
        uint256 held = 20 ether;
        TestMutatorFacet(address(diamond)).setBorrowerLifVpfiHeldRaw(loanId, held);

        // Immediately unstake the lot — the live effective tier drops to 0,
        // so the whole loan period settles at tier-0 BPS (0).
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

        (uint256 rebate, uint256 heldAfter) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(heldAfter, 0, "custody drained");
        // The post-mutation effective tier is 0, so the rebate should be ≈ 0.
        // Accept a tiny non-zero value but nowhere near the full tier-1 rate.
        uint256 fullTier1 = (held * 1000) / 10_000;
        assertLt(rebate, fullTier1 / 100, "gaming blocked: rebate well under tier-1");
    }

    /// @notice Grandfathered forfeit path (#1352): an open loan carrying
    ///         `vpfiHeld > 0` (pre-#1352 custody) that DEFAULTS routes the
    ///         full held amount to treasury with zero rebate through the
    ///         UNTOUCHED `forfeitBorrowerLif` helper. New HoldOnly loans take
    ///         no custody, so the held balance is seeded via the test mutator.
    function testBorrowerLifForfeitedOnDefault() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via deposit + consent (mirrors a
        // pre-#1352 VPFI-path borrower).
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        // Use an ERC-20-principal offer so default goes through
        // DefaultedFacet.triggerDefault rather than the HF-liquidation path.
        uint256 offerId = _createLenderErc20Offer(principal);

        // #998 S15 floor: the offer requires 2x principal collateral now.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal * 2);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal * 2);

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // New HoldOnly loan carries no custody — seed a grandfathered balance
        // to exercise the forfeit helper.
        uint256 held = 20 ether;
        assertEq(
            _borrowerVpfiHeld(loanId),
            0,
            "new HoldOnly loan takes no custody at accept"
        );
        TestMutatorFacet(address(diamond)).setBorrowerLifVpfiHeldRaw(loanId, held);

        // Skip past grace period so time-based default fires.
        vm.warp(block.timestamp + 60 days);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        // Lender calls triggerDefault — triggers forfeitBorrowerLif.
        vm.prank(lender);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        (uint256 rebate, uint256 held2) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(held2, 0, "custody drained on default");
        assertEq(rebate, 0, "no rebate on default");

        // Full held amount left the Diamond — drained correctly.
        // Range Orders Phase 1: 1% goes to the recorded matcher
        // (msg.sender at accept = borrower), 99% to treasury. Both
        // outflow paths together drain the full held amount.
        assertEq(
            diamondVpfiBefore - vpfiToken.balanceOf(address(diamond)),
            held,
            "Diamond drained the full custody"
        );
        uint256 expectedMatcherCut =
            (held * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryDelta = held - expectedMatcherCut;
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient) - treasuryVpfiBefore,
            expectedTreasuryDelta,
            "treasury got 99% of forfeited VPFI (1% matcher kickback)"
        );
    }

    /// @dev Convenience reader for the Diamond-held borrower-LIF custody.
    function _borrowerVpfiHeld(uint256 loanId) internal view returns (uint256) {
        (, uint256 held) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        return held;
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
                    // #998 S15 floor: collateral >= ~1.765x lending on liquid
                    // ERC-20 both-legs offers. 2x clears it (was 1x amount).
                    collateralAmount: amount * 2,
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
                    collateralAmountMax: amount * 2,
                    periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                    expiresAt: 0,
                    fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
                })
            );
    }

    // --- #1354 (M2 PR-6) --- settlement sweep honors the lender Full stamp ----
    //
    // Formula section F2: at every lender-yield settlement the treasury cut is
    // discounted by d = min(d_hold + d_tariff, 5000), where d_hold is the
    // consent-gated hold-tier discount and d_tariff = (lenderMode == Full) ?
    // 1000 : 0. These tests drive the peg-unset DIRECT-REDUCTION path (the
    // Phase-1 delivery mode), where the treasury delta at repay is a clean,
    // exact proxy for the applied d. Each test first measures the undiscounted
    // baseFee from a reference loan (consent off, no stamp) and asserts the
    // treated loan collects baseFee - baseFee*d/BPS -- the exact integer order
    // directReductionYieldFee uses.

    uint256 private constant _SWEEP_PRINCIPAL = 10_000 ether;

    /// @dev Expected discounted treasury fee, matching the contract integer
    ///      order: reduction = full*d/BPS; fee = full - reduction.
    function _discountedFee(uint256 baseFee, uint256 d) internal pure returns (uint256) {
        return baseFee - (baseFee * d) / LibVaipakam.BASIS_POINTS;
    }

    /// @dev Open a fresh lender-funded loan, optionally stamp the
    ///      FeeEntitlement modes the #1347 charger would write, run the full
    ///      30-day term, repay, and return the lending-asset yield fee the
    ///      treasury actually collected. Deriving the warp target from the
    ///      loan's own startTime (an SLOAD) keeps the second call landing at
    ///      open + 30 days under viaIR TIMESTAMP folding, per the clamp helper.
    function _openStampRepayTreasuryFee(
        uint256 loanId,
        LibVaipakam.FeeEntitlementMode lenderMode,
        LibVaipakam.FeeEntitlementMode borrowerMode
    ) internal returns (uint256 treasuryFee) {
        uint256 offerId = _createLenderErc20Offer(_SWEEP_PRINCIPAL);
        _approveAndAcceptForLoan(offerId, _SWEEP_PRINCIPAL);

        LibVaipakam.Loan memory ln = LoanFacet(address(diamond)).getLoanDetails(loanId);

        // Only stamp when a party opts in; a None/None reference loan leaves
        // the zero entitlement struct so it takes the undiscounted path.
        if (
            lenderMode != LibVaipakam.FeeEntitlementMode.None ||
            borrowerMode != LibVaipakam.FeeEntitlementMode.None
        ) {
            TestMutatorFacet(address(diamond)).setFeeEntitlementRaw(
                loanId,
                LibVaipakam.FeeEntitlement({
                    borrowerMode: borrowerMode,
                    lenderMode: lenderMode,
                    openDays: uint32(ln.durationDays),
                    rewardHaircutBpsAtOpen: 0,
                    borrowerTariffPaid: 0,
                    lenderTariffPaid: 0,
                    cStarOpen: 0,
                    loanSideRewardCapOpen: 0
                })
            );
        }

        vm.warp(ln.startTime + ln.durationDays * 1 days); // due; full interest, within grace

        uint256 approvalPad = _SWEEP_PRINCIPAL + (_SWEEP_PRINCIPAL / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 balBefore = IERC20(mockERC20).balanceOf(treasuryRecipient);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        treasuryFee = IERC20(mockERC20).balanceOf(treasuryRecipient) - balBefore;
    }

    /// @dev Stake `amount` VPFI into the lender's vault, consent, and clear the
    ///      min-history gate so the hold tier releases at settlement.
    function _stakeLenderConsent(uint256 amount) internal {
        vpfiToken.transfer(lender, amount);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), amount);
        _facet().depositVPFIToVault(amount);
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);
    }

    /// @notice Lender who absorbed the Full C* tariff but has NO separate
    ///         hold-discount consent still earns the +10% yield-fee discount --
    ///         the Full opt-in is itself the consent (section F2/F3).
    function testSettlementSweep_LenderFullNoConsent_TenPercentOff() public {
        _facet().setVPFIDiscountRate(0); // direct-reduction regime
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        // Reference: no consent, no stamp -> undiscounted 2% treasury fee.
        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertGt(baseFee, 0, "reference collected the full yield fee");

        // Treatment: Full lender, NO consent, NO stake -> d = 0 + 1000 = 1000.
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(fee, _discountedFee(baseFee, 1000), "Full-no-consent -> 10% off");
    }

    /// @notice Full lender + consenting tier-2 hold (15%) => 25% off (F2).
    function testSettlementSweep_LenderFullTier2_TwentyFivePercentOff() public {
        _facet().setVPFIDiscountRate(0);
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        _stakeLenderConsent(2_000 ether); // tier 2 (>= 1,000, < 5,000)
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(fee, _discountedFee(baseFee, 2500), "hold 15% + Full 10% -> 25% off");
    }

    /// @notice Full lender + consenting tier-4 hold (24%) => 34% off (F2).
    function testSettlementSweep_LenderFullTier4_ThirtyFourPercentOff() public {
        _facet().setVPFIDiscountRate(0);
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        _stakeLenderConsent(25_000 ether); // tier 4 (> 20,000)
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(fee, _discountedFee(baseFee, 3400), "hold 24% + Full 10% -> 34% off");
    }

    /// @notice The Full bump never breaches the uniform 50% ceiling: a tier
    ///         whose hold discount is already 50% stays at 50% after +10%
    ///         (F2 min(d_hold + d_tariff, 5000)).
    function testSettlementSweep_LenderFullClampedAtFiftyPercent() public {
        _facet().setVPFIDiscountRate(0);
        // Tier-4 hold discount = 50% (the clamp boundary).
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 5000);

        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        _stakeLenderConsent(25_000 ether); // tier 4 -> 50% hold
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(fee, _discountedFee(baseFee, 5000), "50% hold + Full -> clamped 50% off");
    }

    /// @notice A BORROWER Full stamp must never leak into the LENDER's
    ///         yield-fee discount -- only the lender's own hold + own Full count
    ///         (F2 "borrower mode never appears in lender d").
    function testSettlementSweep_BorrowerFullDoesNotDiscountLenderFee() public {
        _facet().setVPFIDiscountRate(0);
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        _stakeLenderConsent(2_000 ether); // lender tier 2 (15% hold)
        // Borrower Full, lender NOT Full -> lender d = hold 15% only, no +10%.
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.Full
        );
        assertEq(fee, _discountedFee(baseFee, 1500), "borrower Full ignored -> 15% off");
    }

    /// @notice DARK no-op proof: with no Full stamp the settlement discount is
    ///         exactly the pre-#1354 consent-gated hold discount (15% for a
    ///         tier-2 lender) -- this card changes nothing until a loan is
    ///         Full-stamped.
    function testSettlementSweep_DarkNoStampMatchesHoldOnly() public {
        _facet().setVPFIDiscountRate(0);
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        _stakeLenderConsent(2_000 ether); // tier 2, consent on, NO stamp
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(fee, _discountedFee(baseFee, 1500), "no stamp -> hold-only 15% (dark)");
    }

    /// @notice #1354 Codex r1 P2 — a Full lender with NO hold consent must
    ///         receive the +10% via the no-token-move direct-reduction path
    ///         even when the VPFI price peg IS set, and their vault must NEVER
    ///         be debited. Models the unsolicited-transfer victim: the current
    ///         `loan.lender` holds VPFI but never consented, so the
    ///         VPFI-payment path (which would debit them) must not fire.
    function testSettlementSweep_FullNoConsentPegSet_NoVaultDebit() public {
        // Peg stays SET (setUp seeds it) — VPFI-payment mode is configured.
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        // Reference: no consent, no stamp -> undiscounted 2% treasury fee.
        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        // Fund the lender's vault with VPFI but do NOT consent — a party who
        // could be VPFI-debited if the guard were missing.
        vpfiToken.transfer(lender, 5_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToVault(5_000 ether);
        vm.stopPrank();

        address lenderVault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(lender);
        uint256 vaultVpfiBefore = vpfiToken.balanceOf(lenderVault);

        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );

        // +10% delivered via direct-reduction (treasury keeps 90% of the fee)...
        assertEq(fee, _discountedFee(baseFee, 1000), "Full-no-consent peg-set -> 10% via direct-reduction");
        // ...and NO VPFI left the non-consenting lender's vault.
        assertEq(
            vpfiToken.balanceOf(lenderVault),
            vaultVpfiBefore,
            "non-consenting lender vault must not be VPFI-debited"
        );
    }

    /// @notice #1354 Codex r2 P2 — a Full lender must never be WORSE off for
    ///         having consent. With the peg SET and consent ON but too little
    ///         free VPFI to pay the discounted yield fee, the VPFI-payment
    ///         attempt fails; the paid +10% Full tariff slice must still be
    ///         delivered via the no-token-move direct-reduction fallback (the
    ///         VPFI-contingent hold slice is dropped, which is correct in
    ///         peg-set mode).
    function testSettlementSweep_FullConsentPegSet_InsufficientVpfi_StillGetsBump() public {
        // Peg stays SET (setUp seeds it).
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        // Reference: no consent, no stamp -> undiscounted 2% treasury fee.
        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        // Lender CONSENTS but holds ZERO VPFI -> VPFI-payment cannot run, and
        // the hold tier is 0 (no stake). Only the paid Full slice remains.
        vm.prank(lender);
        _facet().setVPFIDiscountConsent(true);

        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );

        // +10% Full slice delivered via direct-reduction despite consent + peg.
        assertEq(
            fee,
            _discountedFee(baseFee, 1000),
            "consenting Full lender w/o free VPFI still gets the paid +10%"
        );
    }

    /// @notice #1354 Codex r3 P2 — a consenting Full lender with unsolicited
    ///         VPFI DUST in the vault (raw balance passes but protocol-tracked
    ///         balance is 0) must NOT revert settlement on the
    ///         `prevTracked - vpfiRequired` underflow. The VPFI-payment attempt
    ///         bails on the tracked-coverage guard and the paid +10% is
    ///         delivered via the direct-reduction fallback instead.
    function testSettlementSweep_FullConsentPegSet_UntrackedDust_NoRevert() public {
        // Peg stays SET (setUp seeds it).
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);

        // Reference: no consent, no stamp -> undiscounted 2% treasury fee.
        uint256 baseFee = _openStampRepayTreasuryFee(
            1,
            LibVaipakam.FeeEntitlementMode.None,
            LibVaipakam.FeeEntitlementMode.None
        );

        // Lender CONSENTS; seed the vault with raw VPFI dust sent DIRECTLY to
        // the vault (bypassing depositVPFIToVault), so raw `balanceOf` is high
        // while `protocolTrackedVaultBalance` stays 0 — the exact underflow
        // pre-condition (`vaultBal >= vpfiRequired` but `prevTracked == 0`).
        vm.prank(lender);
        _facet().setVPFIDiscountConsent(true);
        address lenderVault = _buyerVault(lender);
        vpfiToken.transfer(lenderVault, 50_000 ether); // untracked dust >> vpfiRequired

        // Full stamp -> eligible. Must NOT revert; +10% via direct-reduction.
        uint256 fee = _openStampRepayTreasuryFee(
            2,
            LibVaipakam.FeeEntitlementMode.Full,
            LibVaipakam.FeeEntitlementMode.None
        );
        assertEq(
            fee,
            _discountedFee(baseFee, 1000),
            "untracked-dust Full lender falls back to +10%, no underflow revert"
        );
    }
}
