// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../../src/libraries/LibRiskAccess.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {AutoLifecycleFacet} from "../../src/facets/AutoLifecycleFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";
import {RiskAccessFacet} from "../../src/facets/RiskAccessFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";

/**
 * @title  RefinanceIlliquidLiveForkTest
 * @notice #2380, against the LIVE Base Sepolia Diamond on a fork: a loan backed
 *         by the deployment's ILLIQUID faucet asset is refinanced by a new
 *         lender's direct accept of the borrower's tagged request, with both
 *         parties' illiquid consent — the shape of live loan 22, which found
 *         the defect.
 *
 * @dev    The refinance facet's routed implementation is replaced, on the fork
 *         only, with THIS tree's `RefinanceFacet` runtime code (it carries no
 *         immutables). So the test exercises the source under review against
 *         live state — the live oracle's liquidity verdict, the live risk-access
 *         configuration, every other facet as deployed — and keeps meaning the
 *         same thing once a refresh has deployed it.
 *
 *         Every actor raises its vault to `IlliquidCustom` and consents to the
 *         exact pair, then the fork warps past the live opt-up cooldown — the
 *         same steps a real user takes. Nothing touches the shared testnet.
 *
 *         Gated by `FORK_URL_BASE_SEPOLIA`; skipped when unset.
 */
contract RefinanceIlliquidLiveForkTest is Test {
    uint256 internal constant PRINCIPAL = 0.005 ether; // WETH, as loan 22
    uint256 internal constant COLLATERAL = 100 ether; // illiquid faucet asset, as loan 22
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
        collateral = vm.parseJsonAddress(art, ".testnetMocks.illiquidToken");
        forkEnabled = true;
    }

    function test_liveDiamond_consentedIlliquidRefinance_completes() public {
        if (!forkEnabled) {
            vm.skip(true);
            return;
        }
        assertEq(
            uint8(OracleFacet(diamond).checkLiquidity(collateral)),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "the faucet's illiquid asset reads Illiquid on the live Diamond"
        );
        _installSourceRefinanceFacet();

        address borrower = makeAddr("forkIlliquidBorrower");
        (address lenderA, uint256 lenderAPk) = makeAddrAndKey("forkIlliquidLenderA");
        (address lenderB, uint256 lenderBPk) = makeAddrAndKey("forkIlliquidLenderB");
        _armIlliquid(borrower);
        _armIlliquid(lenderA);
        _armIlliquid(lenderB);
        vm.warp(block.timestamp + RiskAccessFacet(diamond).getRiskAccessUnlockCooldown() + 1);

        // 1. The loan to refinance: illiquid collateral, both parties consenting.
        _fundWallet(borrower, collateral, COLLATERAL);
        vm.prank(borrower);
        uint256 openingRequest = OfferCreateFacet(diamond).createOffer(_request(0));
        _fundLender(lenderA, PRINCIPAL * 4);
        uint256 oldLoanId = LibAcceptTestSigner.signAndAccept(diamond, lenderA, lenderAPk, openingRequest);
        LibVaipakam.Loan memory oldLoan = LoanFacet(diamond).getLoanDetails(oldLoanId);
        assertEq(uint8(oldLoan.status), uint8(LibVaipakam.LoanStatus.Active), "loan to refinance is open");
        assertEq(
            uint8(oldLoan.collateralLiquidity),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "the loan to refinance is backed by illiquid collateral"
        );

        // 2. The holder's refinance request: caps, a tagged carry-over request,
        //    a standing approval for the payoff.
        vm.prank(borrower);
        AutoLifecycleFacet(diamond).setAutoRefinanceCaps(
            oldLoanId, true, uint16(RATE_BPS), uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 taggedRequest = OfferCreateFacet(diamond).createOffer(_request(oldLoanId));
        _fundWallet(borrower, weth, PRINCIPAL * 2);

        // 3. A new lender accepts it directly.
        _fundLender(lenderB, PRINCIPAL * 4);
        uint256 newLoanId = LibAcceptTestSigner.signAndAccept(diamond, lenderB, lenderBPk, taggedRequest);

        assertEq(
            uint8(LoanFacet(diamond).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan closed by the refinance"
        );
        LibVaipakam.Loan memory replacement = LoanFacet(diamond).getLoanDetails(newLoanId);
        assertEq(uint8(replacement.status), uint8(LibVaipakam.LoanStatus.Active), "replacement loan open");
        assertEq(
            uint8(replacement.collateralLiquidity),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "replacement admitted on illiquid collateral"
        );
        assertTrue(replacement.riskAndTermsConsentFromBoth, "replacement carries both parties' consent");
        assertEq(replacement.borrower, borrower, "same borrower");
        assertEq(replacement.lender, lenderB, "the accepting lender funds it");
        assertEq(replacement.collateralAmount, COLLATERAL, "collateral carried over");
    }

    /// @dev Route the refinance facet's live implementation address to this
    ///      tree's bytecode, on the fork only.
    function _installSourceRefinanceFacet() internal {
        address live = IDiamondLoupe(diamond).facetAddress(RefinanceFacet.refinanceLoanFromAccept.selector);
        require(live != address(0), "refinanceLoanFromAccept is not routed on the live Diamond");
        vm.etch(live, address(new RefinanceFacet()).code);
    }

    function _armIlliquid(address who) internal {
        LibRiskAccess.PairId memory pair = LibRiskAccess.PairId({
            lendAsset: weth,
            lendType: LibVaipakam.AssetType.ERC20,
            lendTokenId: 0,
            collAsset: collateral,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: weth
        });
        vm.prank(who);
        RiskAccessFacet(diamond).setVaultRiskTier(uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom));
        vm.prank(who);
        RiskAccessFacet(diamond).setIlliquidPairConsent(pair, true);
    }

    function _request(uint256 refinanceTarget) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: weth,
            amount: PRINCIPAL,
            interestRateBps: RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: COLLATERAL,
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
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            // Refinance-tagged requests are all-or-nothing.
            fillMode: LibVaipakam.FillMode.Aon,
            refinanceTargetLoanId: refinanceTarget,
            useFullTermInterest: false
        });
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
