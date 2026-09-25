// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";

/**
 * @title SwapToRepayIntentFacetTest
 * @notice T-090 v1.1 (#389) — Sub 1 baseline coverage. Validates the
 *         commit-side surface (eligibility gates + field validation
 *         + revert paths) and the read-only ERC-1271 binding without
 *         simulating a Fusion fill.
 *
 *         Out of scope for this file (lands in a separate fork test
 *         with a real Fusion mock router + EIP-712 signing rig):
 *           - Happy-path commit → cancel teardown
 *           - preInteraction → balance transfer → postInteraction
 *             waterfall (full Fusion fill simulation)
 *           - Force-cancel branches at the 7 liquidation entry points
 *             (need price-feed mutation to drive HF < 1.0 in test)
 *           - cancel + cancelExpired timing paths
 *
 *         The structural correctness of those is guaranteed by the
 *         deploy-sanity SelectorCoverageTest + the compile pass; the
 *         runtime tests follow once the Fusion mock router is built.
 */
contract SwapToRepayIntentFacetTest is SetupTest {
    // ── Tokens + parties ──────────────────────────────────────────
    ERC20Mock internal principalAsset;
    ERC20Mock internal collateralAsset;

    address internal borrowerEoa = address(0xB0B);
    address internal lenderEoa = address(0x1ED4E2);

    address internal borrowerVault;

    // ── Loan parameters ───────────────────────────────────────────
    uint256 internal constant LOAN_ID = 1;
    uint256 internal constant LOAN_PRINCIPAL = 1_000 ether;
    uint256 internal constant LOAN_COLLATERAL = 2_000 ether;
    uint256 internal constant LOAN_DURATION_DAYS = 30;
    uint256 internal constant LOAN_INTEREST_BPS = 500;

    // ── Mock Fusion LOP ───────────────────────────────────────────
    MockFusionLOP internal fusionLOP;

    function setUp() public {
        setupHelper();
        vm.warp(100 days);

        // Tokens
        principalAsset = new ERC20Mock("Principal", "PRIN", 18);
        collateralAsset = new ERC20Mock("Collateral", "COLL", 18);

        // Mock Fusion LOP
        fusionLOP = new MockFusionLOP();

        // Vault setup + collateral seed (same pattern as v1
        // SwapToRepayFacetTest)
        borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerEoa);
        collateralAsset.mint(borrowerVault, LOAN_COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerEoa,
            address(collateralAsset),
            LOAN_COLLATERAL
        );

        // Scaffold an Active ERC20-on-ERC20 loan
        _scaffoldLoan(LOAN_ID);

        // v1.1 config — enable surface + allowlist + bounds.
        IntentConfigFacet(address(diamond)).setIntentSwapToRepayEnabled(true);
        IntentConfigFacet(address(diamond)).setIntentAllowedPrincipalToken(
            address(principalAsset), true
        );
        IntentConfigFacet(address(diamond)).setIntentAllowedCollateralToken(
            address(collateralAsset), true
        );
        IntentConfigFacet(address(diamond)).setIntentMinCommitHF(1.2e18);
        IntentConfigFacet(address(diamond)).setIntentMinOutputBufferBps(200);
        IntentConfigFacet(address(diamond)).setIntentAuctionSecondsBounds(60, 600);
        IntentConfigFacet(address(diamond)).setIntentCancelGraceSeconds(86_400);
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(address(fusionLOP));
    }

    // ══════════════════════════════════════════════════════════════
    //  Config surface — happy-path reads
    // ══════════════════════════════════════════════════════════════

    function test_Config_MasterSwitchPersisted() public view {
        assertTrue(
            IntentConfigFacet(address(diamond)).getIntentSwapToRepayEnabled(),
            "master switch should be ON after setUp"
        );
    }

    function test_Config_FusionLOPPersisted() public view {
        assertEq(
            IntentConfigFacet(address(diamond)).getFusionLimitOrderProtocol(),
            address(fusionLOP)
        );
    }

    function test_Config_AllowlistsPersisted() public view {
        assertTrue(
            IntentConfigFacet(address(diamond)).getIntentAllowedPrincipalToken(address(principalAsset))
        );
        assertTrue(
            IntentConfigFacet(address(diamond)).getIntentAllowedCollateralToken(address(collateralAsset))
        );
        assertFalse(
            IntentConfigFacet(address(diamond)).getIntentAllowedPrincipalToken(address(0xCAFE))
        );
    }

    // ══════════════════════════════════════════════════════════════
    //  Commit-side revert coverage
    // ══════════════════════════════════════════════════════════════

    function test_Commit_RevertWhen_MasterSwitchOff() public {
        IntentConfigFacet(address(diamond)).setIntentSwapToRepayEnabled(false);
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayIntentFacet.IntentSurfaceDisabled.selector);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_PrincipalTokenNotAllowed() public {
        IntentConfigFacet(address(diamond)).setIntentAllowedPrincipalToken(
            address(principalAsset), false
        );
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentTokenNotAllowed.selector,
                address(principalAsset)
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_CollateralTokenNotAllowed() public {
        IntentConfigFacet(address(diamond)).setIntentAllowedCollateralToken(
            address(collateralAsset), false
        );
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentTokenNotAllowed.selector,
                address(collateralAsset)
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_DeadlineBeyondAuctionMax() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        params.deadline = uint64(block.timestamp + 6 hours); // > maxAuctionSeconds (600s)
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentOrderFieldsMismatch.selector,
                keccak256("deadline")
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_MakerTraitsMissingHasExtension() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        params.makerTraits = params.makerTraits & ~uint256(1 << 249); // strip HAS_EXTENSION
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentMakerTraitsMismatch.selector,
                keccak256("hasExtension")
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_MakerTraitsUsePermit2Set() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        params.makerTraits = params.makerTraits | uint256(1 << 248); // set USE_PERMIT2
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentMakerTraitsMismatch.selector,
                keccak256("usePermit2")
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_MakerTraitsAllowPartialFills() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        // Clear NO_PARTIAL_FILLS bit ⇒ partial fills now allowed.
        params.makerTraits = params.makerTraits & ~uint256(1 << 255);
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentMakerTraitsMismatch.selector,
                keccak256("allowPartialFills")
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    function test_Commit_RevertWhen_SaltExtensionBindingMismatch() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _validParams();
        params.salt = 0xDEADBEEF; // breaks the low-160 extensionHash binding
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentOrderFieldsMismatch.selector,
                keccak256("salt-extension-binding")
            )
        );
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    // ══════════════════════════════════════════════════════════════
    //  ERC-1271 binding — pure read
    // ══════════════════════════════════════════════════════════════

    function test_IsValidSignature_ReturnsInvalidForUnregisteredHash() public view {
        // T-087 Sub 3.B — the 1inch hooks moved to IntentDispatchFacet;
        // an unregistered orderHash has no stamped kind so the
        // dispatcher returns 0xffffffff.
        bytes4 ret = IntentDispatchFacet(address(diamond))
            .isValidSignature(bytes32(uint256(0xDEAD)), bytes(""));
        assertEq(ret, bytes4(0xffffffff), "unregistered orderHash should be invalid");
    }

    // ══════════════════════════════════════════════════════════════
    //  Read-back projection — no commit ⇒ IntentNoCommit
    // ══════════════════════════════════════════════════════════════

    function test_GetIntentCommit_RevertWhen_NoLiveCommit() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SwapToRepayIntentFacet.IntentNoCommit.selector,
                LOAN_ID
            )
        );
        SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID);
    }

    // ══════════════════════════════════════════════════════════════
    //  Force-cancel surface — onlyDiamondInternal guard
    // ══════════════════════════════════════════════════════════════

    function test_InternalForceCancelIntent_RevertWhen_DirectCall() public {
        // External callers (anyone except the diamond itself) must
        // be rejected — the force-cancel surface is for cross-facet
        // calls from the liquidation entry points.
        vm.expectRevert(SwapToRepayIntentFacet.OnlyDiamondInternal.selector);
        SwapToRepayIntentFacet(address(diamond)).internalForceCancelIntent(
            LOAN_ID, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
        );
    }

    function test_ForceCancelIntentIfHFBelowOrRevert_RevertWhen_DirectCall() public {
        vm.expectRevert(SwapToRepayIntentFacet.OnlyDiamondInternal.selector);
        SwapToRepayIntentFacet(address(diamond)).forceCancelIntentIfHFBelowOrRevert(LOAN_ID);
    }

    function test_ForceCancelIntentIfPastDefaultOrRevert_RevertWhen_DirectCall() public {
        vm.expectRevert(SwapToRepayIntentFacet.OnlyDiamondInternal.selector);
        SwapToRepayIntentFacet(address(diamond))
            .forceCancelIntentIfPastDefaultOrRevert(LOAN_ID);
    }

    // ══════════════════════════════════════════════════════════════
    //  Setup helper (mirrors v1 SwapToRepayFacetTest pattern)
    // ══════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════
    //  #2322 — the auction lot is sized to what the order asks; the rest
    //  of the collateral stays in the vault, pledged
    // ══════════════════════════════════════════════════════════════

    /// @dev Everything a successful commit needs beyond `setUp`: 1:1 oracle
    ///      prices (8-decimal feeds), a healthy HF, the loan's collateral
    ///      lien as loan initiation would have written it, and params
    ///      carrying the canonical extension the commit gate requires.
    function _armHappyCommit()
        internal
        returns (SwapToRepayIntentFacet.FusionOrderParams memory params)
    {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, address(principalAsset)), abi.encode(uint256(1e8), uint8(8)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, address(collateralAsset)), abi.encode(uint256(1e8), uint8(8)));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN_ID), abi.encode(uint256(2e18)));
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN_ID, borrowerEoa, address(collateralAsset), 0, LOAN_COLLATERAL, LibVaipakam.AssetType.ERC20
        );
        params = _validParams();
        params.extension = SwapToRepayIntentFacet(address(diamond)).canonicalExtension();
        params.salt = uint256(uint160(uint256(keccak256(params.extension))));
    }

    function _lien() internal view returns (uint256 amount) {
        (amount, ) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN_ID);
    }

    /// @dev The worst-case (slippage-capped) value of `amount` collateral at
    ///      the 1:1 test oracle — restated, not read from the code under test.
    function _floorAtParity(uint256 amount) internal view returns (uint256) {
        return (amount * (10_000 - ConfigFacet(address(diamond)).getMaxSwapToRepaySlippageBps())) / 10_000;
    }

    /// @dev The commit puts up only the lot the DEBT needs — the least
    ///      collateral whose slippage-capped oracle value covers the commit's
    ///      minimum output (the debt floor plus the auction buffer) — not the
    ///      loan's whole collateral. The rest never leaves the vault and stays
    ///      liened for the whole auction.
    function test_Commit_SizesTheLotToTheDebt() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        (uint256 lot, uint256 minTaker) = SwapToRepayIntentFacet(address(diamond)).previewSwapToRepayIntentLot(LOAN_ID);

        assertGe(_floorAtParity(lot), minTaker, "the lot covers the debt floor at the worst case");
        assertLt(_floorAtParity(lot - 1), minTaker, "and no more than the debt needs");
        assertLt(lot, LOAN_COLLATERAL, "the lot is not the whole collateral");
        assertGt(params.takerAmount, minTaker, "the fixture asks more than the minimum");

        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);

        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID).makerAmount, lot, "the order carries the lot");
        assertEq(collateralAsset.balanceOf(address(diamond)), lot, "only the lot is in Diamond custody");
        assertEq(collateralAsset.balanceOf(borrowerVault), LOAN_COLLATERAL - lot, "the rest stays in the vault");
        assertEq(_lien(), LOAN_COLLATERAL - lot, "and stays pledged");
    }

    /// @dev The borrower sets the PRICE with `takerAmount`; the lot does not
    ///      move with it. Two identical loans committed at the minimum and at
    ///      a higher ask put up the same lot — so asking more prices it higher
    ///      rather than selling more collateral.
    function test_Commit_TakerAmountSetsThePriceNotTheLot() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        (uint256 lot, uint256 minTaker) = SwapToRepayIntentFacet(address(diamond)).previewSwapToRepayIntentLot(LOAN_ID);
        params.takerAmount = minTaker * 3 / 2;
        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID).makerAmount, lot, "a higher ask does not enlarge the lot");
        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID).takerAmount, minTaker * 3 / 2, "it prices it higher");
    }

    /// @dev A fill closes the loan; what the order raised above the debt is
    ///      the borrower's surplus principal, and the borrower's collateral
    ///      claim — the part the commit never took — stays in the vault,
    ///      liened for exactly the claim (not the claim on top of the part
    ///      that was never unliened).
    function test_Fill_LeavesTheUntakenCollateralClaimableAndLienedExactlyOnce() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        vm.recordLogs();
        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
        bytes32 orderHash = _committedOrderHash();
        uint256 lot = SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID).makerAmount;
        uint256 eoaBefore = principalAsset.balanceOf(borrowerEoa);
        uint256 payoff = RepayFacet(address(diamond)).calculateRepaymentAmount(LOAN_ID);

        // Fusion's fill, as the pinned LOP runs it: preInteraction snapshots
        // the principal baseline, the resolver delivers the taking amount and
        // takes the lot, postInteraction settles.
        IOrderMixin.Order memory o;
        vm.prank(address(fusionLOP));
        IntentDispatchFacet(address(diamond)).preInteraction(o, "", orderHash, address(0), 0, 0, 0, "");
        principalAsset.mint(address(diamond), params.takerAmount);
        vm.prank(address(diamond));
        collateralAsset.transfer(address(0xF111), lot);
        vm.prank(address(fusionLOP));
        IntentDispatchFacet(address(diamond)).postInteraction(o, "", orderHash, address(0), lot, params.takerAmount, 0, "");

        assertEq(uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN_ID).status), uint256(LibVaipakam.LoanStatus.Repaid), "the fill closes the loan");
        assertEq(principalAsset.balanceOf(borrowerEoa) - eoaBefore, params.takerAmount - payoff, "the ask above the debt is the borrower's surplus");
        (, uint256 claimAmt, , , , , , ) = ClaimFacet(address(diamond)).getClaimable(LOAN_ID, false);
        assertEq(claimAmt, LOAN_COLLATERAL - lot, "the borrower can claim every unit the fill did not take");
        assertEq(collateralAsset.balanceOf(borrowerVault), LOAN_COLLATERAL - lot, "and it is all in the vault");
        assertEq(_lien(), LOAN_COLLATERAL - lot, "liened exactly once, for exactly the claim");
    }

    /// @dev A cancel returns the lot and restores the lien to the whole
    ///      collateral — the loan is back exactly as it was before the commit.
    function test_Cancel_RestoresTheWholeCollateralAndLien() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
        vm.warp(params.deadline + 1);
        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).cancelSwapToRepayIntent(LOAN_ID);

        assertEq(collateralAsset.balanceOf(borrowerVault), LOAN_COLLATERAL, "the whole collateral is back in the vault");
        assertEq(_lien(), LOAN_COLLATERAL, "and the whole of it is pledged again");
        assertEq(collateralAsset.balanceOf(address(diamond)), 0, "nothing left in custody");
    }

    /// @dev When even the whole collateral, at the slippage floor, cannot
    ///      cover the debt floor, no lot can back a repayment: refused before
    ///      anything moves.
    function test_Commit_RevertWhen_WholeCollateralCannotCoverTheDebtFloor() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        // Collateral repriced to $0.50: 2,000 collateral is worth 970 at the
        // 3% floor, below the ~1,020 debt floor plus buffer.
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, address(collateralAsset)), abi.encode(uint256(0.5e8), uint8(8)));
        vm.prank(borrowerEoa);
        vm.expectPartialRevert(SwapToRepayIntentFacet.IntentCollateralCannotCoverDebtFloor.selector);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
    }

    /// @dev A loan whose collateral is committed to a live auction is never an
    ///      internal-match candidate: part of its collateral is owed to the
    ///      order and the rest backs the borrower's post-settlement claim.
    ///      The precondition row proves the same loan IS a candidate before
    ///      the commit, so the post-commit row cannot pass vacuously.
    function test_LiveIntent_IsNeverAnInternalMatchCandidate() public {
        SwapToRepayIntentFacet.FusionOrderParams memory params = _armHappyCommit();
        // Index both loans the way loan initiation would, with a liquidation
        // floor below SetupTest's mocked LTV so each is match-eligible.
        LibVaipakam.Loan memory a = LoanFacet(address(diamond)).getLoanDetails(LOAN_ID);
        a.id = LOAN_ID;
        a.liquidationLtvBpsAtInit = 6_000;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN_ID, a);
        LibVaipakam.Loan memory b = a;
        b.id = 2;
        b.principalAsset = address(collateralAsset);
        b.collateralAsset = address(principalAsset);
        b.lenderTokenId = 3;
        b.borrowerTokenId = 4;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(2, b);
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(uint256(6_666)));
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        (bool found, uint256 cid) = MetricsFacet(address(diamond)).hasInternalMatchCandidate(2);
        assertTrue(found && cid == LOAN_ID, "precondition: before the commit the loan IS a candidate");

        vm.prank(borrowerEoa);
        SwapToRepayIntentFacet(address(diamond)).commitSwapToRepayIntent(LOAN_ID, params);
        (found, cid) = MetricsFacet(address(diamond)).hasInternalMatchCandidate(2);
        assertFalse(found && cid == LOAN_ID, "with a live auction it is not");
    }

    /// @dev The committed order's hash, read from the commit event
    ///      (`topics[2]` — `orderHash` is the second indexed parameter). Requires `vm.recordLogs()` before
    ///      the commit.
    function _committedOrderHash() internal returns (bytes32) {
        bytes32 sig = SwapToRepayIntentFacet.SwapToRepayIntentCommitted.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 1 && logs[i].topics[0] == sig) return logs[i].topics[2];
        }
        revert("no SwapToRepayIntentCommitted event");
    }

    function _scaffoldLoan(uint256 loanId) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            lenderEoa, /* tokenId */ loanId * 2 - 1
        );
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            borrowerEoa, /* tokenId */ loanId * 2
        );

        LibVaipakam.Loan memory loan;
        loan.principal = LOAN_PRINCIPAL;
        loan.principalAsset = address(principalAsset);
        loan.collateralAmount = LOAN_COLLATERAL;
        loan.collateralAsset = address(collateralAsset);
        loan.lender = lenderEoa;
        loan.borrower = borrowerEoa;
        loan.startTime = uint64(block.timestamp - 1 days);
        loan.durationDays = uint16(LOAN_DURATION_DAYS);
        loan.interestRateBps = uint16(LOAN_INTEREST_BPS);
        loan.lenderTokenId = uint128(loanId * 2 - 1);
        loan.borrowerTokenId = uint128(loanId * 2);
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.assetType = LibVaipakam.AssetType.ERC20;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC20;
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    /// @dev Builds a `FusionOrderParams` that passes every field +
    ///      bit check the facet enforces at commit. Tests mutate
    ///      individual fields to exercise specific reverts.
    function _validParams()
        internal
        view
        returns (SwapToRepayIntentFacet.FusionOrderParams memory params)
    {
        uint64 deadline = uint64(block.timestamp + 300);
        bytes memory extension = abi.encodePacked(address(diamond));
        bytes32 extHash = keccak256(extension);
        uint256 salt = uint256(uint160(uint256(extHash)));
        uint256 mt = (1 << 249)   // HAS_EXTENSION
            | (1 << 252)          // PRE_INTERACTION_CALL
            | (1 << 251)          // POST_INTERACTION_CALL
            | (1 << 255);         // NO_PARTIAL_FILLS
        mt |= (uint256(deadline) << 80); // expiration sub-field

        uint256 takerAmount = (LOAN_PRINCIPAL * 12_000) / 10_000;

        params = SwapToRepayIntentFacet.FusionOrderParams({
            takerAmount: takerAmount,
            deadline: deadline,
            salt: salt,
            makerTraits: mt,
            extension: extension
        });
    }
}

// ══════════════════════════════════════════════════════════════════
//  Minimal Fusion LOP mock — answers the calls the facet makes
//  during commit + cancel paths
// ══════════════════════════════════════════════════════════════════

contract MockFusionLOP {
    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return keccak256("MockFusionLOP-v1");
    }

    function rawRemainingInvalidatorForOrder(
        address /* maker */, bytes32 /* orderHash */
    ) external pure returns (uint256) {
        return 0; // never-filled
    }

    function cancelOrder(uint256 /* makerTraits */, bytes32 /* orderHash */) external pure {
        // no-op
    }
}
