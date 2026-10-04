// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {AutoLifecycleFacet} from "../../src/facets/AutoLifecycleFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";

/**
 * @title  RefinanceLenderAcceptLiveForkTest
 * @notice #2355's contract half, exercised against the LIVE Base Sepolia
 *         Diamond on a fork: with the automatic-refinance switch OFF, a lender
 *         accepting a borrower's refinance-tagged request directly still
 *         completes the refinance — the old loan closes Repaid and the
 *         replacement opens Active under the same borrower.
 *
 * @dev    The unit test (`T092AutoLifecycleIntegrationTest`
 *         `test_2349_lenderAccept_killSwitchOff_refinanceCompletes`) proves the
 *         source. This proves the DEPLOYED bytecode on live state: the facets
 *         the 2026-10-03 refresh cut in, the live oracle and risk
 *         configuration, the deployment's own liquid test assets. Before
 *         #2355 the same accept reverted `AutoRefinanceDisabled`.
 *
 *         Self-contained: it opens its own loan between fresh actors — WETH
 *         lent against the deployment's `liquidToken` faucet asset — rather
 *         than borrowing a live loan, so it does not depend on what happens to
 *         be open on chain. The collateral is LIQUID so that the post-rollover
 *         LTV/HF gate runs in full. The consented-illiquid branch (#2380)
 *         skips that gate by design, and the switch this test is about is
 *         independent of it. That branch is covered by
 *         `T092AutoLifecycleIntegrationTest.test_2380_consentedIlliquidCollateral_refinanceCompletes`.
 *
 *         Nothing here touches the shared testnet. The switch is flipped, and
 *         every party funded, on the FORK only.
 *
 *         Gated by `FORK_URL_BASE_SEPOLIA`; skipped when unset, like the other
 *         suites in this directory.
 */
contract RefinanceLenderAcceptLiveForkTest is Test {
    uint256 internal constant PRINCIPAL = 0.01 ether; // WETH
    uint256 internal constant RATE_BPS = 1000;
    uint256 internal constant DURATION_DAYS = 30;

    address internal diamond;
    address internal weth;
    address internal collateral;
    bool internal forkEnabled;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        require(block.chainid == 84532, "FORK_URL_BASE_SEPOLIA is not Base Sepolia");
        string memory art =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/base-sepolia/addresses.json"));
        diamond = vm.parseJsonAddress(art, ".diamond");
        weth = vm.parseJsonAddress(art, ".weth");
        collateral = vm.parseJsonAddress(art, ".testnetMocks.liquidToken");
        forkEnabled = true;
    }

    function test_liveDiamond_lenderAcceptsTaggedRequest_withAutoRefinanceOff() public {
        if (!forkEnabled) {
            vm.skip(true);
            return;
        }
        // The scenario needs both legs LIQUID on the live Diamond; say so
        // rather than run a different scenario if that ever stops being true.
        assertEq(uint8(OracleFacet(diamond).checkLiquidity(weth)), uint8(LibVaipakam.LiquidityStatus.Liquid), "WETH liquid");
        assertEq(
            uint8(OracleFacet(diamond).checkLiquidity(collateral)),
            uint8(LibVaipakam.LiquidityStatus.Liquid),
            "collateral liquid"
        );

        (address borrower, uint256 borrowerPk) = makeAddrAndKey("forkRefiBorrower");
        (address lenderA, uint256 lenderAPk) = makeAddrAndKey("forkRefiLenderA");
        (address lenderB, uint256 lenderBPk) = makeAddrAndKey("forkRefiLenderB");
        borrowerPk; // the borrower creates; only acceptors sign

        // 1. Open the loan to be refinanced: the borrower posts a request,
        //    lender A accepts it. Collateral sized at ~3.3x the principal's
        //    value from the live oracle, well inside the init LTV / HF gates.
        uint256 collateralAmount = _collateralFor(PRINCIPAL, 30_000); // 300%
        _fundWallet(borrower, collateral, collateralAmount);
        vm.prank(borrower);
        uint256 openingRequest = OfferCreateFacet(diamond).createOffer(_request(collateralAmount, 0));
        _fundLender(lenderA, PRINCIPAL * 4);
        uint256 oldLoanId = LibAcceptTestSigner.signAndAccept(diamond, lenderA, lenderAPk, openingRequest);
        assertEq(
            uint8(LoanFacet(diamond).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan to refinance is open"
        );

        // 2. The holder posts the standard refinance request: caps, then a
        //    tagged request for the same principal with the same collateral
        //    identity (carry-over), and a standing approval for the payoff.
        vm.prank(borrower);
        AutoLifecycleFacet(diamond).setAutoRefinanceCaps(
            oldLoanId, true, uint16(RATE_BPS), uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 taggedRequest = OfferCreateFacet(diamond).createOffer(_request(collateralAmount, oldLoanId));
        _fundWallet(borrower, weth, PRINCIPAL * 2);

        // 3. The switch OFF — on the fork only. The Diamond owner holds ADMIN.
        vm.prank(OwnershipFacet(diamond).owner());
        AdminFacet(diamond).setAutoRefinanceEnabled(false);
        assertFalse(AdminFacet(diamond).getAutoRefinanceEnabled(), "switch is off");

        // 4. Lender B accepts the tagged request directly.
        _fundLender(lenderB, PRINCIPAL * 4);
        uint256 newLoanId = LibAcceptTestSigner.signAndAccept(diamond, lenderB, lenderBPk, taggedRequest);

        assertEq(
            uint8(LoanFacet(diamond).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan closed by the lender's direct accept with the switch off"
        );
        LibVaipakam.Loan memory replacement = LoanFacet(diamond).getLoanDetails(newLoanId);
        assertEq(uint8(replacement.status), uint8(LibVaipakam.LoanStatus.Active), "replacement loan open");
        assertEq(replacement.borrower, borrower, "same borrower");
        assertEq(replacement.lender, lenderB, "the accepting lender funds it");
        assertEq(replacement.principal, PRINCIPAL, "same principal");
        assertEq(replacement.collateralAmount, collateralAmount, "collateral carried over");
    }

    function _request(uint256 collateralAmount, uint256 refinanceTarget)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: weth,
            amount: PRINCIPAL,
            interestRateBps: RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: collateralAmount,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: weth,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: RATE_BPS,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            // Refinance-tagged requests are all-or-nothing.
            fillMode: LibVaipakam.FillMode.Aon,
            refinanceTargetLoanId: refinanceTarget,
            useFullTermInterest: false
        });
    }

    /// @dev Collateral amount worth `ratioBps` of `principal`, from the live
    ///      oracle prices of both legs.
    function _collateralFor(uint256 principal, uint256 ratioBps) internal view returns (uint256) {
        (uint256 pPrice, uint8 pDec) = OracleFacet(diamond).getAssetPrice(weth);
        (uint256 cPrice, uint8 cDec) = OracleFacet(diamond).getAssetPrice(collateral);
        uint256 usd = principal * pPrice / (10 ** pDec); // 18-dec token amounts
        return usd * ratioBps * (10 ** cDec) / cPrice / 10_000;
    }

    function _fundWallet(address who, address token, uint256 amount) internal {
        deal(token, who, amount);
        vm.prank(who);
        IERC20(token).approve(diamond, type(uint256).max);
    }

    /// @dev Half to the wallet with a standing approval, half into the
    ///      lender's vault, recorded as a deposit the way the Diamond records
    ///      one, so the vault's tracked balance matches its holding.
    function _fundLender(address who, uint256 total) internal {
        uint256 inVault = total / 2;
        _fundWallet(who, weth, total);
        address vault = VaultFactoryFacet(diamond).getOrCreateUserVault(who);
        vm.prank(who);
        IERC20(weth).transfer(vault, inVault);
        vm.prank(diamond);
        VaultFactoryFacet(diamond).recordVaultDepositERC20(who, weth, inVault);
    }
}
