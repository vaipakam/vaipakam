// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibBackstopOracleGate} from "../src/libraries/LibBackstopOracleGate.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";

/**
 * @title  BackstopAbsorbTest
 * @notice #399 / #401 v2.5 — backstop Role B (liquidator-of-last-resort).
 *         A FallbackPending loan whose lender opts into the cash exit is bought
 *         out by the keeper-executed `claimAsLenderViaBackstop`: the current
 *         lender-NFT owner is paid `lenderPrincipalDue` from the absorb-cash
 *         bucket, the backstop warehouses the lender collateral slice, and the
 *         treasury / borrower slices route normally. Plus the par-guard,
 *         cap, kill-switch, opt-in, and exposure-release paths.
 *
 * @dev    Reuses the InternalMatchExecution scaffolding pattern: seed an Active
 *         loan via TestMutatorFacet, populate a FallbackSnapshot, transition to
 *         FallbackPending, and mock the position NFT. `owner` holds KEEPER_ROLE
 *         (granted at init) so it doubles as the designated keeper. $1/18-dec
 *         oracle ⇒ the snapshot's 1:1 collateral≡principal equivalence holds.
 */
contract BackstopAbsorbTest is SetupTest {
    address internal vault;

    uint256 internal constant LOAN = 7001;
    uint256 internal constant SEED_CASH = 10_000 ether;
    uint256 internal constant CAP = 100_000 ether;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;
    // FallbackSnapshot split (sums to COLLATERAL). 1:1 oracle ⇒ due == lenderCol.
    uint256 internal constant LENDER_COL = 550 ether;
    uint256 internal constant TREASURY_COL = 10 ether;
    uint256 internal constant BORROWER_COL = 440 ether;
    uint256 internal constant DUE = 550 ether;

    function setUp() public {
        setupHelper();

        vm.startPrank(owner);
        // Provision the backstop vault (Role A PR1 prerequisite).
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        // Role B governance: enable master + absorb, set the cap, seed cash.
        BackstopFacet(address(diamond)).setBackstopEnabled(true);
        BackstopFacet(address(diamond)).setBackstopAbsorbEnabled(true);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20,
            mockCollateralERC20,
            CAP
        );
        vm.stopPrank();

        _seedAbsorbCash(SEED_CASH);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _seedAbsorbCash(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.startPrank(owner);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, amount);
        BackstopFacet(address(diamond)).seedBackstopAbsorb(
            mockERC20,
            mockCollateralERC20,
            amount
        );
        vm.stopPrank();
    }

    /// @dev Scaffold an Active loan (lends mockERC20 vs mockCollateralERC20).
    function _seedLoan(uint256 id, address lender_, address borrower_) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = mockERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = mockCollateralERC20;
        l.collateralAmount = COLLATERAL;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower_
        );
        ERC20Mock(mockCollateralERC20).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, COLLATERAL
        );
    }

    /// @dev Move the seeded loan into FallbackPending with the Diamond holding
    ///      the collateral and a snapshot recorded (`lenderCol` overridable for
    ///      the par-guard test).
    function _moveToFallbackPending(
        uint256 id,
        address borrower_,
        uint256 lenderCol
    ) internal {
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower_
        );
        vm.prank(bVault);
        IERC20(mockCollateralERC20).transfer(address(diamond), COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, 0
        );
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderCol,
            treasuryCollateral: TREASURY_COL,
            borrowerCollateral: BORROWER_COL,
            lenderPrincipalDue: DUE,
            treasuryPrincipalDue: TREASURY_COL,
            active: true,
            // Simulate a prior claimAsLenderWithRetry having attempted the
            // objective swap (so the empty-retryCalls absorb path is allowed —
            // the dedicated retry-required gate is covered separately).
            retryAttempted: true
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(id, snap);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            id,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.FallbackPending
        );
    }

    /// @dev Mock the lender position NFT: `ownerOf(lenderTokenId)` → owner_, and
    ///      the void updateNFTStatus / burnNFT cross-facet calls no-op.
    function _mockLenderNft(uint256 id, address owner_) internal {
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(id).lenderTokenId;
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId),
            abi.encode(owner_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            ""
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            ""
        );
    }

    /// @dev Full FallbackPending fixture with the lender opted into the cash exit.
    function _fallbackOptedIn(address lender_, address borrower_) internal {
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
    }

    function _emptyRetry() internal pure returns (LibSwap.AdapterCall[] memory) {
        return new LibSwap.AdapterCall[](0);
    }

    // ─── opt-in ───────────────────────────────────────────────────────────────

    function test_optIn_byNftOwner() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
        // (no revert) — flag set; exercised by the absorb happy path.
    }

    function test_optIn_notNftOwner_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(); // NotNFTOwner (LibAuth)
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
    }

    // ─── #638 — backstop-only oracle-coverage gate (Role B) ─────────────────

    /// @dev Knob = 2 but only 1 live secondary ⇒ Role B refuses to warehouse
    ///      the collateral with treasury cash.
    function test_absorb_coverageInsufficient_reverts() public {
        vm.prank(owner);
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(2);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.countLiveSecondaryOracleFeeds.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(1))
        );
        _fallbackOptedIn(makeAddr("lender7"), makeAddr("borrower7"));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopOracleGate.BackstopOracleCoverageInsufficient.selector,
                mockCollateralERC20,
                uint8(1),
                uint8(2)
            )
        );
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    /// @dev Knob default 0 ⇒ absorb proceeds regardless of coverage (covered by
    ///      the happy path below, asserted explicitly here for the gate).
    function test_absorb_coverageKnobOff_absorbs() public {
        assertEq(
            BackstopFacet(address(diamond))
                .getBackstopMinSecondaryOracleCoverage(),
            0,
            "knob off by default"
        );
        _fallbackOptedIn(makeAddr("lender7b"), makeAddr("borrower7b"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
        // Reaching here without the coverage revert proves the no-op path.
    }

    // ─── absorb happy path ──────────────────────────────────────────────────

    function test_absorb_paysCashToOwner_warehousesCollateral() public {
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        _fallbackOptedIn(lender_, borrower_);

        uint256 ownerCashBefore = IERC20(mockERC20).balanceOf(lender_);
        uint256 treasuryColBefore =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20);
        address bsVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(vault);
        uint256 bsColBefore = IERC20(mockCollateralERC20).balanceOf(bsVault);

        // owner holds KEEPER_ROLE (granted at init) → it is the designated keeper.
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        // Lender (NFT owner) paid cash = lenderPrincipalDue.
        assertEq(IERC20(mockERC20).balanceOf(lender_) - ownerCashBefore, DUE, "cash to owner");
        // Backstop warehouses the lender collateral slice.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(bsVault) - bsColBefore,
            LENDER_COL,
            "collateral warehoused"
        );
        // Treasury slice routed normally.
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20) - treasuryColBefore,
            TREASURY_COL,
            "treasury slice"
        );
        // Exposure incremented by the cash spent.
        (uint256 cash, uint256 exposure, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposure, DUE, "exposure ++ by due");
        assertEq(cash, SEED_CASH - DUE, "cash bucket debited");
        // Loan terminal.
        LibVaipakam.LoanStatus st = LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
        assertTrue(
            st == LibVaipakam.LoanStatus.Defaulted || st == LibVaipakam.LoanStatus.Settled,
            "loan terminal"
        );
    }

    /// @dev Codex #1122-rework r2 P1 #3 — a lender holder confirmed flagged AFTER a
    ///      clean fallback-entry must block the backstop absorb (fail-closed) during
    ///      an oracle outage, even though the fallback-entry marker gate finds no
    ///      marker and the fail-open `msg.sender`/`nftOwner` screens pass. The absorb
    ///      is terminal-in-one-tx (burns the lender NFT), so it BLOCKS rather than
    ///      parks; the loan stays FallbackPending and is recoverable once de-listed.
    function test_absorb_registeredFlaggedOwnerDuringOutage_reverts() public {
        address lender_ = makeAddr("lenderS10bs");
        address borrower_ = makeAddr("borrowerS10bs");
        _fallbackOptedIn(lender_, borrower_);

        // Confirm + register the lender holder while the oracle is up (clean at the
        // earlier fallback-entry), then take the oracle down.
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(lender_, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(lender_);
        m.setRevertOnRead(true); // outage

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lender_)
        );
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    // ─── guards ────────────────────────────────────────────────────────────

    function test_absorb_parGuard_underwater_reverts() public {
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        // lenderCollateral (500) worth LESS than lenderPrincipalDue (550) at 1:1.
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, 500 ether);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopUndercollateralized.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_capExceeded_reverts() public {
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20, mockCollateralERC20, 100 ether // below DUE (550)
        );
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbCapExceeded.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_insufficientCash_reverts() public {
        // Fresh pair with a cap but no seeded cash.
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbCap(
            mockERC20, mockCollateralERC20, CAP
        );
        // Drain the seeded cash by spending it: simplest is a separate unseeded
        // pair — here re-point by zeroing via a large absorb is complex, so use a
        // loan whose due exceeds the bucket. Seed bucket is SEED_CASH (10k) >> DUE,
        // so instead assert the guard via a cap-sized-but-cashless fresh deploy:
        // spin a second collateral with a cap but no cash.
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPending(LOAN, borrower_, LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        // Zero the absorb-cash bucket to isolate the insufficient-cash guard.
        TestMutatorFacet(address(diamond)).setBackstopAbsorbCashRaw(
            mockERC20, mockCollateralERC20, 0
        );
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbInsufficientCash.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_notOptedIn_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, lender_);
        // no opt-in
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_keepersPaused_reverts() public {
        // #633 — the global keeper pause also freezes the KEEPER_ROLE backstop path.
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        AdminFacet(address(diamond)).setKeepersPaused(true);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.KeepersPaused.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_disabled_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbEnabled(false);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbDisabled.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_nonKeeper_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(makeAddr("notKeeper"));
        vm.expectRevert(); // AccessControl: missing KEEPER_ROLE
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    // ─── realized-cash release ───────────────────────────────────────────────

    function test_releaseExposure_decrementsOnRealizedCash() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        (, uint256 exposureBefore, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposureBefore, DUE, "exposure outstanding");

        // Governance attests realized cash from selling the warehoused collateral.
        vm.prank(owner);
        BackstopFacet(address(diamond)).releaseBackstopAbsorbExposure(
            mockERC20, mockCollateralERC20, DUE
        );
        (, uint256 exposureAfter, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(exposureAfter, 0, "exposure released");
    }

    function test_absorb_noRetryAttempted_reverts() public {
        // Fresh fixture with retryAttempted = false + empty retryCalls ⇒ the
        // objective resolution-first swap never ran ⇒ buyout refused.
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        _seedLoan(LOAN, lender_, borrower_);
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        vm.prank(bVault);
        IERC20(mockCollateralERC20).transfer(address(diamond), COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, 0
        );
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: LENDER_COL,
            treasuryCollateral: TREASURY_COL,
            borrowerCollateral: BORROWER_COL,
            lenderPrincipalDue: DUE,
            treasuryPrincipalDue: TREASURY_COL,
            active: true,
            retryAttempted: false
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(LOAN, snap);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.FallbackPending
        );
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopRetryRequired.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_absorb_optInVoidedByTransfer_reverts() public {
        // A opts in; the NFT then "transfers" to B (re-mock ownerOf → B). The
        // stale A-authorization must not let the keeper buy out for B.
        address a = makeAddr("lenderA");
        address b = makeAddr("lenderB");
        _seedLoan(LOAN, a, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"), LENDER_COL);
        _mockLenderNft(LOAN, a);
        vm.prank(a);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
        // NFT transferred to B.
        _mockLenderNft(LOAN, b);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    // ─── collateral sweep ─────────────────────────────────────────────────────

    function test_sweepAbsorbCollateral_boundedToWarehoused() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        // Over-sweep (more than warehoused LENDER_COL) reverts.
        vm.prank(owner);
        vm.expectRevert(BackstopFacet.BackstopAbsorbCollateralInsufficient.selector);
        BackstopFacet(address(diamond)).sweepBackstopAbsorbCollateral(
            mockCollateralERC20, makeAddr("gov"), LENDER_COL + 1
        );

        // Exact warehoused amount sweeps to the recipient.
        address gov = makeAddr("gov");
        vm.prank(owner);
        BackstopFacet(address(diamond)).sweepBackstopAbsorbCollateral(
            mockCollateralERC20, gov, LENDER_COL
        );
        assertEq(IERC20(mockCollateralERC20).balanceOf(gov), LENDER_COL, "swept to gov");
    }

    function test_withdrawAbsorbToTreasury_returnsCash() public {
        uint256 before =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        vm.prank(owner);
        BackstopFacet(address(diamond)).withdrawBackstopAbsorbToTreasury(
            mockERC20, mockCollateralERC20, 100 ether
        );
        (uint256 cash, , ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(cash, SEED_CASH - 100 ether, "bucket debited");
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20),
            before + 100 ether,
            "treasury re-credited"
        );
    }

    function test_absorb_vpfiPrincipal_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        // Rotate vpfiToken onto the loan's principal asset AFTER seeding/opt-in.
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopVpfiPrincipalUnsupported.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());
    }

    function test_sweepAbsorbCollateral_toDiamond_creditsTreasury() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _emptyRetry());

        uint256 before =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20);
        // Write-off path: sweep the warehoused collateral to the Diamond (treasury).
        vm.prank(owner);
        BackstopFacet(address(diamond)).sweepBackstopAbsorbCollateral(
            mockCollateralERC20, address(diamond), LENDER_COL
        );
        assertEq(
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockCollateralERC20) - before,
            LENDER_COL,
            "Diamond-bound sweep credits treasury"
        );
    }

    function test_seedAbsorb_vpfiLending_reverts() public {
        vm.startPrank(owner);
        // Rotate vpfiToken onto the seed's principal asset.
        // (Reuses the same post-rotation guard as the origination seed.)
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        ERC20Mock(mockERC20).mint(address(diamond), SEED_CASH);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, SEED_CASH);
        vm.expectRevert(BackstopFacet.VpfiLendingUnsupported.selector);
        BackstopFacet(address(diamond)).seedBackstopAbsorb(
            mockERC20, mockCollateralERC20, SEED_CASH
        );
        vm.stopPrank();
    }
}
