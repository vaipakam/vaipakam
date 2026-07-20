// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibFeeEntitlement} from "../src/libraries/LibFeeEntitlement.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";

/**
 * @title  FeeEntitlementFacetTest
 * @notice #1347 (M2 PR-5a/5b) — end-to-end coverage of the per-party Full VPFI
 *         fee-entitlement tariff: pricing (`quoteCStar`), the master kill
 *         switch, per-party resolution (revert / downgrade / charge), double
 *         absorption, the matcher-fill non-Full guard, and the notional-`C*`
 *         stamp semantics.
 * @dev    Extends {SetupTest} (the full 67-facet diamond, so
 *         `FeeEntitlementFacet` + `ConfigFacet` + `ProfileFacet` are all
 *         routed), then overlays the VPFI token + reserve the tariff needs to
 *         pull and back the recycle credit. `mockERC20` is the liquid,
 *         oracle-priced lending asset ($1/8-dec from `SetupTest`), so
 *         `computeCStar` can price the list LIF to numeraire.
 */
contract FeeEntitlementFacetTest is SetupTest {
    VPFIToken internal vpfiToken;

    address internal treasuryRecipient;

    // Diamond VPFI reserve so `LibVpfiRecycle.credit`'s backing invariant
    // (Diamond balance ≥ bucket + amount) is always satisfied.
    uint256 internal constant DIAMOND_VPFI_RESERVE = 200_000 ether;
    // Enough VPFI staked in each party's vault to cover any `C*` this suite
    // prices (a 10k-principal 30-day loan is ~8 VPFI at K=5).
    uint256 internal constant PARTY_VPFI_STAKE = 5_000 ether;

    uint256 internal constant PRINCIPAL = 10_000 ether;

    function setUp() public {
        setupHelper();

        treasuryRecipient = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        // Deploy VPFI behind a UUPS proxy, register it, mark this chain
        // canonical, and seed the Diamond reserve + party wallets.
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        vpfiToken.transfer(address(diamond), DIAMOND_VPFI_RESERVE);
        vpfiToken.transfer(borrower, PARTY_VPFI_STAKE);
        vpfiToken.transfer(lender, PARTY_VPFI_STAKE);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _feFacet() internal view returns (FeeEntitlementFacet) {
        return FeeEntitlementFacet(address(diamond));
    }

    function _config() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    /// @dev Stake `amount` VPFI from `who`'s wallet into their vault via the
    ///      sanctioned deposit path (populates the tracked balance the tariff
    ///      pull reads).
    function _stakeVpfi(address who, uint256 amount) internal {
        vm.startPrank(who);
        vpfiToken.approve(address(diamond), amount);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amount);
        vm.stopPrank();
    }

    function _createLenderErc20Offer() internal returns (uint256) {
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: PRINCIPAL * 2,
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
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: PRINCIPAL * 2,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _cStar() internal view returns (uint256 c) {
        (c, ) = _feFacet().quoteCStar(mockERC20, PRINCIPAL, 30);
    }

    function _vault(address who) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(who);
    }

    // ─── quoteCStar ───────────────────────────────────────────────────────────

    function testQuoteCStar_PricesLiquidAsset() public view {
        (uint256 c, bool ok) = _feFacet().quoteCStar(mockERC20, PRINCIPAL, 30);
        assertTrue(ok, "liquid, oracle-priced LIF resolves numeraire");
        assertGt(c, 0, "non-zero C* for a priced 30-day loan");
    }

    function testQuoteCStar_UnpricedAssetReturnsZero() public {
        // A fresh ERC-20 never registered with the oracle cannot be priced, so
        // the list LIF has no numeraire and C* is undefined (0).
        address unpriced = address(new ERC20Mock("Unpriced", "UNP", 18));
        (uint256 c, bool ok) = _feFacet().quoteCStar(unpriced, PRINCIPAL, 30);
        assertFalse(ok, "unpriced asset => numeraireOk false");
        assertEq(c, 0, "unpriced => C* 0");
    }

    // ─── dark default (kill switch off) ────────────────────────────────────────

    function testDark_NonFullAccept_NoTariffNoStamp() public {
        uint256 offerId = _createLenderErc20Offer();
        uint256 bucketBefore = _config().getRecycleBucket();

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // While dark the whole tariff call is skipped: no fee-entitlement record
        // is written and the recycle bucket is untouched.
        LibVaipakam.FeeEntitlement memory fe = _feFacet().getFeeEntitlement(loanId);
        assertEq(uint8(fe.borrowerMode), uint8(LibVaipakam.FeeEntitlementMode.None));
        assertEq(uint8(fe.lenderMode), uint8(LibVaipakam.FeeEntitlementMode.None));
        assertEq(fe.cStarOpen, 0, "no stamp while dark");
        assertEq(_config().getRecycleBucket(), bucketBefore, "bucket untouched");
    }

    function testDark_FullOptIn_RevertsClosed() public {
        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();

        // Acceptor opts into Full with no downgrade permission while the kill
        // switch is off => the accept reverts closed (fail-safe): never silently
        // continues as HoldOnly.
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildFullTerms(
            address(diamond), borrower, offerId, true, c * 2, false
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.prank(borrower);
        vm.expectRevert(LibFeeEntitlement.FeeEntitlementDisabled.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function testDark_FullOptIn_DowngradeSucceeds() public {
        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();
        uint256 vaultVpfiBefore = vpfiToken.balanceOf(_vault(borrower));

        // With downgrade permitted, a dark Full opt-in silently becomes non-Full
        // and the accept goes through without pulling any VPFI.
        LibAcceptTestSigner.signAndAcceptFull(
            address(diamond), borrower, borrowerPk, offerId, c * 2, /*allowDowngrade=*/ true
        );
        assertEq(
            vpfiToken.balanceOf(_vault(borrower)),
            vaultVpfiBefore,
            "no VPFI pulled on a dark downgrade"
        );
    }

    // ─── enabled: happy path + double absorption ───────────────────────────────

    function testEnabled_BorrowerFull_ChargesCStarAndStamps() public {
        _config().setFeeEntitlementEnabled(true);
        _stakeVpfi(borrower, PARTY_VPFI_STAKE);

        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();
        assertGt(c, 0);

        address bVault = _vault(borrower);
        uint256 vaultBefore = vpfiToken.balanceOf(bVault);
        uint256 bucketBefore = _config().getRecycleBucket();

        uint256 loanId = LibAcceptTestSigner.signAndAcceptFull(
            address(diamond), borrower, borrowerPk, offerId, c, /*allowDowngrade=*/ false
        );

        assertEq(
            vaultBefore - vpfiToken.balanceOf(bVault),
            c,
            "borrower vault debited exactly C* VPFI"
        );
        assertEq(
            _config().getRecycleBucket() - bucketBefore,
            c,
            "recycle bucket credited exactly C*"
        );
        LibVaipakam.FeeEntitlement memory fe = _feFacet().getFeeEntitlement(loanId);
        assertEq(uint8(fe.borrowerMode), uint8(LibVaipakam.FeeEntitlementMode.Full));
        assertEq(fe.borrowerTariffPaid, c, "borrower tariff paid = C*");
        assertEq(fe.cStarOpen, c, "notional C* stamped");
        // Lender did not opt in => non-Full, no lender tariff.
        assertEq(fe.lenderTariffPaid, 0, "lender paid no tariff");
    }

    function testEnabled_BothFull_DoubleAbsorption() public {
        _config().setFeeEntitlementEnabled(true);
        _stakeVpfi(borrower, PARTY_VPFI_STAKE);
        _stakeVpfi(lender, PARTY_VPFI_STAKE);

        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();

        // Creator (= lender on a Lender offer) authorizes their own Full.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setOfferCreatorFullTariff(
            offerId, true, c, /*allowDowngrade=*/ false
        );

        address bVault = _vault(borrower);
        address lVault = _vault(lender);
        uint256 bBefore = vpfiToken.balanceOf(bVault);
        uint256 lBefore = vpfiToken.balanceOf(lVault);
        uint256 bucketBefore = _config().getRecycleBucket();

        uint256 loanId = LibAcceptTestSigner.signAndAcceptFull(
            address(diamond), borrower, borrowerPk, offerId, c, false
        );

        assertEq(bBefore - vpfiToken.balanceOf(bVault), c, "borrower C*");
        assertEq(lBefore - vpfiToken.balanceOf(lVault), c, "lender C*");
        assertEq(
            _config().getRecycleBucket() - bucketBefore,
            c * 2,
            "double absorption => 2 x C* to the bucket"
        );
        LibVaipakam.FeeEntitlement memory fe = _feFacet().getFeeEntitlement(loanId);
        assertEq(uint8(fe.borrowerMode), uint8(LibVaipakam.FeeEntitlementMode.Full));
        assertEq(uint8(fe.lenderMode), uint8(LibVaipakam.FeeEntitlementMode.Full));
    }

    // ─── enabled: maxCStar bound + downgrade ───────────────────────────────────

    function testEnabled_MaxCStarBelowQuote_Reverts() public {
        _config().setFeeEntitlementEnabled(true);
        _stakeVpfi(borrower, PARTY_VPFI_STAKE);

        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();

        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildFullTerms(
            address(diamond), borrower, offerId, true, c - 1, /*allowDowngrade=*/ false
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibFeeEntitlement.FeeEntitlementTariffAboveAuth.selector, c, c - 1
            )
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function testEnabled_MaxCStarBelowQuote_Downgrades() public {
        _config().setFeeEntitlementEnabled(true);
        _stakeVpfi(borrower, PARTY_VPFI_STAKE);

        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();
        address bVault = _vault(borrower);
        uint256 vaultBefore = vpfiToken.balanceOf(bVault);

        uint256 loanId = LibAcceptTestSigner.signAndAcceptFull(
            address(diamond), borrower, borrowerPk, offerId, c - 1, /*allowDowngrade=*/ true
        );
        assertEq(vpfiToken.balanceOf(bVault), vaultBefore, "no C* pulled on downgrade");
        LibVaipakam.FeeEntitlement memory fe = _feFacet().getFeeEntitlement(loanId);
        assertTrue(
            fe.borrowerMode != LibVaipakam.FeeEntitlementMode.Full,
            "downgraded off Full"
        );
        assertEq(fe.borrowerTariffPaid, 0, "no tariff on downgrade");
        assertEq(fe.cStarOpen, c, "notional C* still stamped on a downgraded loan");
    }

    function testEnabled_VaultShort_NoDowngrade_Reverts() public {
        _config().setFeeEntitlementEnabled(true);
        // Borrower stakes NOTHING → vault short of C*.
        uint256 offerId = _createLenderErc20Offer();
        uint256 c = _cStar();

        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildFullTerms(
            address(diamond), borrower, offerId, true, c, /*allowDowngrade=*/ false
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibFeeEntitlement.FeeEntitlementFullOptInFailed.selector, borrower
            )
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // ─── lender-Full authorization is creator-signed, never acceptor-forgeable ──

    function testCreatorFullTariff_MaxCStarMandatory() public {
        uint256 offerId = _createLenderErc20Offer();
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.FullTariffMaxCStarRequired.selector);
        ProfileFacet(address(diamond)).setOfferCreatorFullTariff(
            offerId, /*full=*/ true, /*maxCStar=*/ 0, false
        );
    }

    function testCreatorFullTariff_OnlyCreator() public {
        uint256 offerId = _createLenderErc20Offer();
        vm.prank(borrower); // not the creator
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ProfileFacet(address(diamond)).setOfferCreatorFullTariff(
            offerId, true, 1 ether, false
        );
    }
}
