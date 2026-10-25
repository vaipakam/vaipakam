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
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {IZeroExProxy} from "../src/interfaces/IZeroExProxy.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
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
import {defaultQuote} from "./helpers/ForcedSaleQuote.sol";

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
 * @dev    Seeds an Active loan via TestMutatorFacet the way initiation leaves
 *         it (the collateral in the borrower's vault, protocol-tracked and
 *         liened), then drives it into FallbackPending the way production does
 *         (#1566 S2b): `triggerDefault` past the grace period with every swap
 *         route reverting, so the REAL producer leaves the custody in the
 *         borrower's vault under the loan's lien with the custody row equal to
 *         the snapshot total, and every slice of an absorb leaves the
 *         BORROWER's vault. The loan's own fallback terms (a 10% lender bonus,
 *         a 2% treasury cut, no interest) give this suite's split at the
 *         $1/18-dec oracle. The position NFTs are mocked. `owner` holds
 *         KEEPER_ROLE (granted at init) so it doubles as the designated keeper.
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
    /// @dev #1566 S2b -- the term the loan runs and the prices the real
    ///      producer sees: SetupTest's $1 par, and the above-par price the
    ///      par-guard cell defaults at.
    uint256 internal constant DURATION_DAYS = 30;
    /// @dev Past the 30-day term and any grace bucket of up to 30 days.
    uint256 internal constant DEFAULT_AFTER = DURATION_DAYS * 1 days + 31 days;
    uint256 internal constant PAR_PRICE = 1e8;
    uint256 internal constant PAR_GUARD_ENTRY_PRICE = 110_000_000;

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

    /// @dev Scaffold an Active loan (lends mockERC20 vs mockCollateralERC20)
    ///      the way initiation leaves it: the collateral in the borrower's
    ///      vault, protocol-tracked and under the loan's collateral lien, with
    ///      distinct position-NFT ids whose `ownerOf` is the stored party (so
    ///      the default's both-side consolidation is a no-op). #1566 S2b: the
    ///      loan's own snapshotted fallback terms -- a 10% lender bonus, a 2%
    ///      treasury cut, no interest -- make the REAL producer compute this
    ///      suite's split at par: lender 550 (= the 550 due), treasury 10,
    ///      borrower 440.
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
        l.startTime = uint64(block.timestamp);
        l.durationDays = DURATION_DAYS;
        l.fallbackLenderBonusBpsAtInit = 1_000;
        l.fallbackTreasuryBpsAtInit = 200;
        l.borrowerTokenId = id * 2;
        l.lenderTokenId = id * 2 + 1;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2),
            abi.encode(borrower_)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2 + 1),
            abi.encode(lender_)
        );

        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower_
        );
        ERC20Mock(mockCollateralERC20).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower_, mockCollateralERC20, COLLATERAL
        );
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            id, borrower_, mockCollateralERC20, 0, COLLATERAL, LibVaipakam.AssetType.ERC20
        );
    }

    /// @dev Drive the seeded loan into FallbackPending the way production does
    ///      (#1566 S2b; slices 2-3 brief (i)): past its grace period,
    ///      `triggerDefault` with every swap route reverting, so the REAL
    ///      producer (`FallbackCustodyFacet.enterFallback`) writes the snapshot
    ///      and both claim rows from the loan's own terms, returns the
    ///      collateral to the borrower's vault under the lien it re-creates,
    ///      and credits the custody row (`Entered`). The reverting venue stays
    ///      mocked for the rest of the cell, so an absorb passed {_failedRetry}
    ///      runs the objective retry and sees it fail (the retry puts the row
    ///      back): that is how a real loan reaches the absorb with
    ///      `retryAttempted` set. Fixture-live: this suite's split (550 / 10 /
    ///      440 against a 550 due) and no retry attempted yet.
    function _moveToFallbackPending(uint256 id, address borrower_) internal {
        _moveToFallbackPendingAt(id, borrower_, PAR_PRICE);
        (uint256 l, uint256 t, uint256 b, uint256 due, uint256 tDue, , bool retried) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(id);
        assertEq(l, LENDER_COL, "fixture-live: the producer's lender slice");
        assertEq(t, TREASURY_COL, "fixture-live: the producer's treasury slice");
        assertEq(b, BORROWER_COL, "fixture-live: the producer's borrower slice");
        assertEq(due, DUE, "fixture-live: the lender's principal due");
        assertEq(tDue, TREASURY_COL, "fixture-live: the treasury's principal due");
        assertFalse(retried, "fixture-live: no retry attempted yet");
    }

    /// @dev {_moveToFallbackPending} with the collateral priced at
    ///      `collateralPrice` (8 decimals) for the default itself and back at
    ///      par afterwards. The producer sizes the slices at the entry price,
    ///      so collateral that falls after the default leaves the lender's
    ///      slice worth less than the due (the par-guard cell). Fixture-live:
    ///      FallbackPending, the whole collateral vault-held as the custody
    ///      row and back in the borrower's vault, nothing left in the Diamond.
    function _moveToFallbackPendingAt(uint256 id, address borrower_, uint256 collateralPrice) internal {
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        uint256 diamond0 = IERC20(mockCollateralERC20).balanceOf(address(diamond));
        vm.warp(block.timestamp + DEFAULT_AFTER);
        vm.mockCallRevert(
            mockZeroExProxy,
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap failed"
        );
        mockOraclePrice(mockCollateralERC20, collateralPrice, 8);
        uint256 sellQuote = defaultQuote(address(diamond), id);
        DefaultedFacet(address(diamond)).triggerDefault(id, sellQuote, defaultAdapterCalls());
        mockOraclePrice(mockCollateralERC20, PAR_PRICE, 8);

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(id).status),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the default entered FallbackPending"
        );
        (uint256 vaultHeld, uint256 legacy) =
            FallbackCustodyFacet(address(diamond)).getFallbackCustody(id);
        assertEq(vaultHeld, COLLATERAL, "fixture-live: the whole collateral is the custody row");
        assertEq(legacy, 0, "fixture-live: nothing reads as Diamond-held");
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(bVault),
            COLLATERAL,
            "fixture-live: the collateral is back in the borrower's vault"
        );
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(address(diamond)),
            diamond0,
            "fixture-live: the default left nothing in the Diamond"
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
        _moveToFallbackPending(LOAN, borrower_);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
    }

    function _emptyRetry() internal pure returns (LibSwap.AdapterCall[] memory) {
        return new LibSwap.AdapterCall[](0);
    }

    /// @dev The objective retry a real backstop absorb runs first (#1566
    ///      S2b): the default adapter try-list against the venue the fixture
    ///      keeps reverting, so the retry pulls the custody row, fails and
    ///      puts it back, leaving `retryAttempted` set; the absorb then
    ///      proceeds. Every absorb cell passes it except the one pinning the
    ///      retry-required gate.
    function _failedRetry() internal pure returns (LibSwap.AdapterCall[] memory) {
        return defaultAdapterCalls();
    }

    // ─── opt-in ───────────────────────────────────────────────────────────────

    function test_optIn_byNftOwner() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"));
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
        // (no revert) — flag set; exercised by the absorb happy path.
    }

    function test_optIn_notNftOwner_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"));
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
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
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
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
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
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        uint256 bVaultBefore = IERC20(mockCollateralERC20).balanceOf(bVault);

        // owner holds KEEPER_ROLE (granted at init) → it is the designated keeper.
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());

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
        // #1566 S2b -- the slices left the BORROWER's vault (the Diamond held
        // none of the custody), and the residual kept the lien it already had.
        assertEq(
            bVaultBefore - IERC20(mockCollateralERC20).balanceOf(bVault),
            LENDER_COL + TREASURY_COL,
            "only the lender + treasury slices left the borrower's vault"
        );
        (uint256 lienAfter, ) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(LOAN);
        assertEq(lienAfter, BORROWER_COL, "the lien is exactly the retained borrower slice");
        (uint256 rowAfter, ) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(LOAN);
        assertEq(rowAfter, 0, "the custody row is spent");
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
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    // ─── guards ────────────────────────────────────────────────────────────

    function test_absorb_parGuard_underwater_reverts() public {
        address lender_ = makeAddr("lender7");
        address borrower_ = makeAddr("borrower7");
        // lenderCollateral (500) worth LESS than lenderPrincipalDue (550) at 1:1,
        // reached through the real producer (#1566 S2b): at the default the
        // collateral is priced 10% above par, so the snapshot sizes the
        // lender's slice at 550 / 1.1 = 500 collateral; back at par those 500
        // are worth less than the 550 due.
        _seedLoan(LOAN, lender_, borrower_);
        _moveToFallbackPendingAt(LOAN, borrower_, PAR_GUARD_ENTRY_PRICE);
        (uint256 lenderSlice, , , uint256 lenderDue, , , ) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertEq(lenderSlice, 500 ether, "fixture-live: the lender slice is 500");
        assertEq(lenderDue, DUE, "fixture-live: against the 550 due");
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopUndercollateralized.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    /// @notice #1281 — the par guard is exact. The producer sizes the lender
    ///         slice to cover the due (rounded up), so a solvent slice is
    ///         absorbed with no tolerance owed (`test_absorb_paysCashToOwner_…`),
    ///         and a slice worth one principal wei less than the due is
    ///         refused — the case the old one-wei tolerance let through.
    /// @dev    RAW snapshot edit, and why: at the suite's par prices the real
    ///         producer cannot leave a slice one unit short of its due; that is
    ///         the point of the rounding. One unit moves from the lender slice
    ///         to the borrower slice, so the total, and the row, are unchanged.
    function test_absorb_parGuard_oneUnitShort_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        (uint256 l, uint256 t, uint256 b, uint256 due, uint256 tDue, bool active, bool retried) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertEq(l, due, "fixture-live: at par the producer sized the slice at the due");
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(
            LOAN,
            LibVaipakam.FallbackSnapshot({
                lenderCollateral: l - 1,
                treasuryCollateral: t,
                borrowerCollateral: b + 1,
                lenderPrincipalDue: due,
                treasuryPrincipalDue: tDue,
                active: active,
                retryAttempted: retried
            })
        );

        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopUndercollateralized.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    /// @notice #1281 — a rescale can leave a one-unit lender slice (rounded
    ///         up) beside a due rounded down to zero. A purchase for no cash
    ///         would take that slice and pay the lender nothing, so the absorb
    ///         returns without spending or moving anything and the lender keeps
    ///         the slice in kind (lender first).
    function test_absorb_dueRescaledToZero_isANoop() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        (uint256 l, uint256 t, uint256 b, , uint256 tDue, bool active, bool retried) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(
            LOAN,
            LibVaipakam.FallbackSnapshot({
                lenderCollateral: 1,
                treasuryCollateral: t,
                borrowerCollateral: b + l - 1,
                lenderPrincipalDue: 0,
                treasuryPrincipalDue: tDue,
                active: active,
                retryAttempted: retried
            })
        );
        (uint256 cashBefore, uint256 exposureBefore, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);

        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());

        (uint256 cash, uint256 exposure, ) =
            BackstopFacet(address(diamond)).getBackstopAbsorbInfo(mockERC20, mockCollateralERC20);
        assertEq(cash, cashBefore, "no absorb cash spent");
        assertEq(exposure, exposureBefore, "no exposure taken");
        (uint256 lAfter, , , , , bool activeAfter, ) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertTrue(activeAfter, "the snapshot stays active for the in-kind claim");
        assertEq(lAfter, 1, "the lender keeps the one-unit slice");
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
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
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
        _moveToFallbackPending(LOAN, borrower_);
        _mockLenderNft(LOAN, lender_);
        vm.prank(lender_);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);

        // Zero the absorb-cash bucket to isolate the insufficient-cash guard.
        TestMutatorFacet(address(diamond)).setBackstopAbsorbCashRaw(
            mockERC20, mockCollateralERC20, 0
        );
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbInsufficientCash.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    function test_absorb_notOptedIn_reverts() public {
        address lender_ = makeAddr("lender7");
        _seedLoan(LOAN, lender_, makeAddr("borrower7"));
        _moveToFallbackPending(LOAN, makeAddr("borrower7"));
        _mockLenderNft(LOAN, lender_);
        // no opt-in
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    function test_absorb_keepersPaused_reverts() public {
        // #633 — the global keeper pause also freezes the KEEPER_ROLE backstop path.
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        AdminFacet(address(diamond)).setKeepersPaused(true);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.KeepersPaused.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    function test_absorb_disabled_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopAbsorbEnabled(false);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.BackstopAbsorbDisabled.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    function test_absorb_nonKeeper_reverts() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(makeAddr("notKeeper"));
        vm.expectRevert(); // AccessControl: missing KEEPER_ROLE
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    // ─── realized-cash release ───────────────────────────────────────────────

    function test_releaseExposure_decrementsOnRealizedCash() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());

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
        _moveToFallbackPending(LOAN, borrower_);
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
        _moveToFallbackPending(LOAN, makeAddr("borrower7"));
        _mockLenderNft(LOAN, a);
        vm.prank(a);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(LOAN, true);
        // NFT transferred to B.
        _mockLenderNft(LOAN, b);
        vm.prank(owner);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    // ─── collateral sweep ─────────────────────────────────────────────────────

    function test_sweepAbsorbCollateral_boundedToWarehoused() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());

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
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());
    }

    function test_sweepAbsorbCollateral_toDiamond_creditsTreasury() public {
        address lender_ = makeAddr("lender7");
        _fallbackOptedIn(lender_, makeAddr("borrower7"));
        vm.prank(owner);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(LOAN, _failedRetry());

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
