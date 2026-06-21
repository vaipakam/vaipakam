// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title  Vpfi592LenderProceedsTest
 * @notice #592 — verifies that a VPFI-principal terminal close RESERVES the
 *         lender proceeds against the VPFI unstake path
 *         (`VPFIDiscountFacet.withdrawVPFIFromVault`) the instant they land in
 *         the stored lender's vault, and RELEASES them exactly when the current
 *         lender-position holder claims. Uses the `repayLoan` terminal as the
 *         representative path; every other gated terminal (default / preclose /
 *         liquidation) wires the IDENTICAL `encumberLenderProceeds` gate, and
 *         the release point is shared + already covered by the #585 suite.
 * @dev    Seeds the loan directly via `TestMutatorFacet.scaffoldActiveLoan`
 *         (then designates VPFI) to bypass the offer-create VPFI fee/discount
 *         machinery — same pattern as the #585 `InternalMatchExecution` tests.
 */
contract Vpfi592LenderProceedsTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant LENDER_TOKEN_ID = 7777;
    uint256 internal constant PRINCIPAL = 1000;

    function setUp() public {
        setupHelper();
    }

    /// @dev Seed an Active, immediately-repayable ERC-20 loan: 0 interest so
    ///      `lenderDue == principal`, start = now + 30d duration so we're well
    ///      inside the grace window.
    function _seedRepayableVpfiLoan(address lender_, address borrower_) internal {
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = mockERC20; // designated VPFI by the test
        l.principal = PRINCIPAL;
        l.collateralAsset = mockCollateralERC20;
        l.collateralAmount = 1500;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = 8888;
        l.liquidationLtvBpsAtInit = 8_500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);
    }

    /// @dev Point `ownerOf(lenderTokenId)` at `owner_` and no-op the void NFT
    ///      cross-facet calls for the scaffolded (no real NFT) loan.
    function _mockLenderNft(address owner_) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, LENDER_TOKEN_ID),
            abi.encode(owner_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            ""
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            ""
        );
        // #594 — the terminal close-out paths (repayLoan / triggerDefault) now
        // run the both-side consolidation hook, which calls
        // `ownerOf(borrowerTokenId)`. These scaffolds never mint the borrower
        // position NFT (id 8888), so mock it to the stored `borrower` → the hook
        // sees current == stored and is a no-op (AlreadyConsolidated). Without
        // this the hook reverts `ERC721NonexistentToken(8888)`. Every test seeds
        // `l.borrower = borrower` + `l.borrowerTokenId = 8888` and calls this
        // helper, so it covers all of them.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, uint256(8888)),
            abi.encode(borrower)
        );
    }

    function _encumbered(address who) internal view returns (uint256) {
        return TestMutatorFacet(address(diamond)).getEncumberedRaw(who, mockERC20, 0);
    }

    function test_592_repayLoan_reservesVpfiProceedsThenReleasesOnClaim() public {
        address storedLender = makeAddr("storedVpfiLender");

        // Designate mockERC20 as the VPFI token (post-seed, so the offer-path
        // VPFI machinery never runs).
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);

        _seedRepayableVpfiLoan(storedLender, borrower);
        // During repay the stored lender owns the position (≠ borrower → passes
        // the lender-self-repay guard).
        _mockLenderNft(storedLender);

        // Borrower funds + approves the full repay (0 interest ⇒ exactly the
        // principal).
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), PRINCIPAL);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(LOAN);

        // The proceeds landed in the stored lender's vault AND were reserved
        // against the unstake path.
        assertEq(
            _encumbered(storedLender),
            PRINCIPAL,
            "VPFI lender proceeds reserved against the unstake path"
        );

        // The stored lender (no longer the holder) cannot front-run-unstake the
        // reserved proceeds: the unstake free-balance guard sees them as
        // encumbered.
        // The free balance is exactly 0 (all of it reserved), so any non-zero
        // unstake reverts — the proceeds cannot be front-run out.
        vm.prank(storedLender);
        vm.expectRevert();
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(PRINCIPAL);

        // The current holder claims → reservation released atomically, proceeds
        // paid out to the holder.
        address newHolder = makeAddr("newVpfiLenderHolder");
        _mockLenderNft(newHolder);
        uint256 balBefore = IERC20(mockERC20).balanceOf(newHolder);

        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);

        assertEq(
            IERC20(mockERC20).balanceOf(newHolder) - balBefore,
            PRINCIPAL,
            "current holder claims the VPFI proceeds"
        );
        assertEq(_encumbered(storedLender), 0, "reservation released on claim");
        // (The loan stays Repaid until the borrower also claims their
        // collateral; the lender-side reserve/release is what this test
        // exercises.)
    }

    /// @dev #592 ReservationV2 §4.1 (G1) — claim-asset keying: an in-kind /
    ///      illiquid default hands the COLLATERAL to the lender (not the
    ///      principal). When that collateral is VPFI, it must be reserved
    ///      under the COLLATERAL asset and released on `claim.asset` at claim.
    function test_592_inKindDefault_reservesVpfiCollateralThenReleasesOnClaim()
        public
    {
        address storedLender = makeAddr("storedInKindLender");
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);

        // Non-VPFI principal, VPFI collateral, both-consent (illiquid → in-kind
        // collateral-transfer default branch).
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = storedLender;
        l.borrower = borrower;
        l.principalAsset = mockCollateralERC20; // non-VPFI
        l.principal = 500;
        l.collateralAsset = mockERC20; // VPFI collateral
        l.collateralAmount = 1000;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = 8888;
        l.liquidationLtvBpsAtInit = 8_500;
        l.riskAndTermsConsentFromBoth = true;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);
        _mockLenderNft(storedLender);

        // Fund the borrower vault with the VPFI collateral so the in-kind
        // collateral withdraw to the lender vault succeeds.
        address bVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        ERC20Mock(mockERC20).mint(bVault, 1000);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower, mockERC20, 1000
        );

        // Both legs illiquid: collateral-illiquid → in-kind branch; principal-
        // illiquid → the KYC value path is skipped (no price mock needed).
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
        mockOracleLiquidity(
            mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid
        );

        // Past the grace boundary.
        vm.warp(block.timestamp + 31 days + 30 days);

        DefaultedFacet(address(diamond)).triggerDefault(LOAN, defaultAdapterCalls());

        // The VPFI collateral handed to the stored lender's vault is reserved
        // under the COLLATERAL asset.
        assertEq(
            _encumbered(storedLender),
            1000,
            "VPFI collateral reserved on in-kind default (claim-asset keyed)"
        );

        vm.prank(storedLender);
        vm.expectRevert();
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(1000);

        address newHolder = makeAddr("newInKindHolder");
        _mockLenderNft(newHolder);
        uint256 balBefore = IERC20(mockERC20).balanceOf(newHolder);
        vm.prank(newHolder);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);

        assertEq(
            IERC20(mockERC20).balanceOf(newHolder) - balBefore,
            1000,
            "current holder claims the VPFI collateral"
        );
        assertEq(
            _encumbered(storedLender),
            0,
            "reservation released on claim (released on claim.asset)"
        );
    }

    /// @dev A non-VPFI principal asset carries NO reservation (no user-facing
    ///      tracked-withdraw door to protect). Same flow with mockCollateralERC20
    ///      as the principal asset while VPFI = mockERC20.
    function test_592_repayLoan_nonVpfiPrincipal_carriesNoReservation() public {
        address storedLender = makeAddr("storedNonVpfiLender");
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);

        // Seed with a non-VPFI principal (mockCollateralERC20) + VPFI collateral.
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = storedLender;
        l.borrower = borrower;
        l.principalAsset = mockCollateralERC20; // NOT the VPFI token
        l.principal = PRINCIPAL;
        l.collateralAsset = mockERC20;
        l.collateralAmount = 1500;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = 8888;
        l.liquidationLtvBpsAtInit = 8_500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);
        _mockLenderNft(storedLender);

        ERC20Mock(mockCollateralERC20).mint(borrower, PRINCIPAL);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), PRINCIPAL);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(LOAN);

        // No reservation under either asset for the stored lender.
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(
                storedLender, mockCollateralERC20, 0
            ),
            0,
            "non-VPFI principal carries no reservation"
        );
    }

    /// @dev #661 — a LIQUID default swaps the collateral, pays the lender, and
    ///      returns the VPFI surplus to the borrower's vault. Like the lender
    ///      proceeds it must be reserved against the unstake path until the
    ///      current borrower-position holder claims it (else the stored borrower
    ///      drains it after a position transfer). Mirror of the #592 lender test.
    function test_661_liquidDefault_reservesVpfiBorrowerSurplusThenReleasesOnClaim()
        public
    {
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);

        // VPFI principal; liquid non-VPFI collateral worth more than the debt →
        // the liquidation swap surplus returns to the borrower in VPFI.
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = makeAddr("liqSurplusLender");
        l.borrower = borrower;
        l.principalAsset = mockERC20; // VPFI
        l.principal = 500 ether;
        l.collateralAsset = mockCollateralERC20;
        l.collateralAmount = 1000 ether;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = 8888;
        l.liquidationLtvBpsAtInit = 8_500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);
        _mockLenderNft(l.lender); // also mocks ownerOf(8888) == borrower

        // Fund the borrower vault with the collateral so the swap can withdraw
        // it; fund the diamond with both assets to back the mocked swap flow.
        address bVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        ERC20Mock(mockCollateralERC20).mint(bVault, 1000 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower, mockCollateralERC20, 1000 ether
        );
        ERC20Mock(mockERC20).mint(address(diamond), 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(address(diamond), 100000 ether);

        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOracleLiquidity(
            mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid
        );
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        mockOraclePrice(mockERC20, 1e8, 8);

        vm.warp(block.timestamp + 31 days + 30 days);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, defaultAdapterCalls());

        uint256 reserved = _encumbered(borrower);
        assertGt(reserved, 0, "VPFI borrower surplus reserved against unstake");

        // The stored borrower cannot front-run-unstake the reserved surplus.
        vm.prank(borrower);
        vm.expectRevert();
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(reserved);

        // The current borrower-position holder (== `borrower` per the mock)
        // claims → reservation released atomically with the surplus payout.
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        assertEq(
            _encumbered(borrower),
            0,
            "borrower-surplus reservation released on claimAsBorrower"
        );
    }
}
