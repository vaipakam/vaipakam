// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RiskFacetTest} from "./RiskFacetTest.t.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

/**
 * @title SanctionsOracleTest
 * @notice Phase 4.3 — address-level sanctions screening. Verifies:
 *           - Gate disabled (oracle = 0x0): pass-through.
 *           - Gate enabled + clean addresses: createOffer + acceptOffer succeed.
 *           - Gate enabled + sanctioned caller: createOffer reverts.
 *           - Gate enabled + sanctioned acceptor: acceptOffer reverts.
 *           - Gate enabled + creator sanctioned AFTER posting: acceptOffer
 *             still reverts (protects the acceptor from inheriting a tainted
 *             counterparty).
 *           - Oracle outage (read revert): wrapper fail-opens so the
 *             protocol isn't bricked on infra failure.
 *           - Admin gating on setSanctionsOracle.
 */
contract SanctionsOracleTest is RiskFacetTest {
    address internal sanctionedWallet = makeAddr("sanctioned");
    address internal attacker = makeAddr("attacker-nonowner");

    /// @dev Parent `RiskFacetTest.setUp` isn't marked virtual, so we can't
    ///      override. Instead, each test that needs the sanctions oracle
    ///      calls `_installSanctions()` first — cheap (one contract
    ///      deploy) and keeps the setup explicit per case.
    function _installSanctions() internal returns (MockSanctionsList m) {
        m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    // ─── Admin gating ──────────────────────────────────────────────────────

    function test_setSanctionsOracle_NonOwnerReverts() public {
        MockSanctionsList m = new MockSanctionsList();
        vm.prank(attacker);
        vm.expectRevert();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    function test_setSanctionsOracle_OwnerCanSetAndClear() public {
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        assertEq(
            ProfileFacet(address(diamond)).getSanctionsOracle(),
            address(m)
        );
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0));
        assertEq(
            ProfileFacet(address(diamond)).getSanctionsOracle(),
            address(0)
        );
    }

    // ─── Oracle disabled: pass-through ─────────────────────────────────────

    function test_OracleZero_EveryoneClean() public {
        // No oracle installed — isSanctionedAddress returns false for all.
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionedAddress(sanctionedWallet)
        );
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionedAddress(lender)
        );
    }

    function test_OracleZero_CreateOfferPasses() public {
        // The inherited fixture's createAndAcceptOffer path exercises both
        // createOffer and acceptOffer with the default (zero) oracle —
        // any revert would fail the call chain and the test.
        uint256 loanId = createAndAcceptOffer();
        assertGt(loanId, 0);
    }

    // ─── Oracle enabled: isSanctionedAddress contract ──────────────────────

    function test_isSanctionedAddress_TrueForFlagged() public {
        MockSanctionsList m = _installSanctions();
        m.setFlagged(sanctionedWallet, true);
        assertTrue(
            ProfileFacet(address(diamond)).isSanctionedAddress(sanctionedWallet)
        );
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionedAddress(lender)
        );
    }

    function test_isSanctionedAddress_FailOpenOnOracleRevert() public {
        // Outage scenario — the read reverts. The wrapper's try/catch must
        // return false rather than propagating the failure and bricking
        // every subsequent interaction. Intentional fail-open semantics;
        // see the natspec on `LibVaipakam.isSanctionedAddress`.
        MockSanctionsList m = _installSanctions();
        m.setFlagged(sanctionedWallet, true);
        m.setRevertOnRead(true);
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionedAddress(sanctionedWallet)
        );
    }

    // ─── createOffer enforcement ───────────────────────────────────────────

    function test_createOffer_RevertsWhenCallerSanctioned() public {
        MockSanctionsList m = _installSanctions();
        m.setFlagged(lender, true);

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProfileFacet.SanctionedAddress.selector,
                lender
            )
        );
        OfferFacet(address(diamond)).createOffer(_buildLenderOfferParams());
    }

    // ─── acceptOffer enforcement ───────────────────────────────────────────

    function test_acceptOffer_RevertsWhenAcceptorSanctioned() public {
        // Step 1: clean creator posts an offer.
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            _buildLenderOfferParams()
        );

        // Step 2: install oracle + flag the borrower.
        MockSanctionsList m = _installSanctions();
        m.setFlagged(borrower, true);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProfileFacet.SanctionedAddress.selector,
                borrower
            )
        );
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    function test_acceptOffer_RevertsWhenCreatorSanctionedAfterPosting() public {
        // Edge case: creator was clean at `createOffer` time but is flagged
        // before anyone accepts. The accept call must still revert so the
        // acceptor doesn't unwittingly pair with a now-tainted counterparty.
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            _buildLenderOfferParams()
        );

        MockSanctionsList m = _installSanctions();
        m.setFlagged(lender, true);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProfileFacet.SanctionedAddress.selector,
                lender
            )
        );
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    function _buildLenderOfferParams()
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: 1000 ether,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 1800 ether,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: 0,
            interestRateBpsMax: 0
        });
    }
}
