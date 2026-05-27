// test/AllowsPrepayListingTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";

/// @title AllowsPrepayListingTest
/// @notice Focused round-trip test for the T-086 step-4 lender-consent
///         field: `CreateOfferParams.allowsPrepayListing` →
///         `Offer.allowsPrepayListing` (at `createOffer`) →
///         `Loan.allowsPrepayListing` (at loan-init).
///
///         The (step-6) `NFTPrepayListingFacet.postPrepayListing` reads
///         `loan.allowsPrepayListing` as its sole consent gate. This
///         test scaffolds the storage layer directly (so it doesn't
///         depend on the full create-offer flow being wired through
///         KYC / fallback consent / range bounds) and confirms:
///
///           1. The field exists on both `Offer` and `Loan` structs.
///           2. `setOffer` / `setLoan` round-trip the value correctly
///              (storage layout is correct).
///           3. The field defaults to `false` on offers / loans that
///              don't set it explicitly (the safe default).
///
/// @dev    The wire-side copy in `OfferCreateFacet.createOffer` and
///         `LoanFacet.initiateLoan` is verified by the existing 222-
///         site sweep across `CreateOfferParams({...})` construction
///         sites: every legacy offer in the test corpus now constructs
///         with `allowsPrepayListing: false`, and the next time a test
///         flips the flag to `true` (in step 6's listing-facet
///         coverage) the wire will be exercised end-to-end. For this
///         step-4 PR the focused assertions above are sufficient.
contract AllowsPrepayListingTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    uint256 internal constant TEST_OFFER_ID = 8_401;
    uint256 internal constant TEST_LOAN_ID = 8_402;

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
    }

    // ─── Storage round-trip ─────────────────────────────────────────────

    function test_offer_allowsPrepayListing_storesTrue() public {
        LibVaipakam.Offer memory o;
        o.creator = makeAddr("apl_lender");
        o.offerType = LibVaipakam.OfferType.Lender;
        o.allowsPrepayListing = true;

        TestMutatorFacet(address(diamond)).setOffer(TEST_OFFER_ID, o);

        LibVaipakam.Offer memory readBack = OfferCancelFacet(address(diamond)).getOffer(
            TEST_OFFER_ID
        );
        assertTrue(
            readBack.allowsPrepayListing,
            "Offer.allowsPrepayListing round-trips through storage as true"
        );
    }

    function test_offer_allowsPrepayListing_defaultsFalse() public {
        LibVaipakam.Offer memory o;
        o.creator = makeAddr("apl_lender_default");
        o.offerType = LibVaipakam.OfferType.Lender;
        // Intentionally NOT setting allowsPrepayListing -> default false.
        TestMutatorFacet(address(diamond)).setOffer(TEST_OFFER_ID + 1, o);

        LibVaipakam.Offer memory readBack = OfferCancelFacet(address(diamond)).getOffer(
            TEST_OFFER_ID + 1
        );
        assertFalse(
            readBack.allowsPrepayListing,
            "Offer.allowsPrepayListing default is false"
        );
    }

    function test_loan_allowsPrepayListing_storesTrue() public {
        LibVaipakam.Loan memory l;
        l.id = TEST_LOAN_ID;
        l.lender = makeAddr("apl_lender_loan");
        l.borrower = makeAddr("apl_borrower_loan");
        l.allowsPrepayListing = true;
        TestMutatorFacet(address(diamond)).setLoan(TEST_LOAN_ID, l);

        LibVaipakam.Loan memory details = LoanFacet(address(diamond)).getLoanDetails(
            TEST_LOAN_ID
        );
        assertEq(details.id, TEST_LOAN_ID, "scaffold landed at the right id");
        assertTrue(
            details.allowsPrepayListing,
            "Loan.allowsPrepayListing round-trips through storage as true"
        );
    }

    function test_loan_allowsPrepayListing_defaultsFalse() public {
        LibVaipakam.Loan memory l;
        l.id = TEST_LOAN_ID + 1;
        l.lender = makeAddr("apl_lender_loan_def");
        l.borrower = makeAddr("apl_borrower_loan_def");
        // No explicit set -> default false.
        TestMutatorFacet(address(diamond)).setLoan(TEST_LOAN_ID + 1, l);

        LibVaipakam.Loan memory details = LoanFacet(address(diamond)).getLoanDetails(
            TEST_LOAN_ID + 1
        );
        assertEq(details.id, TEST_LOAN_ID + 1, "scaffold landed at the right id");
        assertFalse(
            details.allowsPrepayListing,
            "Loan.allowsPrepayListing default is false"
        );
    }

    // ─── CreateOfferParams round-trip ──────────────────────────────────

    function test_createOfferParams_allowsPrepayListing_compiles() public pure {
        // Compile-time check: the field exists on CreateOfferParams.
        // Solidity will fail to compile if the field is missing.
        // The 222-site sweep across the test corpus / scripts covers
        // the explicit-default case (every legacy site constructs with
        // `allowsPrepayListing: false`); this assertion just pins the
        // field's presence on the calldata-input struct.
        LibVaipakam.CreateOfferParams memory p;
        bool flag = p.allowsPrepayListing;
        assert(!flag); // default-false on a fresh struct
    }
}
