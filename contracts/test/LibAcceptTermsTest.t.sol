// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibSignedOffer} from "../src/libraries/LibSignedOffer.sol";

/**
 * @title LibAcceptTermsTest
 * @notice Unit coverage for the #662 EIP-712 typed-acceptance foundation
 *         ({LibAcceptTerms}). Internal lib functions inline into this test
 *         contract, so `address(this)` is the EIP-712 `verifyingContract` —
 *         self-consistent for digest/verify assertions (the production
 *         verifyingContract is the Diamond; the property under test is the
 *         signing/verification + field/domain binding, which is
 *         address-agnostic).
 */
contract LibAcceptTermsTest is Test {
    uint256 internal acceptorPk = 0xA11CE;
    address internal acceptor;

    function setUp() public {
        acceptor = vm.addr(acceptorPk);
    }

    /// @dev A fully-populated AcceptTerms bound to `acceptor`.
    function _terms() internal view returns (LibAcceptTerms.AcceptTerms memory a) {
        a.acceptor = acceptor;
        a.offerCreator = address(0xB0B);
        a.offerKey = keccak256("offer-42");
        a.offerType = 0; // Lender
        a.lendingAsset = address(0x1111);
        a.collateralAsset = address(0x2222);
        a.amount = 1_000e18;
        a.collateralAmount = 2e18;
        a.interestRateBps = 500;
        a.durationDays = 30;
        a.tokenId = 0;
        a.collateralTokenId = 0;
        a.quantity = 0;
        a.collateralQuantity = 0;
        a.assetType = 0; // ERC20
        a.collateralAssetType = 0;
        a.prepayAsset = address(0);
        a.useFullTermInterest = false;
        a.allowsPartialRepay = true;
        a.allowsPrepayListing = false;
        a.allowsParallelSale = false;
        a.refinanceTargetLoanId = 0;
        a.linkedLoanId = 0;
        a.parallelSaleOrderHash = bytes32(0);
        a.periodicInterestCadence = 0;
        a.riskAndTermsConsent = true;
        a.acknowledgedIlliquidLendingAsset = address(0);
        a.acknowledgedIlliquidCollateralAsset = address(0);
        a.nonce = 1;
        a.deadline = type(uint256).max;
    }

    function _sign(uint256 pk, LibAcceptTerms.AcceptTerms memory a)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, LibAcceptTerms.digest(a));
        return abi.encodePacked(r, s, v);
    }

    /// A correct EOA signature over the digest verifies.
    function test_verify_happyPath() public view {
        LibAcceptTerms.AcceptTerms memory a = _terms();
        assertTrue(LibAcceptTerms.verify(a, _sign(acceptorPk, a)));
    }

    /// A signature from a key other than `a.acceptor` is rejected.
    function test_verify_wrongSigner() public view {
        LibAcceptTerms.AcceptTerms memory a = _terms();
        bytes memory wrong = _sign(0xBAD5161, a); // different pk
        assertFalse(LibAcceptTerms.verify(a, wrong));
    }

    /// Mutating ANY bound field invalidates an existing signature (term binding).
    function test_verify_fieldMutationBreaksSignature() public view {
        LibAcceptTerms.AcceptTerms memory a = _terms();
        bytes memory sig = _sign(acceptorPk, a);
        // Swap the collateral asset (the dummy-asset phishing swap).
        a.collateralAsset = address(0xDEAD);
        assertFalse(LibAcceptTerms.verify(a, sig));
    }

    /// The digest is deterministic for identical inputs.
    function test_digest_deterministic() public view {
        assertEq(LibAcceptTerms.digest(_terms()), LibAcceptTerms.digest(_terms()));
    }

    /// `acceptor` is bound into the digest: re-pointing it changes the digest
    /// (so the same owner key can't validate for a different account).
    function test_digest_bindsAcceptor() public view {
        LibAcceptTerms.AcceptTerms memory a = _terms();
        bytes32 d1 = LibAcceptTerms.digest(a);
        a.acceptor = address(0xC0FFEE);
        assertTrue(d1 != LibAcceptTerms.digest(a));
    }

    /// Acceptance-specific domain: an AcceptTerms digest must NOT collide with
    /// a structurally-similar SignedOffer digest (distinct domain name), so a
    /// signed-offer signature can't be replayed as an acceptance.
    function test_domain_distinctFromSignedOffer() public view {
        LibAcceptTerms.AcceptTerms memory a = _terms();
        LibSignedOffer.SignedOffer memory o;
        o.lendingAsset = a.lendingAsset;
        o.amount = a.amount;
        o.collateralAsset = a.collateralAsset;
        o.signer = a.acceptor;
        o.nonce = a.nonce;
        o.deadline = a.deadline;
        // Different typehash AND different domain name → different digest.
        assertTrue(LibAcceptTerms.digest(a) != LibSignedOffer.digest(o));
    }
}
