// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title SwapToRepayFacetTest
 * @notice T-090 — Coverage for the borrower-initiated swap-to-repay
 *         surface (see `docs/DesignsAndPlans/SwapToRepay.md` §12 for
 *         the case list). Inherits `SetupTest` which already cuts
 *         the production diamond shape; the swap-to-repay facet is
 *         on `cuts[44]` (wired in SetupTest after this PR's producer-
 *         artifact updates).
 *
 *         Test ergonomics:
 *           - One `MockSwapAdapter` registered via `AdminFacet.addSwapAdapter`.
 *             A second adapter is registered for the failover case.
 *           - The adapter is pre-funded with `principalAsset` so it can
 *             pay out on `execute()`. Output ratio is configured via
 *             `setOutputMultiplierBps`.
 *           - `OracleFacet.getAssetPrice` is `vm.mockCall`-ed so
 *             `LibFallback.expectedSwapOutput` returns a known value.
 *             Both assets use the same price (1:1) and same decimals
 *             (18) for cleanly checkable arithmetic.
 *           - Active loans are seeded via `TestMutatorFacet.setLoan`
 *             — bypasses the full offer/accept dance which would pull
 *             in unrelated invariants. The collateral itself is
 *             pre-deposited into the borrower's vault via `vaultDepositERC20`.
 */
contract SwapToRepayFacetTest is SetupTest {
    // ── Test fixtures ─────────────────────────────────────────────
    ERC20Mock internal principalAsset;
    ERC20Mock internal collateralAsset;
    MockSwapAdapter internal adapter1;
    MockSwapAdapter internal adapter2;

    address internal borrowerEoa = address(0xB0B);
    address internal lenderEoa = address(0x1ED4E2);

    address internal borrowerVault;
    address internal lenderVault;

    uint256 internal constant LOAN_PRINCIPAL = 1_000 ether;
    uint256 internal constant LOAN_COLLATERAL = 2_000 ether; // 200% collateralization
    uint256 internal constant LOAN_DURATION_DAYS = 30;
    uint256 internal constant LOAN_INTEREST_BPS = 500; // 5%

    function setUp() public {
        setupHelper();

        // Warp forward so `_scaffoldLoan`'s `block.timestamp - 1 days`
        // doesn't underflow against Foundry's default block.timestamp = 1.
        vm.warp(100 days);

        // ── Tokens ───────────────────────────────────────────────
        principalAsset = new ERC20Mock("Principal", "PRIN", 18);
        collateralAsset = new ERC20Mock("Collateral", "COLL", 18);

        // ── Vaults provisioned + collateral seeded ───────────────
        // `vaultDepositERC20` is `onlyDiamondInternal` so we can't
        // route through it from a test. Pattern: mint directly to
        // the vault proxy + stamp `protocolTrackedVaultBalance` via
        // the TestMutator raw-setter so subsequent `vaultWithdrawERC20`
        // doesn't underflow the counter (see LibVaipakam:5012).
        borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerEoa);
        lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lenderEoa);

        ERC20Mock(address(collateralAsset)).mint(borrowerVault, LOAN_COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerEoa,
            address(collateralAsset),
            LOAN_COLLATERAL
        );

        // ── Oracle: 1:1 price, 8-decimal feed (Chainlink-shape) ──
        // Both assets `getAssetPrice` returns (1e8, 8) so expected
        // proceeds == collateralAmount × (10^18-prinTokenDec) /
        // (10^18-colTokenDec) == collateralAmount (identity).
        _mockAssetPrice(address(principalAsset), 1e8, 8);
        _mockAssetPrice(address(collateralAsset), 1e8, 8);

        // ── Swap adapters: register two, fund both ───────────────
        adapter1 = new MockSwapAdapter("adapter1");
        adapter2 = new MockSwapAdapter("adapter2");
        ERC20Mock(address(principalAsset)).mint(address(adapter1), 10_000 ether);
        ERC20Mock(address(principalAsset)).mint(address(adapter2), 10_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter1));
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter2));
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Helpers
    // ── ─────────────────────────────────────────────────────── ──

    function _mockAssetPrice(address asset, uint256 price, uint8 feedDecimals) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, feedDecimals)
        );
    }

    /// @dev Build a vanilla Active ERC20-on-ERC20 loan. Mints the
    ///      lender+borrower position NFTs (so the lender ownership
    ///      check passes), stamps `Loan` state via TestMutatorFacet,
    ///      and starts the accrual clock 1 day before block.timestamp
    ///      so a small pro-rata interest is accrued by default.
    function _scaffoldLoan(
        uint256 loanId,
        bool allowsPartialRepay,
        bool useFullTermInterest
    ) internal {
        // Mint position NFTs to the EOAs. The lender NFT ownership
        // check is the lender-self-repay guard's authority root.
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            lenderEoa,
            /* tokenId */ loanId * 2 - 1
        );
        TestMutatorFacet(address(diamond)).mintNFTRaw(
            borrowerEoa,
            /* tokenId */ loanId * 2
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
        loan.allowsPartialRepay = allowsPartialRepay;
        loan.useFullTermInterest = useFullTermInterest;
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        // #394 Lever A (Codex #647 round-6) — a real admitted loan carries a
        // positive snapshotted init-LTV cap; stamp 80% so the post-swap
        // LTV-cap re-check in `swapToRepayPartial` has a realistic ceiling
        // (the partial paths leave the loan well under it).
        loan.initLtvCapBpsAtInit = 8000;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    /// @dev Returns a try-list pointing at our `MockSwapAdapter` registered
    ///      in setUp. `setupHelper()` pre-registers a `MockZeroExLegacyAdapter`
    ///      at index 0, so `adapter1` is at index 1 and `adapter2` at index 2.
    function _adapterTryList(uint256 adapterOneOrTwo) internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: adapterOneOrTwo, data: ""});
    }

    /// @dev Try-list that hits adapter1 (index 1) first, then adapter2
    ///      (index 2). Used for the failover test.
    function _twoAdapterFailoverList() internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](2);
        calls[0] = LibSwap.AdapterCall({adapterIdx: 1, data: ""});
        calls[1] = LibSwap.AdapterCall({adapterIdx: 2, data: ""});
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #1 — Full happy path
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_HappyPath() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000); // 1:1 swap

        uint256 lenderBalBefore = IERC20(address(principalAsset)).balanceOf(lenderVault);

        // Use enough collateral to cover principal + pro-rata interest
        // (1 day × 5% × 1000 / 365 ≈ 0.137 ether) plus treasury cut.
        // 1100 ether is comfortably above debt + 3% slippage cap.
        uint256 maxCollateralIn = 1_100 ether;

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            maxCollateralIn
        );

        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "loan must transition to Repaid"
        );
        assertGt(
            IERC20(address(principalAsset)).balanceOf(lenderVault),
            lenderBalBefore,
            "lender vault must receive principal+interest"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #4 — Partial happy path
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayPartial_HappyPath() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ true, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Partial reduction of ~200 ether principal — well within
        // the min-partial floor (default 0 if not configured).
        uint256 collateralSwapAmount = 250 ether;

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayPartial(
            1,
            collateralSwapAmount,
            _adapterTryList(1)
        );

        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Active),
            "loan stays Active on partial"
        );
        assertLt(
            loanAfter.principal,
            LOAN_PRINCIPAL,
            "principal must be reduced"
        );
        assertLt(
            loanAfter.collateralAmount,
            LOAN_COLLATERAL,
            "collateralAmount must be reduced (Codex P1 #4)"
        );
        assertEq(
            loanAfter.collateralAmount,
            LOAN_COLLATERAL - collateralSwapAmount,
            "collateralAmount reduction must equal swap input"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #5 — Partial blocked when allowsPartialRepay = false
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayPartial_RevertWhen_AllowsPartialRepayFalse() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);

        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayFacet.PartialRepayNotAllowed.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayPartial(
            1,
            250 ether,
            _adapterTryList(1)
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #7 — Slippage cap rejection (pre-flight bounds)
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_RevertWhen_SlippageFloorBelowRequired() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        // maxCollateralIn just barely covers the principal but not
        // even principal + slippage cap. expectedProceeds at 1:1 is
        // 1000 ether, slippage-floored to 970 (3% cap), but required
        // debt is ~1011 ether (principal + interest + treasury cut).
        uint256 maxCollateralIn = 1_000 ether;

        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayFacet.SwapBoundsInsufficient.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            maxCollateralIn
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #8 — Adapter failover (first adapter reverts, second wins)
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_AdapterFailover() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setShouldRevert(true);
        adapter2.setOutputMultiplierBps(10_000);

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _twoAdapterFailoverList(),
            1_100 ether
        );

        // adapter1's `callCount += 1` rolled back with its revert in the
        // try/catch — only commit-side state survives. adapter2's
        // committed call ticks the counter, and the loan transitioning
        // to Repaid proves the swap landed via adapter2 (not adapter1).
        assertEq(adapter2.callCount(), 1, "second adapter committed");
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "loan repaid via failover to adapter2"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #9 — Total swap failure reverts (no soft fallback)
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_RevertWhen_AllAdaptersFail() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setShouldRevert(true);
        adapter2.setShouldRevert(true);

        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayFacet.SwapAllAdaptersFailed.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _twoAdapterFailoverList(),
            1_100 ether
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #10 — Past-grace block
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_RevertWhen_PastGrace() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        // Jump well past grace-end (durationDays + gracePeriod).
        vm.warp(block.timestamp + 365 days);

        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayFacet.RepaymentPastGracePeriod.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            1_100 ether
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #13 — Non-borrower caller rejection
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_RevertWhen_NonBorrowerCaller() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        address randomCaller = address(0xDEADBEEF);

        vm.prank(randomCaller);
        // LibAuth.requireBorrower reverts with NotBorrower.
        vm.expectRevert();
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            1_100 ether
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #11 — Lender self-repay block
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_RevertWhen_LenderSelfRepay() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        // Degenerate case: the lender ALSO owns the borrower-side
        // position NFT (e.g. acquired it via secondary trade) AND
        // is still the lender. The borrower-NFT-owner gate (Codex
        // PR #390 P1 #3) passes for them, so the lender-self-repay
        // guard is the load-bearing block here.
        // Move the borrower NFT (tokenId 2) to lenderEoa via burn+mint
        // (the test diamond doesn't cut `transferFrom`; the production
        // diamond does) and flip `loan.borrower` to lenderEoa so both
        // gates target the same address.
        TestMutatorFacet(address(diamond)).burnNFTRaw(2);
        TestMutatorFacet(address(diamond)).mintNFTRaw(lenderEoa, 2);
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        loan.borrower = lenderEoa;
        TestMutatorFacet(address(diamond)).setLoan(1, loan);

        vm.prank(lenderEoa);
        vm.expectRevert(IVaipakamErrors.LenderCannotRepayOwnLoan.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            1_100 ether
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Codex P2 #3 — Partial swap that would retire full principal
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayPartial_RevertWhen_WouldRetireFullPrincipal() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ true, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Pass the full collateral amount as swap input. The proceeds
        // would cover the entire principal — the partial path must
        // refuse and direct the borrower to swapToRepayFull instead.
        vm.prank(borrowerEoa);
        vm.expectRevert(SwapToRepayFacet.PartialWouldRetireFullPrincipal.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayPartial(
            1,
            LOAN_COLLATERAL,
            _adapterTryList(1)
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #15 — Surplus principal routes to borrower vault
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_SurplusPrincipalToBorrowerEoa() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        // 1:1 quote, 1500 collateral → 1500 principal. Debt is ~1011
        // ether. Surplus ≈ 489 ether goes direct-to-EOA (Codex round-4
        // P1 #2 — vault routing leaves the surplus unclaimable because
        // ClaimFacet only releases the collateral asset).
        adapter1.setOutputMultiplierBps(10_000);
        uint256 borrowerEoaPrincipalBefore = IERC20(address(principalAsset)).balanceOf(borrowerEoa);
        uint256 maxCollateralIn = 1_500 ether;

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            maxCollateralIn
        );

        uint256 borrowerEoaPrincipalAfter = IERC20(address(principalAsset)).balanceOf(borrowerEoa);
        assertGt(
            borrowerEoaPrincipalAfter,
            borrowerEoaPrincipalBefore,
            "borrower EOA must receive surplus principal directly"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // Test #16 — Residual collateral claim slot (Codex P1 #2)
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_ResidualCollateralRecordedInClaim() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);
        // Swap only 1100 of 2000 collateral; 900 stays in vault.
        uint256 maxCollateralIn = 1_100 ether;

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(
            1,
            _adapterTryList(1),
            maxCollateralIn
        );

        // The diamond never withdrew the unswapped 900 ether; it
        // stays in the borrower's vault and the claim slot records
        // its amount (per Codex P1 #2).
        // The exact claim assertion would need to query the s.borrowerClaims
        // mapping via a public getter — we assert the vault balance
        // instead which reflects the same invariant from the other side.
        assertEq(
            IERC20(address(collateralAsset)).balanceOf(borrowerVault),
            LOAN_COLLATERAL - maxCollateralIn,
            "unswapped collateral stays in borrower vault"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (Codex #981) — sanctioned swap-surplus freeze: no-vault
    // transferee must not brick (P1); frozen surplus stays claimable (P2)
    // ── ─────────────────────────────────────────────────────── ──

    /// @dev Re-home the borrower position NFT (tokenId 2) to `to` while it is
    ///      still clean (mirrors the finding's "then-clean wallet" precondition),
    ///      then wire a sanctions oracle and flag `to`. `to` ends up the current,
    ///      vault-less, sanctioned borrower-NFT holder. Uses burn+remint via the
    ///      mutator (the test diamond doesn't cut the public ERC721 transferFrom;
    ///      burn+remint is equivalent for `ownerOf`, which is all the surplus
    ///      freeze reads).
    function _transferBorrowerNftThenSanction(address to)
        internal
        returns (MockSanctionsList sanctions)
    {
        TestMutatorFacet(address(diamond)).burnNFTRaw(/* tokenId */ 2);
        TestMutatorFacet(address(diamond)).mintNFTRaw(to, /* tokenId */ 2);
        sanctions = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctions));
        sanctions.setFlagged(to, true);
    }

    /// @dev P1 — a sanctioned current holder that never created a vault must NOT
    ///      brick `swapToRepayFull`. The old code froze the surplus into the
    ///      HOLDER's vault under the receive exemption, which refuses to mint a
    ///      vault for a flagged wallet (`SanctionedRecipientHasNoVault`) and
    ///      reverted the whole must-complete close-out. The surplus is now frozen
    ///      into `loan.borrower`'s (always-present) vault, so the close-out
    ///      completes and the flagged holder is NOT paid directly.
    function test_swapToRepayFull_SanctionedVaultlessHolder_DoesNotBrick() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000); // 1:1 → a positive surplus

        address holder = makeAddr("v954VaultlessHolder");
        _transferBorrowerNftThenSanction(holder);
        assertEq(
            VaultFactoryFacet(address(diamond)).getUserVaultAddress(holder),
            address(0),
            "holder never created a vault"
        );

        uint256 holderBefore = IERC20(address(principalAsset)).balanceOf(holder);

        // MUST complete (no SanctionedRecipientHasNoVault brick).
        vm.prank(holder);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_500 ether);

        // Surplus withheld from the flagged holder, not handed to their EOA.
        assertEq(
            IERC20(address(principalAsset)).balanceOf(holder),
            holderBefore,
            "flagged holder is not paid the surplus directly"
        );
        // And it is NOT lost — still owned by the (clean) stored borrower's vault.
        assertGt(
            IERC20(address(principalAsset)).balanceOf(borrowerVault),
            0,
            "frozen surplus is parked in loan.borrower's vault"
        );
    }

    /// @dev Codex #1122-rework r1 P1 — a PREVIOUSLY-confirmed-flagged holder (in
    ///      the #1123 registry) must have their swap surplus FROZEN even when the
    ///      close-out lands during an oracle OUTAGE. The old fail-open decision
    ///      would take the direct-EOA-transfer branch during the outage; the new
    ///      `mustFreezeParty` predicate stays fail-closed on the prior confirmation.
    function test_swapToRepayFull_RegisteredHolderDuringOutage_SurplusFrozen() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000); // 1:1 → a positive surplus

        address holder = makeAddr("s10OutageSurplusHolder");
        MockSanctionsList sanctions = _transferBorrowerNftThenSanction(holder);
        // Confirm + register the holder while the oracle is UP.
        ProfileFacet(address(diamond)).refreshSanctionsFlag(holder);
        // Oracle goes DOWN before the close-out.
        sanctions.setRevertOnRead(true);

        uint256 holderBefore = IERC20(address(principalAsset)).balanceOf(holder);

        vm.prank(holder);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_500 ether);

        // Fail-closed: the freeze branch ran (the surplus is parked behind the
        // claim gate and the fail-closed marker is stamped for the registered
        // holder), NOT the direct-EOA-transfer branch — proven by both the marker
        // and the holder's EOA balance being untouched during the outage.
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(1, false),
            holder,
            "outage: registered holder's surplus frozen (marker stamped)"
        );
        assertEq(
            IERC20(address(principalAsset)).balanceOf(holder),
            holderBefore,
            "outage: registered holder not paid the surplus directly"
        );
    }

    /// @dev P2 — the frozen surplus must remain claimable. While flagged the
    ///      holder can't claim (Tier-1 claim gate); once delisted, the surplus is
    ///      withdrawable to their EOA via `claimAsBorrower` (a bare vault balance
    ///      would have had no principal-asset claim path).
    function test_swapToRepayFull_FrozenSurplusClaimableAfterDelisting() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        address holder = makeAddr("v954ClaimHolder");
        MockSanctionsList sanctions = _transferBorrowerNftThenSanction(holder);

        vm.prank(holder);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_500 ether);

        // Still flagged → the whole borrower claim (collateral + surplus) is gated.
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, holder)
        );
        ClaimFacet(address(diamond)).claimAsBorrower(1);

        // Delist → the frozen surplus is now realizable to the holder's EOA.
        sanctions.setFlagged(holder, false);
        uint256 holderBefore = IERC20(address(principalAsset)).balanceOf(holder);
        vm.prank(holder);
        ClaimFacet(address(diamond)).claimAsBorrower(1);
        assertGt(
            IERC20(address(principalAsset)).balanceOf(holder),
            holderBefore,
            "delisted holder receives the frozen surplus principal"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (§1.1) — flagged LENDER leg must not brick; proceeds frozen
    //               in the lender vault and claimable after delisting
    // ── ─────────────────────────────────────────────────────── ──

    /// @dev Wire a sanctions oracle and flag `who`. Returns the mock so the
    ///      caller can later delist.
    function _wireSanctionsAndFlag(address who)
        internal
        returns (MockSanctionsList sanctions)
    {
        sanctions = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctions));
        sanctions.setFlagged(who, true);
    }

    function test_swapToRepayFull_SanctionedLenderLeg_DoesNotBrick_FrozenClaimable()
        public
    {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Lender flagged AFTER init; borrower (clean) closes via swap.
        MockSanctionsList sanctions = _wireSanctionsAndFlag(lenderEoa);
        uint256 lenderVaultBefore =
            IERC20(address(principalAsset)).balanceOf(lenderVault);

        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_500 ether);

        // Close-out completes despite the flagged lender.
        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "close completes with a flagged lender (freeze-at-source, not brick)"
        );
        // Lender proceeds are parked (frozen) in the stored lender's vault.
        assertGt(
            IERC20(address(principalAsset)).balanceOf(lenderVault),
            lenderVaultBefore,
            "lender proceeds parked in lender vault"
        );

        // Flagged lender can't claim; delist → claim pays out.
        vm.prank(lenderEoa);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lenderEoa)
        );
        ClaimFacet(address(diamond)).claimAsLender(1);

        sanctions.setFlagged(lenderEoa, false);
        uint256 lenderEoaBefore = IERC20(address(principalAsset)).balanceOf(lenderEoa);
        vm.prank(lenderEoa);
        ClaimFacet(address(diamond)).claimAsLender(1);
        assertGt(
            IERC20(address(principalAsset)).balanceOf(lenderEoa),
            lenderEoaBefore,
            "delisted lender claims the frozen proceeds"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (§1.2) — flagged SELF borrower-holder: the collateral pull
    //               runs under the move-out exemption and must not brick
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_SanctionedSelfBorrower_CollateralPull_DoesNotBrick()
        public
    {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Borrower still holds their own position NFT and is flagged after init.
        _wireSanctionsAndFlag(borrowerEoa);

        // MUST complete: `getOrCreateUserVault(borrowerEoa)` inside the collateral
        // withdraw would revert `SanctionedAddress` without the move-out exemption.
        vm.prank(borrowerEoa);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_100 ether);

        LibVaipakam.Loan memory loanAfter = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            uint256(loanAfter.status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "self-flagged borrower close-out completes (collateral pull move-out)"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (§1.3) — swapToRepayPartial hard-SCREENS the direct payees
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayPartial_RevertWhen_LenderHolderSanctioned() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ true, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        _wireSanctionsAndFlag(lenderEoa);

        // Discretionary path → Tier-1 screen on the lender payee, hard revert.
        vm.prank(borrowerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lenderEoa)
        );
        SwapToRepayFacet(address(diamond)).swapToRepayPartial(1, 250 ether, _adapterTryList(1));
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (§2.4) — surplus-only close keeps the loan un-Settled until
    //               the borrower claims the frozen surplus
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_SurplusOnly_LenderFirstClaim_DoesNotSettle() public {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Sanctioned transferee holder so the surplus is FROZEN (records a
        // borrowerSurplusClaims row); consume ALL collateral so borrowerClaims
        // is empty and only the surplus lane remains.
        address holder = makeAddr("v954SurplusOnlyHolder");
        MockSanctionsList sanctions = _transferBorrowerNftThenSanction(holder);

        vm.prank(holder);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), LOAN_COLLATERAL);

        // A pending surplus row exists; collateral claim is empty.
        (, uint256 surplusAmt, bool surplusClaimed) =
            ClaimFacet(address(diamond)).getBorrowerSurplusClaim(1);
        assertGt(surplusAmt, 0, "surplus frozen for the delistable holder");
        assertEq(surplusClaimed, false, "surplus not yet claimed");

        // Lender claims first — the loan must STAY un-Settled (pending surplus).
        vm.prank(lenderEoa);
        ClaimFacet(address(diamond)).claimAsLender(1);
        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(1).status),
            uint256(LibVaipakam.LoanStatus.Repaid),
            "surplus-only loan stays un-Settled after the lender claim"
        );

        // Delist + borrower claims the surplus → loan settles.
        sanctions.setFlagged(holder, false);
        vm.prank(holder);
        ClaimFacet(address(diamond)).claimAsBorrower(1);
        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(1).status),
            uint256(LibVaipakam.LoanStatus.Settled),
            "loan settles once the frozen surplus is claimed"
        );
    }

    // ── ─────────────────────────────────────────────────────── ──
    // #954 (§2.2) — a frozen VPFI surplus owed to a transferred, sanctioned
    //               holder is EXCLUDED from the stored borrower's fee tier
    // ── ─────────────────────────────────────────────────────── ──

    function test_swapToRepayFull_FrozenVpfiSurplus_ExcludedFromStoredBorrowerTier()
        public
    {
        _scaffoldLoan(1, /* allowsPartialRepay */ false, /* useFullTermInterest */ false);
        adapter1.setOutputMultiplierBps(10_000);

        // Make the principal asset BE the VPFI token so the frozen surplus is
        // VPFI and flows through the tier machinery.
        TestMutatorFacet(address(diamond)).setVpfiTokenRaw(address(principalAsset));

        // Sanctioned transferee holder → the surplus is frozen into the stored
        // borrower's (borrowerEoa's) vault and the frozen-owed counter is bumped.
        address holder = makeAddr("v954TierHolder");
        _transferBorrowerNftThenSanction(holder);

        vm.prank(holder);
        SwapToRepayFacet(address(diamond)).swapToRepayFull(1, _adapterTryList(1), 1_500 ether);

        // Raw tracked VPFI in the stored borrower's vault IS the frozen surplus...
        uint256 rawTracked =
            VPFIDiscountFacet(address(diamond)).getTrackedVPFIBalance(borrowerEoa);
        assertGt(rawTracked, 0, "frozen VPFI surplus sits in the stored borrower's tracked balance");

        // ...but the tier-adjusted balance excludes it (owed to the delistable
        // holder, not the vault owner) — threshold-independent proof that
        // `tierVpfiBalance` subtracted `frozenVpfiOwedByVault`.
        (uint8 tier, uint256 tierAdjustedBal, ) =
            VPFIDiscountFacet(address(diamond)).getTrackedVPFIDiscountTier(borrowerEoa);
        assertEq(
            tierAdjustedBal,
            0,
            "frozen-owed VPFI is excluded from the stored borrower's tier balance"
        );
        assertEq(tier, 0, "excluded balance yields tier 0");
    }
}
