// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title AcceptTermBindingTest
 * @notice #662 — the anti-phishing accept-term binding security surface. Every
 *         revert here fires in `OfferAcceptFacet._verifyAndBindAccept`, BEFORE
 *         `_acceptOffer` touches any vault, so these need no collateral funding.
 *
 *         Scenarios A & B (design doc §1): a clone that hardcodes consent on a
 *         dummy-illiquid offer is stopped because the acceptor's signed terms
 *         must (a) equal the stored offer field-for-field and (b) name the exact
 *         illiquid asset. Plus the EIP-712 envelope checks (signature, acceptor
 *         binding, deadline) and a representative per-field-mismatch sweep.
 */
contract AcceptTermBindingTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    /// @dev A single-value ERC-20 Lender offer (creator consents), parameterised
    ///      on the lend/collateral legs so the illiquid scenarios can swap one in.
    function _lenderOffer(address lendAsset, address collAsset)
        internal
        returns (uint256 offerId)
    {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: lendAsset,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: collAsset,
                collateralAmount: 1500 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _build(uint256 offerId)
        internal
        view
        returns (LibAcceptTerms.AcceptTerms memory)
    {
        return LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
    }

    function _sign(LibAcceptTerms.AcceptTerms memory t)
        internal
        view
        returns (bytes memory)
    {
        return LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
    }

    function _accept(uint256 offerId, LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
        internal
    {
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // ── Per-field mismatch (OfferTermsMismatch, indices per the error legend) ──

    function test_Revert_FieldMismatch_amount() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        t.amount = t.amount + 1; // diverge from the role-correct endpoint
        bytes memory sig = _sign(t); // valid sig over the TAMPERED terms
        vm.expectRevert(abi.encodeWithSelector(OfferAcceptFacet.OfferTermsMismatch.selector, uint8(6)));
        _accept(offerId, t, sig);
    }

    function test_Revert_FieldMismatch_collateralAsset() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        t.collateralAsset = mockERC20; // swap collateral asset
        bytes memory sig = _sign(t);
        vm.expectRevert(abi.encodeWithSelector(OfferAcceptFacet.OfferTermsMismatch.selector, uint8(5)));
        _accept(offerId, t, sig);
    }

    function test_Revert_FieldMismatch_interestRate() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        t.interestRateBps = t.interestRateBps + 1;
        bytes memory sig = _sign(t);
        vm.expectRevert(abi.encodeWithSelector(OfferAcceptFacet.OfferTermsMismatch.selector, uint8(8)));
        _accept(offerId, t, sig);
    }

    // ── Scenario A — dummy ILLIQUID COLLATERAL, ack omitted ───────────────────

    function test_Revert_ScenarioA_illiquidCollateralNotAcknowledged() public {
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        // buildTerms named the illiquid collateral correctly; a phishing clone
        // hardcodes consent but cannot name it — simulate by zeroing the ack.
        assertEq(t.acknowledgedIlliquidCollateralAsset, mockIlliquidERC20, "ack precondition");
        t.acknowledgedIlliquidCollateralAsset = address(0);
        bytes memory sig = _sign(t);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.IlliquidAssetNotAcknowledged.selector, mockIlliquidERC20
            )
        );
        _accept(offerId, t, sig);
    }

    // ── Scenario B — dummy ILLIQUID PRINCIPAL, ack omitted ────────────────────

    function test_Revert_ScenarioB_illiquidLendingNotAcknowledged() public {
        // Fund the lender with the illiquid asset so createOffer can lien it.
        ERC20Mock(mockIlliquidERC20).mint(lender, 100000 ether);
        vm.prank(lender);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);

        uint256 offerId = _lenderOffer(mockIlliquidERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        assertEq(t.acknowledgedIlliquidLendingAsset, mockIlliquidERC20, "ack precondition");
        t.acknowledgedIlliquidLendingAsset = address(0);
        bytes memory sig = _sign(t);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.IlliquidAssetNotAcknowledged.selector, mockIlliquidERC20
            )
        );
        _accept(offerId, t, sig);
    }

    // ── EIP-712 envelope checks ───────────────────────────────────────────────

    function test_Revert_SignatureInvalid_wrongSigner() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId);
        (, uint256 wrongPk) = makeAddrAndKey("notTheBorrower");
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, wrongPk);
        vm.expectRevert(OfferAcceptFacet.AcceptSignatureInvalid.selector);
        _accept(offerId, t, sig);
    }

    function test_Revert_AcceptorMismatch_callerNotSigner() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId); // t.acceptor == borrower
        bytes memory sig = _sign(t);
        // Submit as `lender` — msg.sender != terms.acceptor.
        vm.expectRevert(
            OfferAcceptFacet.AcceptorMismatch.selector
        );
        vm.prank(lender);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function test_Revert_DeadlineExpired() public {
        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTerms.AcceptTerms memory t = _build(offerId); // deadline = now + 1h
        bytes memory sig = _sign(t);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(
            OfferAcceptFacet.AcceptDeadlineExpired.selector
        );
        _accept(offerId, t, sig);
    }

    // ── Nonce single-use (replay) ─────────────────────────────────────────────

    function test_Revert_NonceReplay() public {
        // A reverted accept rolls back its nonce mark, so to consume a nonce we
        // need a successful accept. Drive a normal happy accept of offer 1
        // (nonce = offerId 1), then try to reuse that nonce on offer 2.
        uint256 o1 = _lenderOffer(mockERC20, mockCollateralERC20);
        uint256 o2 = _lenderOffer(mockERC20, mockCollateralERC20);
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, o1);

        LibAcceptTerms.AcceptTerms memory t = _build(o2);
        t.nonce = o1; // reuse the already-consumed nonce
        bytes memory sig = _sign(t);
        vm.expectRevert(
            OfferAcceptFacet.AcceptNonceUsed.selector
        );
        _accept(o2, t, sig);
    }
}
