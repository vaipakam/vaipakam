// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
