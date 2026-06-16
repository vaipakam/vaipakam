// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSignedOffer} from "../src/libraries/LibSignedOffer.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  SignedOfferMatcherTest
 * @notice Targeted suite for #396 v0.6 — the keeper-matcher for signed
 *         offers (`OfferMatchFacet.matchSignedOffer`).
 *
 * @dev    A keeper (`msg.sender`) fills a vault-backed signed offer against
 *         an on-chain counterparty offer, full or partial, earning the 1%
 *         LIF. Each call materializes EXACTLY the `fillAmount` slice as a
 *         single-value on-chain offer, routes it through the shared
 *         `_executeMatch`, and decrements the off-chain
 *         `signedOfferFilled[orderHash]` ledger.
 *
 *         Setup posture mirrors `MatchOffersScaffoldTest` /
 *         `BorrowerPartialFillTest`: `partialFillEnabled` is ON in `setUp`
 *         (matchSignedOffer reverts `FunctionDisabled(3)` otherwise). The
 *         EIP-712 signing mirrors `SignedOfferBookTest`: hash via the
 *         on-chain `hashSignedOffer` view, `vm.sign(pk, digest)`, pack
 *         `(r,s,v)`.
 *
 *         Numbers use the SetupTest oracle convention ($1 per token, 18
 *         decimals on both legs). The signed offer is the LTV-safe
 *         1000-principal / 1500-collateral / 30-day / 5% shape, so the
 *         materialize → match → loan-init path clears the HF (>=1.5e18) /
 *         LTV gates `LibOfferMatch.previewMatch` enforces.
 *
 *         The keeper is a fresh actor with no KYC/country wiring — that is
 *         intentional: KYC enforcement is off on the retail deploy and the
 *         matcher is only sanctions-screened, so a plain EOA is a faithful
 *         keeper. The signer likewise needs no compliance wiring (signing
 *         IS consent; KYC enforcement is off).
 */
contract SignedOfferMatcherTest is SetupTest {
    address internal signer;
    uint256 internal signerPk;
    address internal keeper;

    // The LTV-safe shape (mirrors LoanFacetTest.testInitiateLoanSuccessful).
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 1500 ether;
    uint256 internal constant DURATION = 30;
    uint256 internal constant RATE_BPS = 500;

    function setUp() public {
        setupHelper();
        (signer, signerPk) = makeAddrAndKey("signer");
        keeper = makeAddr("keeper");

        // Flip every Range Orders Phase 1 + #102 kill-switch on so the
        // matcher code paths are reachable. The kill-switch case re-disables
        // `partialFillEnabled` in its own scope.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();
    }

    // ─── Signed-offer builders ─────────────────────────────────────────────

    /// @dev A vault-backed ERC-20 **Lender** signed offer. `amount` is the
    ///      MIN / single-value, `amountMax` the range max. `fillMode` is
    ///      Partial by default. Collateral range mirrors the principal range
    ///      pro-rata (1.5x), so every slice the matcher materializes clears
    ///      the LTV gate against an overlapping on-chain borrower offer.
    function _lenderSignedOffer(
        uint256 nonce,
        uint256 amount,
        uint256 amountMax,
        LibVaipakam.FillMode fillMode
    ) internal view returns (LibSignedOffer.SignedOffer memory o) {
        o.offerType = uint8(LibVaipakam.OfferType.Lender);
        o.lendingAsset = mockERC20;
        o.amount = amount;
        o.amountMax = amountMax;
        o.interestRateBps = RATE_BPS;
        o.interestRateBpsMax = RATE_BPS + 100; // [500, 600] band
        o.collateralAsset = mockCollateralERC20;
        o.collateralAmount = (amount * 3) / 2; // 1.5x floor
        o.collateralAmountMax = (amountMax * 3) / 2; // 1.5x ceiling
        o.durationDays = DURATION;
        o.assetType = uint8(LibVaipakam.AssetType.ERC20);
        o.collateralAssetType = uint8(LibVaipakam.AssetType.ERC20);
        o.prepayAsset = mockERC20;
        o.expiresAt = 0; // GTC
        o.fillMode = uint8(fillMode);
        o.periodicInterestCadence =
            uint8(LibVaipakam.PeriodicInterestCadence.None);
        o.refinanceTargetLoanId = 0;
        o.useFullTermInterest = false;
        o.signer = signer;
        o.nonce = nonce;
        o.deadline = 0; // GTC signature
    }

    /// @dev A vault-backed ERC-20 **Borrower** signed offer (mirror
    ///      direction). The signer pledges collateral; an on-chain lender
    ///      provides the principal.
    function _borrowerSignedOffer(
        uint256 nonce,
        uint256 amount,
        uint256 amountMax,
        LibVaipakam.FillMode fillMode
    ) internal view returns (LibSignedOffer.SignedOffer memory o) {
        o = _lenderSignedOffer(nonce, amount, amountMax, fillMode);
        o.offerType = uint8(LibVaipakam.OfferType.Borrower);
    }

    function _sign(LibSignedOffer.SignedOffer memory o)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 digest = SignedOfferFacet(address(diamond)).hashSignedOffer(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _orderHash(LibSignedOffer.SignedOffer memory o)
        internal
        view
        returns (bytes32)
    {
        return SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);
    }

    // ─── On-chain counterparty offer builders ──────────────────────────────

    /// @dev Post an on-chain BORROWER offer (single-value) that overlaps a
    ///      lender slice of `amount`: matching asset legs, [500,600] rate
    ///      band, 30-day duration, 1.5x collateral. `creator` pre-funds the
    ///      collateral from their wallet (the offer-create chokepoint pulls
    ///      `collateralAmountMax` into the creator's vault).
    function _postBorrowerCounterparty(address creator, uint256 amount)
        internal
        returns (uint256 offerId)
    {
        uint256 coll = (amount * 3) / 2;
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: coll,
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
                amountMax: amount, // single-value borrower counterparty
                interestRateBpsMax: RATE_BPS + 100,
                collateralAmountMax: coll,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Post an on-chain LENDER offer (single-value) of `amount` against
    ///      a borrower slice. `creator` pre-funds the principal from their
    ///      wallet (offer-create pulls `amountMax` into the creator's vault).
    function _postLenderCounterparty(address creator, uint256 amount)
        internal
        returns (uint256 offerId)
    {
        uint256 coll = (amount * 3) / 2;
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: coll,
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
                amountMax: amount, // single-value lender counterparty
                interestRateBpsMax: RATE_BPS + 100,
                collateralAmountMax: coll,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Provision a fresh actor (KYC + country + diamond approvals + wallet
    ///      balance) so they can create an on-chain counterparty offer that
    ///      clears the compliance + funding chokepoints.
    function _newCounterparty(string memory name)
        internal
        returns (address actor)
    {
        actor = makeAddr(name);
        ERC20Mock(mockERC20).mint(actor, 100_000 ether);
        ERC20Mock(mockCollateralERC20).mint(actor, 100_000 ether);
        vm.prank(actor);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(actor);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(actor);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            actor, LibVaipakam.KYCTier.Tier2
        );
    }

    // ─── 1. Full match: signed LENDER × on-chain BORROWER ──────────────────

    function test_fullMatch_signedLender_onchainBorrower() public {
        // Single-value signed lender offer (amount == amountMax == ceiling).
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(1, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);

        // Signer's principal sits free in their vault.
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        // On-chain borrower counterparty (the real borrower).
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // Keeper fills the whole ceiling.
        vm.prank(keeper);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );

        assertGt(loanId, 0, "loan initiated");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, signer, "lender = signed-offer signer");
        assertEq(loan.borrower, borrower, "borrower = on-chain offer creator");
        // The matcher is the keeper, NOT the diamond (internal-call preservation).
        assertEq(loan.matcher, keeper, "matcher = keeper");
        assertTrue(loan.matcher != address(diamond), "matcher not the diamond");
        assertEq(loan.principal, PRINCIPAL, "principal = full ceiling");
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan active"
        );

        // Off-chain ledger marks the full ceiling consumed.
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            PRINCIPAL,
            "ledger filled == ceiling"
        );
    }

    /// @notice The SignedOfferMatched event fires with the right indexed
    ///         topics + fill amount. Checked separately so the topic
    ///         assertions don't clutter the state-assertion case above.
    function test_fullMatch_emitsSignedOfferMatched() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(2, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // Check indexed topics (orderHash, signer, matcher) + fillAmount in
        // data. sliceOfferId / counterpartyOfferId / loanId are not pinned
        // (don't assert data we can't predict deterministically here), so we
        // only check the topics + the trailing fillAmount via a partial
        // matcher: assert topics, skip exact data equality on the ids.
        vm.recordLogs();
        vm.prank(keeper);
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );

        // Find the SignedOfferMatched log and assert its indexed topics.
        bytes32 sigTopic = keccak256(
            "SignedOfferMatched(bytes32,address,address,uint256,uint256,uint256,uint256)"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sigTopic) {
                found = true;
                assertEq(logs[i].topics[1], orderHash, "topic: orderHash");
                assertEq(
                    address(uint160(uint256(logs[i].topics[2]))),
                    signer,
                    "topic: signer"
                );
                assertEq(
                    address(uint160(uint256(logs[i].topics[3]))),
                    keeper,
                    "topic: matcher"
                );
                // Trailing data word is fillAmount.
                (, , , uint256 fillAmount) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(fillAmount, PRINCIPAL, "data: fillAmount");
            }
        }
        assertTrue(found, "SignedOfferMatched emitted");
    }

    // ─── 2. Partial → partial → close ──────────────────────────────────────

    function test_partialFills_thenConsumed() public {
        // Range lender offer: ceiling 3000, min slice 1000.
        uint256 ceiling = 3 * PRINCIPAL; // 3000 ether
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(3, PRINCIPAL, ceiling, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);

        // Fund the signer's vault for the full ceiling (each slice draws a
        // portion of principal out at materialize time).
        _fundActorVault(signer, mockERC20, ceiling);

        // Three independent on-chain borrower counterparties, each sized to a
        // 1000 slice (borrower offers are single-fill, so each match needs its
        // own counterparty).
        address b1 = _newCounterparty("cp1");
        address b2 = _newCounterparty("cp2");
        address b3 = _newCounterparty("cp3");
        uint256 cp1 = _postBorrowerCounterparty(b1, PRINCIPAL);
        uint256 cp2 = _postBorrowerCounterparty(b2, PRINCIPAL);
        uint256 cp3 = _postBorrowerCounterparty(b3, PRINCIPAL);

        // ── Slice 1.
        vm.prank(keeper);
        uint256 loan1 = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, cp1, PRINCIPAL
        );
        assertGt(loan1, 0, "slice 1 loan");
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            PRINCIPAL,
            "ledger after slice 1"
        );
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loan1).matcher,
            keeper,
            "slice 1 matcher = keeper"
        );

        // ── Slice 2.
        vm.prank(keeper);
        uint256 loan2 = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, cp2, PRINCIPAL
        );
        assertGt(loan2, 0, "slice 2 loan");
        assertTrue(loan2 != loan1, "distinct loan ids");
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            2 * PRINCIPAL,
            "ledger after slice 2"
        );

        // ── Slice 3 consumes the residual ceiling.
        vm.prank(keeper);
        uint256 loan3 = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, cp3, PRINCIPAL
        );
        assertGt(loan3, 0, "slice 3 loan");
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            ceiling,
            "ledger fully consumed"
        );

        // ── A further fill reverts SignedOfferConsumed.
        address b4 = _newCounterparty("cp4");
        uint256 cp4 = _postBorrowerCounterparty(b4, PRINCIPAL);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferConsumed.selector, orderHash
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, cp4, PRINCIPAL
        );
    }

    // ─── 3. Over-fill ──────────────────────────────────────────────────────

    function test_overFill_reverts() public {
        // Range lender offer: ceiling 2000.
        uint256 ceiling = 2 * PRINCIPAL;
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(4, PRINCIPAL, ceiling, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, ceiling);

        uint256 borrowerOfferId =
            _postBorrowerCounterparty(borrower, ceiling + PRINCIPAL);

        // fillAmount exceeds the remaining (ceiling) → SignedOfferFillInvalid.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                ceiling + PRINCIPAL, // fillAmount
                ceiling // remaining
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, ceiling + PRINCIPAL
        );
    }

    // ─── 4. AON signed offer ───────────────────────────────────────────────

    function test_aon_partialFill_reverts() public {
        // AON requires amount == amountMax (single-value); ceiling = PRINCIPAL.
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(5, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Aon);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        uint256 partialFill = PRINCIPAL / 2;
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, partialFill);

        // A partial fill (< ceiling) on an AON offer reverts SignedOfferFillInvalid.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                partialFill, // fillAmount
                PRINCIPAL // remaining (= ceiling, nothing filled yet)
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, partialFill
        );
    }

    function test_aon_fullFill_succeeds() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(6, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Aon);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        vm.prank(keeper);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
        assertGt(loanId, 0, "AON full fill loan");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, signer, "lender = signer");
        assertEq(loan.borrower, borrower, "borrower = counterparty");
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            PRINCIPAL,
            "AON ledger consumed"
        );
    }

    // ─── 5. Mirror direction: signed BORROWER × on-chain LENDER ────────────

    function test_mirror_signedBorrower_onchainLender() public {
        // Single-value signed borrower offer. The signer pledges collateral.
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer(7, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);

        // Signer's COLLATERAL sits free in their vault (1.5x principal).
        _fundActorVault(signer, mockCollateralERC20, COLLATERAL);

        // On-chain lender counterparty (the real lender) provides principal.
        uint256 lenderOfferId = _postLenderCounterparty(lender, PRINCIPAL);

        vm.prank(keeper);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, lenderOfferId, PRINCIPAL
        );

        assertGt(loanId, 0, "mirror loan initiated");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.borrower, signer, "borrower = signed-offer signer");
        assertEq(loan.lender, lender, "lender = on-chain offer creator");
        assertEq(loan.matcher, keeper, "matcher = keeper");
        assertEq(loan.principal, PRINCIPAL, "principal matches");
        assertEq(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash),
            PRINCIPAL,
            "mirror ledger consumed"
        );
    }

    // ─── 6. Bad signature ──────────────────────────────────────────────────

    function test_badSignature_reverts() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(8, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // Tamper a binding field AFTER signing — the digest no longer recovers
        // to `o.signer`. (deadline isn't in the vet's pre-hash path the way
        // that would short-circuit, so the bad-sig check fires.)
        o.interestRateBps = RATE_BPS + 1;

        vm.prank(keeper);
        vm.expectRevert(OfferMatchFacet.SignedOfferBadSignature.selector);
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
    }

    // ─── 7. Cancelled / nonce-burned ───────────────────────────────────────

    function test_cancelled_reverts_consumed() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(9, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        bytes32 orderHash = _orderHash(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // Signer cancels on-chain — marks the order hash filled to its ceiling.
        vm.prank(signer);
        SignedOfferFacet(address(diamond)).cancelSignedOffer(o);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferConsumed.selector, orderHash
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
    }

    function test_nonceBurned_reverts() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(10, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // Signer batch-invalidates the nonce.
        vm.prank(signer);
        SignedOfferFacet(address(diamond)).invalidateSignedOfferNonce(o.nonce);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferNonceBurned.selector, o.nonce
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
    }

    // ─── 8. Kill-switch ────────────────────────────────────────────────────

    function test_killSwitch_off_reverts() public {
        // Re-disable the master flag within this test's scope.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);

        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(11, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        // FunctionDisabled(3) is the partial-fill master gate.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSignature("FunctionDisabled(uint8)", uint8(3))
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
    }

    // ─── 9. Dust floors (Codex #616 P1) ────────────────────────────────────

    /// @notice A keeper may not fill a partial-fillable signed offer BELOW the
    ///         signer's stated minimum slice (`amount`). `_materializeSlice`
    ///         rewrites the slice to a single value, so `previewMatch` can no
    ///         longer see the signed minimum — the matcher's vet must enforce
    ///         it. A 500 fill on a [1000, 3000] offer is below the 1000 floor.
    function test_partial_belowMinSlice_reverts() public {
        uint256 ceiling = 3 * PRINCIPAL;
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(12, PRINCIPAL, ceiling, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, ceiling);
        uint256 cp = _postBorrowerCounterparty(borrower, PRINCIPAL);

        uint256 belowMin = PRINCIPAL / 2; // 500 < amount (1000)
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                belowMin, // fillAmount
                ceiling // remaining (nothing filled yet)
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp, belowMin);
    }

    /// @notice A keeper may not leave a sub-minimum dust REMAINDER. Filling
    ///         2500 of a [1000, 3000] offer would strand 500 (< the 1000
    ///         floor) — an off-chain remainder no further match could ever
    ///         consume. The vet rejects it.
    function test_partial_subMinDustRemainder_reverts() public {
        uint256 ceiling = 3 * PRINCIPAL;
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(13, PRINCIPAL, ceiling, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, ceiling);
        uint256 cp = _postBorrowerCounterparty(borrower, 5 * PRINCIPAL / 2);

        uint256 fill = 5 * PRINCIPAL / 2; // 2500 → leaves 500 dust (< 1000)
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                fill, // fillAmount
                ceiling // remaining
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp, fill);
    }

    /// @notice A RANGED all-or-nothing signed offer (`amount != amountMax`) is
    ///         structurally malformed — the direct create path forbids it, so
    ///         the matcher must reject it before slicing rewrites it to a
    ///         single value and silently bypasses the invariant.
    function test_rangedAon_reverts() public {
        uint256 ceiling = 2 * PRINCIPAL;
        // amount (1000) != amountMax (2000) while fillMode == Aon → malformed.
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(14, PRINCIPAL, ceiling, LibVaipakam.FillMode.Aon);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, ceiling);
        uint256 cp = _postBorrowerCounterparty(borrower, ceiling);

        // Even a full-ceiling fill reverts: the shape itself is rejected.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                ceiling, // fillAmount
                ceiling // remaining
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp, ceiling);
    }

    /// @notice A matched signed offer with a NON-constant collateral ratio
    ///         (collMin:amount != collMax:amountMax) is rejected before slicing
    ///         — a varying ratio across the fill isn't a sliceable order (it
    ///         would let a keeper split the range into slices that over-collect
    ///         in aggregate). Built 2.0x floor / 1.25x ceiling. Must be AON or
    ///         expressed as separate offers instead.
    function test_nonConstantRatio_partial_reverts() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(15, PRINCIPAL, 2 * PRINCIPAL, LibVaipakam.FillMode.Partial);
        // Non-constant ratio: 2.0x floor (2000 @ 1000), 1.25x ceiling (2500 @ 2000).
        o.collateralAmount = 2 * PRINCIPAL;
        o.collateralAmountMax = 5 * PRINCIPAL / 2;
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, 2 * PRINCIPAL);
        uint256 cp = _postBorrowerCounterparty(borrower, PRINCIPAL);

        vm.prank(keeper);
        vm.expectRevert(OfferMatchFacet.SignedOfferRatioNotConstant.selector);
        OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp, PRINCIPAL);
    }

    /// @dev Pull the `sliceOfferId` (first data word) out of the most recent
    ///      `SignedOfferMatched` log. Call right after `matchSignedOffer`
    ///      under `vm.recordLogs()`.
    function _lastSliceOfferId() internal returns (uint256 sliceOfferId) {
        bytes32 sigTopic = keccak256(
            "SignedOfferMatched(bytes32,address,address,uint256,uint256,uint256,uint256)"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sigTopic) {
                found = true;
                (sliceOfferId, , , ) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
        assertTrue(found, "SignedOfferMatched emitted");
    }

    /// @dev A vault-backed signed BORROWER offer at a fixed 2.0x collateral
    ///      ratio (constant: collMin:amount == collMax:amountMax). Over-
    ///      collateralized vs the standard 1.5x lender counterparty, so the
    ///      signed floor exceeds the lender's pro-rated requirement.
    function _borrowerSignedOffer2x(uint256 nonce, uint256 amount, uint256 amountMax)
        internal
        view
        returns (LibSignedOffer.SignedOffer memory o)
    {
        o = _borrowerSignedOffer(nonce, amount, amountMax, LibVaipakam.FillMode.Partial);
        o.collateralAmount = 2 * amount; // 2.0x floor
        o.collateralAmountMax = 2 * amountMax; // 2.0x ceiling (constant ratio)
    }

    // ─── 10. Borrower-direction collateral floor (Codex round-2 P1) ────────

    /// @notice A signed BORROWER slice locks the signer's pro-rata collateral,
    ///         not the matched lender's lower requirement. Constant 2.0x ratio
    ///         vs a 1.5x lender counterparty: the loan must lock the borrower's
    ///         2000 (the threaded floor), not the lender's 1500 — otherwise the
    ///         loan opens below the collateral the signer signed.
    function test_borrowerSlice_locksSignedCollateralFloor() public {
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer2x(16, PRINCIPAL, 2 * PRINCIPAL);
        bytes memory sig = _sign(o);
        // Signer pledges 2000 (2.0x) for this min-slice fill.
        _fundActorVault(signer, mockCollateralERC20, 2 * PRINCIPAL);

        // On-chain lender requires only 1.5x (1500) for 1000 principal.
        uint256 lenderOfferId = _postLenderCounterparty(lender, PRINCIPAL);

        vm.prank(keeper);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, lenderOfferId, PRINCIPAL
        );

        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.borrower, signer, "borrower = signer");
        // The loan locks the signed 2000 floor, NOT the lender's 1500 req.
        assertEq(
            loan.collateralAmount,
            2 * PRINCIPAL,
            "loan locks signed collateral floor"
        );
        // Floor == pulled → nothing refunded back to the signer's wallet.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(signer),
            0,
            "no floor-collateral refunded out"
        );
    }

    /// @notice Aggregate collateral across partial slices is capped at the
    ///         signed ceiling. A constant 2.0x [1000,2000]/[2000,4000] borrower
    ///         offer filled in two 1000 slices locks 2000 each — summing to
    ///         exactly the signed `collateralAmountMax` (4000), never more.
    function test_borrowerSlice_aggregateCollateralCapped() public {
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer2x(18, PRINCIPAL, 2 * PRINCIPAL);
        bytes memory sig = _sign(o);
        // Signer funds the full signed ceiling (4000); each slice draws its share.
        _fundActorVault(signer, mockCollateralERC20, 4 * PRINCIPAL);

        address l1 = _newCounterparty("lcp1");
        address l2 = _newCounterparty("lcp2");
        uint256 cp1 = _postLenderCounterparty(l1, PRINCIPAL);
        uint256 cp2 = _postLenderCounterparty(l2, PRINCIPAL);

        vm.prank(keeper);
        uint256 loan1 = OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp1, PRINCIPAL);
        vm.prank(keeper);
        uint256 loan2 = OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp2, PRINCIPAL);

        uint256 c1 = LoanFacet(address(diamond)).getLoanDetails(loan1).collateralAmount;
        uint256 c2 = LoanFacet(address(diamond)).getLoanDetails(loan2).collateralAmount;
        assertEq(c1, 2 * PRINCIPAL, "slice 1 locks 2.0x");
        assertEq(c2, 2 * PRINCIPAL, "slice 2 locks 2.0x");
        // Sum equals the signed ceiling exactly — no aggregate over-collection.
        assertEq(c1 + c2, 4 * PRINCIPAL, "aggregate == signed collateralAmountMax");
    }

    /// @notice A signed offer with `amount == 0` is rejected before slicing,
    ///         so a keeper can't drain the signed max in dust-sized fills that
    ///         bypass the min-slice + create-time positive-amount invariants.
    function test_zeroMinimum_reverts() public {
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer2x(19, PRINCIPAL, 2 * PRINCIPAL);
        o.amount = 0; // malformed zero minimum
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockCollateralERC20, 4 * PRINCIPAL);
        uint256 lenderOfferId = _postLenderCounterparty(lender, PRINCIPAL);

        uint256 dust = PRINCIPAL / 4;
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchFacet.SignedOfferFillInvalid.selector,
                dust, // fillAmount
                2 * PRINCIPAL // remaining (= ceiling, nothing filled)
            )
        );
        OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, lenderOfferId, dust);
    }

    /// @notice The borrower floor is included in `previewMatch`'s HF/LTV gate,
    ///         not applied after it. A lender counterparty requiring only 1.0x
    ///         (HF-unsafe on its own) still matches a 2.0x signed borrower: the
    ///         gate sees the floored 2000 collateral and admits the loan, rather
    ///         than reverting `MatchHFTooLow` on the lender's bare 1000.
    function test_borrowerFloor_admitsLowLenderRequirement() public {
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer2x(20, PRINCIPAL, 2 * PRINCIPAL);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockCollateralERC20, 2 * PRINCIPAL);

        // On-chain lender requiring only 1.0x (1000 collateral for 1000
        // principal) — HF < 1.5 on its own, but safe at the borrower's 2.0x.
        address lowLender = _newCounterparty("lowlender");
        vm.prank(lowLender);
        uint256 cp = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: PRINCIPAL, // 1.0x requirement
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
                interestRateBpsMax: RATE_BPS + 100,
                collateralAmountMax: PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        vm.prank(keeper);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, cp, PRINCIPAL
        );
        assertGt(loanId, 0, "match admitted at the borrower floor");
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).collateralAmount,
            2 * PRINCIPAL,
            "loan locks 2.0x floor (HF-safe), not lender's 1.0x"
        );
    }

    /// @notice Per-slice integer flooring must not drop the signed collateral
    ///         total across unevenly-dividing fills. Constant 5/3 ratio
    ///         (amount=3e18 / collMin=5e18, amountMax=9e18 / collMax=15e18),
    ///         filled 4e18 + 5e18: cumulative-difference pricing locks
    ///         6.666…e18 + 8.333…e18 = exactly 15e18 (collMax). Independent
    ///         per-slice flooring would lose 1 wei (→ 14.999…e18), under-
    ///         collateralizing what the signer signed.
    function test_borrowerSlice_roundingPreservesSignedTotal() public {
        uint256 amt = 3 ether;
        uint256 amtMax = 9 ether;
        LibSignedOffer.SignedOffer memory o =
            _borrowerSignedOffer(21, amt, amtMax, LibVaipakam.FillMode.Partial);
        // Constant 5/3 ratio (≈1.667x, HF-safe): 5e18*9e18 == 15e18*3e18.
        o.collateralAmount = 5 ether;
        o.collateralAmountMax = 15 ether;
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockCollateralERC20, 15 ether);

        // Two lender counterparties at the standard 1.5x (below the 5/3 floor),
        // sized to the two fills so the loan locks the borrower's slice floor.
        address l1 = _newCounterparty("rlcp1");
        address l2 = _newCounterparty("rlcp2");
        uint256 cp1 = _postLenderCounterparty(l1, 4 ether);
        uint256 cp2 = _postLenderCounterparty(l2, 5 ether);

        vm.prank(keeper);
        uint256 loan1 = OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp1, 4 ether);
        vm.prank(keeper);
        uint256 loan2 = OfferMatchFacet(address(diamond)).matchSignedOffer(o, sig, cp2, 5 ether);

        uint256 c1 = LoanFacet(address(diamond)).getLoanDetails(loan1).collateralAmount;
        uint256 c2 = LoanFacet(address(diamond)).getLoanDetails(loan2).collateralAmount;
        // The aggregate is the signed collateralAmountMax EXACTLY — no wei lost.
        assertEq(c1 + c2, 15 ether, "rounding-exact: aggregate == signed collMax");
    }

    // ─── 11. Transient lender-slice NFT cleanup (Codex round-2 P2) ─────────

    /// @notice After a signed-LENDER match, the consumed one-tx slice must not
    ///         linger as a phantom open offer. Its OfferCreated position NFT is
    ///         burned and its `offerIdByPositionTokenId` reverse-map entry
    ///         cleared, so `getUserPositionOffers` no longer returns it and its
    ///         tokenURI/ownerOf reverts. The signer's REAL lender position is a
    ///         separate, freshly-minted loan NFT.
    function test_lenderSlice_positionNftBurnedAfterMatch() public {
        LibSignedOffer.SignedOffer memory o =
            _lenderSignedOffer(17, PRINCIPAL, PRINCIPAL, LibVaipakam.FillMode.Partial);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);
        uint256 borrowerOfferId = _postBorrowerCounterparty(borrower, PRINCIPAL);

        vm.recordLogs();
        vm.prank(keeper);
        OfferMatchFacet(address(diamond)).matchSignedOffer(
            o, sig, borrowerOfferId, PRINCIPAL
        );
        uint256 sliceOfferId = _lastSliceOfferId();
        uint256 slicePosToken =
            OfferCancelFacet(address(diamond)).getOffer(sliceOfferId).positionTokenId;

        // The orphan slice position NFT is burned.
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).ownerOf(slicePosToken);

        // getUserPositionOffers no longer surfaces the consumed slice as an
        // open offer (reverse map cleared + NFT gone).
        (uint256[] memory offerIds, ) =
            MetricsFacet(address(diamond)).getUserPositionOffers(signer);
        for (uint256 i = 0; i < offerIds.length; i++) {
            assertTrue(
                offerIds[i] != sliceOfferId,
                "consumed slice must not appear as an open offer"
            );
        }
    }
}
