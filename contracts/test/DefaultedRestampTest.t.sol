// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {defaultQuote} from "./helpers/ForcedSaleQuote.sol";

/**
 * @title  DefaultedRestampTest
 * @notice #1566 S2c (finding S1-11 of the slices 2-3 review): a time-based
 *         default that moves VPFI collateral OUT of the borrower's vault
 *         re-stamps the borrower's fee tier at the post-withdrawal balance, on
 *         BOTH ERC-20 collateral routes. Before S2c neither route restamped, so
 *         the borrower kept tier and staking credit on VPFI that had already
 *         left the vault until some unrelated later mutation.
 *
 *         Cells (the slices 2-3 brief's numbering):
 *         - F18:  liquid collateral, the swap succeeds. Stamp == tracked.
 *                 Kills: the restamp missing altogether.
 *         - F18b: illiquid collateral with both parties' consent, the in-kind
 *                 transfer to the lender. Stamp == tracked. Kills: a restamp
 *                 placed only on the swap route. (The brief names the
 *                 LTV-collapsed variant; the consented-illiquid default takes
 *                 the very same in-kind branch and needs no price fixture.)
 *         Both also pin the entry: one call of the broadcast-FREE
 *         `ConsolidationFacet.restampUserVpfiLocalInternal(borrower)`.
 *
 * @dev    Straddle. Each cell first proves its fixture is live: the borrower's
 *         stamp starts at the PRE-default balance (collateral plus own VPFI),
 *         which is exactly the value a missing restamp leaves behind. The
 *         terminal tier sync cannot mask a missing restamp: both positions
 *         stay with their stored parties, so neither side's exclusion changes
 *         and that sync restamps nobody. The borrower holds VPFI of their own
 *         beside the collateral, so the correct post-default stamp is a
 *         non-zero balance rather than a floor at zero.
 *
 *         Real position NFTs (minted raw, no `ownerOf` mock): the default
 *         reads the lender-position owner internally, which a mocked external
 *         `ownerOf` cannot reach. Nothing here mocks a vault withdrawal; the
 *         collateral lien is installed as loan initiation would.
 */
contract DefaultedRestampTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant LENDER_TOKEN_ID = 7777;
    uint256 internal constant BORROWER_TOKEN_ID = 8888;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;
    /// @dev VPFI the borrower owns outright, beside the collateral.
    uint256 internal constant OWN_VPFI = 300 ether;

    /// @dev `mockERC20` plays VPFI and is the COLLATERAL; `mockCollateralERC20`
    ///      is the (non-VPFI) principal.
    address internal vpfi;
    address internal bVault;

    function setUp() public {
        setupHelper();
        vpfi = mockERC20;
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(vpfi);
        bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
    }

    // -- Helpers ------------------------------------------------------------

    /// @dev An Active ERC-20 loan with VPFI collateral, both position NFTs
    ///      held by the stored parties, the collateral liened in the
    ///      borrower's vault next to `OWN_VPFI` of their own, then warped past
    ///      the grace period (a 30-day loan carries a 3-day grace).
    ///      `inKind` = both legs illiquid with both parties' consent (the
    ///      in-kind branch); otherwise both legs liquid at the same price (the
    ///      swap branch, LTV well under the collapse threshold).
    function _scaffold(bool inKind) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(lender, LENDER_TOKEN_ID);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrower, BORROWER_TOKEN_ID);
        vm.startPrank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            LENDER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(
            BORROWER_TOKEN_ID, LOAN, LibVaipakam.LoanPositionStatus.LoanInitiated
        );
        vm.stopPrank();

        LibVaipakam.LiquidityStatus liq = inKind
            ? LibVaipakam.LiquidityStatus.Illiquid
            : LibVaipakam.LiquidityStatus.Liquid;

        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockCollateralERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = vpfi;
        l.collateralAmount = COLLATERAL;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.interestRateBps = 0;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.lenderTokenId = LENDER_TOKEN_ID;
        l.borrowerTokenId = BORROWER_TOKEN_ID;
        l.liquidationLtvBpsAtInit = 8_500;
        l.riskAndTermsConsentFromBoth = inKind;
        l.principalLiquidity = liq;
        l.collateralLiquidity = liq;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        ERC20Mock(vpfi).mint(bVault, COLLATERAL + OWN_VPFI);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower, vpfi, COLLATERAL + OWN_VPFI
        );
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrower, vpfi, 0, COLLATERAL, LibVaipakam.AssetType.ERC20
        );

        mockOracleLiquidity(vpfi, liq);
        mockOracleLiquidity(mockCollateralERC20, liq);
        if (!inKind) {
            mockOraclePrice(vpfi, 1e8, 8);
            mockOraclePrice(mockCollateralERC20, 1e8, 8);
        }

        vm.warp(block.timestamp + 61 days);
    }

    function _tracked() internal view returns (uint256 bal) {
        (, bal, ) = VPFIDiscountFacet(address(diamond)).getTrackedVPFIDiscountTier(borrower);
    }

    function _dayMinAndClose() internal view returns (uint256 dayMin, uint256 dayClose) {
        (, , uint120 close_, uint120 min_) =
            TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(borrower);
        return (uint256(min_), uint256(close_));
    }

    /// @dev Fixture liveness: stamp the borrower at the pre-default balance on
    ///      the default's own day (the first write of that day sets both the
    ///      day minimum and the close), and prove the stamp reads it.
    function _stampAtPreDefaultBalance() internal {
        vm.prank(address(diamond));
        ConsolidationFacet(address(diamond)).restampUserVpfiLocalInternal(borrower);
        assertEq(_tracked(), COLLATERAL + OWN_VPFI, "fixture: tracked = collateral + own VPFI");
        (uint256 dayMin, uint256 dayClose) = _dayMinAndClose();
        assertEq(dayClose, COLLATERAL + OWN_VPFI, "fixture: stamp starts at the pre-default balance");
        assertEq(dayMin, COLLATERAL + OWN_VPFI, "fixture: day minimum starts there too");
    }

    /// @dev Trigger the default from an unrelated keeper, expecting exactly the
    ///      broadcast-free borrower restamp (the ONLY caller of that selector on
    ///      this path; the fixture's own stamp above runs before the
    ///      expectation is armed).
    function _triggerDefault() internal {
        uint256 sellQuote = defaultQuote(address(diamond), LOAN);
        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(
                ConsolidationFacet.restampUserVpfiLocalInternal.selector, borrower
            ),
            1
        );
        vm.prank(makeAddr("defaultKeeper"));
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sellQuote, defaultAdapterCalls());
    }

    /// @dev The property, at the straddle: the stamp left the pre-default
    ///      balance and equals what the vault now tracks: own VPFI plus
    ///      `kept`, the collateral the default did not take. Since #2796 a
    ///      covered swap sells only what the debt needs, so the unsold
    ///      collateral stays in the vault (under the loan's lien, for the
    ///      borrower's claim); the in-kind route still takes all of it.
    function _assertStampEqualsTracked(uint256 kept) internal view {
        assertEq(
            IERC20(vpfi).balanceOf(bVault),
            OWN_VPFI + kept,
            "the VPFI collateral the default took left the borrower's vault"
        );
        assertEq(_tracked(), OWN_VPFI + kept, "tracked = own VPFI + unsold collateral after the default");
        (uint256 dayMin, uint256 dayClose) = _dayMinAndClose();
        assertEq(dayClose, _tracked(), "stamp == tracked after the default");
        assertEq(dayClose, OWN_VPFI + kept, "stamp left the pre-default balance");
        assertEq(dayMin, OWN_VPFI + kept, "the day minimum saw the collateral leave");
    }

    // -- F18: the swap route ------------------------------------------------

    function test_F18_DefaultSwapSuccess_VpfiCollateral_StampEqualsTracked() public {
        _scaffold(false);
        _stampAtPreDefaultBalance();

        _triggerDefault();

        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).status),
            uint256(LibVaipakam.LoanStatus.Defaulted),
            "fixture: the default completed"
        );
        (address claimAsset, uint256 claimAmount, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertEq(claimAsset, mockCollateralERC20, "fixture: swap route (lender claim in the principal asset)");
        assertGt(claimAmount, 0, "fixture: the swap paid the lender");
        (address keptAsset, uint256 kept, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(keptAsset, vpfi, "fixture: the borrower claim is the unsold VPFI collateral");
        assertGt(kept, 0, "fixture: a covered sale leaves collateral unsold");
        assertLt(kept, COLLATERAL, "fixture: the sale took some collateral");

        _assertStampEqualsTracked(kept);
    }

    // -- F18b: the in-kind route --------------------------------------------

    function test_F18b_DefaultInKind_VpfiCollateral_StampEqualsTracked() public {
        _scaffold(true);
        _stampAtPreDefaultBalance();

        _triggerDefault();

        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).status),
            uint256(LibVaipakam.LoanStatus.Defaulted),
            "fixture: the default completed"
        );
        (address claimAsset, uint256 claimAmount, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertEq(claimAsset, vpfi, "fixture: in-kind route (lender claim in the VPFI collateral)");
        assertEq(claimAmount, COLLATERAL, "fixture: the whole collateral went to the lender");

        _assertStampEqualsTracked(0);
    }
}
