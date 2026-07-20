// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {AggregatorAdapterImplementation} from "../src/AggregatorAdapterImplementation.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC4907Mock} from "./mocks/ERC4907Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title  AggregatorAdapterTest
 * @notice #398 / #401 v1.5 — the ERC-4626 aggregator lender-adapter. Provision
 *         an adapter for an aggregator, deposit (→ funds the standing intent), a
 *         keeper matches + auto-rolls, and the conservative-haircut NAV +
 *         idle-only withdrawals + E1 single-principal gates behave as designed.
 *
 * @dev    Same $1/18-dec oracle + partial-fill + lenderIntentEnabled posture as
 *         `LenderIntentMatchTest`. `owner` holds ADMIN + VAULT_ADMIN roles.
 */
contract AggregatorAdapterTest is SetupTest {
    AggregatorAdapterImplementation internal adapter;
    address internal aggregator; // the authorized principal
    address internal keeper; // designated fill + auto-roll keeper

    uint256 internal constant DEPOSIT = 1_000 ether;
    uint16 internal constant HAIRCUT_BPS = 200; // 2%
    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_EXPOSURE = 100_000 ether;
    uint256 internal constant MIN_RATE = 500;
    uint16 internal constant MAX_LTV = 5000; // 50% ⇒ reqColl = 2x
    uint32 internal constant MAX_DUR = 30;
    uint256 internal constant MIN_FILL = 1 ether;

    function setUp() public {
        setupHelper();
        aggregator = makeAddr("yearnLikeAggregator");
        keeper = makeAddr("adapterKeeper");

        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        AggregatorAdapterFactoryFacet(address(diamond))
            .initializeAdapterImplementation();
        address a = AggregatorAdapterFactoryFacet(address(diamond))
            .createAggregatorAdapter(
                aggregator,
                mockERC20,
                mockCollateralERC20,
                HAIRCUT_BPS,
                keeper,
                "Vaipakam-Yearn mUSD",
                "vyMUSD",
                MAX_EXPOSURE,
                MIN_RATE,
                MAX_LTV,
                MAX_DUR,
                MIN_FILL
            );
        vm.stopPrank();
        adapter = AggregatorAdapterImplementation(a);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    /// @dev Mint to the aggregator, approve the adapter, deposit.
    function _deposit(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(aggregator, amount);
        vm.prank(aggregator);
        ERC20(mockERC20).approve(address(adapter), amount);
        vm.prank(aggregator);
        adapter.deposit(amount, aggregator);
    }

    function _newBorrower(string memory name) internal returns (address b) {
        b = makeAddr(name);
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.prank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    function _postBorrower(uint256 principal) internal returns (uint256 offerId) {
        address b = _newBorrower("adapterBorrower");
        vm.prank(b);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: MIN_RATE,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * principal,
                durationDays: MAX_DUR,
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
                amountMax: principal,
                interestRateBpsMax: MIN_RATE + 100,
                collateralAmountMax: 2 * principal,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    /// @dev Keeper fills the adapter's intent against a fresh borrower for
    ///      `fillAmount`, through the adapter's screened `matchLoan` forwarder.
    function _match(uint256 fillAmount) internal returns (uint256 loanId) {
        uint256 cp = _postBorrower(fillAmount);
        vm.prank(keeper);
        loanId = adapter.matchLoan(cp, fillAmount);
    }

    function _idle() internal view returns (uint256) {
        return adapter.idleAssets();
    }

    // ─── 1. Provisioning ───────────────────────────────────────────────────────

    function test_provision_registersIntentAndKeeper() public {
        assertTrue(
            AggregatorAdapterFactoryFacet(address(diamond))
                .isAggregatorAdapter(address(adapter)),
            "registered"
        );
        assertEq(adapter.asset(), mockERC20, "asset = lending asset");
        assertEq(adapter.authorizedPrincipal(), aggregator, "principal");
        assertEq(adapter.haircutBps(), HAIRCUT_BPS, "haircut");
        // The adapter registered its standing intent (keeper-gated) as itself.
        LibVaipakam.LenderIntent memory it = LenderIntentFacet(address(diamond))
            .getLenderIntent(address(adapter), mockERC20, mockCollateralERC20);
        assertTrue(it.active, "intent active");
        assertTrue(it.requiresKeeperAuth, "keeper-gated");
        assertEq(it.maxExposure, MAX_EXPOSURE, "bounds");
    }

    // ─── 2. Deposit → funds the intent ──────────────────────────────────────────

    function test_deposit_fundsIntent_mintsShares() public {
        _deposit(DEPOSIT);
        assertEq(_idle(), DEPOSIT, "idle == deposit");
        assertEq(adapter.totalAssets(), DEPOSIT, "NAV == deposit (no loans)");
        assertGt(adapter.balanceOf(aggregator), 0, "shares minted");
        assertEq(adapter.maxWithdraw(aggregator), DEPOSIT, "all idle withdrawable");
    }

    function test_deposit_unauthorizedCaller_reverts() public {
        address rando = makeAddr("rando");
        ERC20Mock(mockERC20).mint(rando, DEPOSIT);
        vm.prank(rando);
        ERC20(mockERC20).approve(address(adapter), DEPOSIT);
        vm.prank(rando);
        // Rejected at the `maxDeposit == 0` gate (the principal restriction)
        // before reaching `_deposit` — reverts the OZ ERC-4626 max-deposit error.
        vm.expectRevert();
        adapter.deposit(DEPOSIT, rando);
    }

    function test_maxDeposit_zeroForNonPrincipal() public {
        assertEq(adapter.maxDeposit(makeAddr("other")), 0, "non-principal: 0");
        assertGt(adapter.maxDeposit(aggregator), 0, "principal: depositable");
    }

    // ─── 3. E1 — non-transferable shares + no approved-spender exit ─────────────

    function test_shares_nonTransferable() public {
        _deposit(DEPOSIT);
        vm.prank(aggregator);
        vm.expectRevert(
            AggregatorAdapterImplementation.SharesNonTransferable.selector
        );
        adapter.transfer(makeAddr("buyer"), 1);
    }

    function test_withdraw_byApprovedSpender_reverts() public {
        _deposit(DEPOSIT);
        address spender = makeAddr("spender");
        vm.prank(aggregator);
        adapter.approve(spender, type(uint256).max);
        // Even an ERC-20-approved spender cannot pull assets to itself.
        vm.prank(spender);
        vm.expectRevert(
            AggregatorAdapterImplementation.WithdrawNotPrincipal.selector
        );
        adapter.withdraw(1 ether, spender, aggregator);
    }

    // ─── 4. Match → idle→live, conservative-haircut NAV ─────────────────────────

    function test_match_movesIdleToLive_haircutNav() public {
        _deposit(DEPOSIT);
        uint256 fill = 500 ether;
        _match(fill);

        // idle ~ (deposit - fill) PLUS the matcher LIF kickback this adapter
        // earned on the fill — it is recorded as `loan.matcher`, so the Diamond
        // pays it the LIF kickback in the LENDING asset. #626 round-6 P2 re-liens
        // that raw balance into idle so it re-enters NAV (instead of stranding
        // outside ERC-4626 accounting until a manual sweep). So idle is STRICTLY
        // ABOVE (deposit - fill) by the kickback (1% of the 0.2% LIF on the fill, rev-8 freeze #1352).
        uint256 idle = _idle();
        assertGt(idle, DEPOSIT - fill, "matcher kickback re-funded into idle");
        // ...but the kickback is a small fee, not a double-count of the fill.
        assertApproxEqAbs(idle, DEPOSIT - fill, 0.01 ether, "idle ~ deposit - fill + kickback");
        uint256 live = LenderIntentFacet(address(diamond))
            .getLenderIntentLivePrincipal(
                address(adapter), mockERC20, mockCollateralERC20
            );
        // totalAssets = idle + risk-adjusted live (exact, from live state).
        assertEq(
            adapter.totalAssets(),
            idle + (live * (BPS - HAIRCUT_BPS)) / BPS,
            "NAV = idle + haircut(live)"
        );
        // NAV is below face by ~the haircut on live principal.
        assertLt(adapter.totalAssets(), DEPOSIT, "haircut applied");
        // maxWithdraw is CAPPED to idle (live capital is illiquid). It may be a
        // wei below idle when the post-haircut share value rounds down — the
        // load-bearing property is that it never exceeds idle.
        assertLe(adapter.maxWithdraw(aggregator), idle, "withdraw capped to idle");
        assertApproxEqAbs(adapter.maxWithdraw(aggregator), idle, 2, "withdraw ~ idle");
    }

    // ─── 5. Roll compounds realized interest into idle ──────────────────────────

    function test_roll_compoundsIntoIdle() public {
        _deposit(DEPOSIT);
        uint256 fill = 500 ether;
        uint256 loanId = _match(fill);

        // Borrower repays in full.
        address borrower =
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Keeper auto-rolls via the adapter's screened forwarder: proceeds
        // (principal + interest) re-lien into idle.
        vm.prank(keeper);
        adapter.rollLoan(loanId);

        // idle is back up to deposit + realized interest; live is 0.
        assertGt(_idle(), DEPOSIT, "idle compounded above deposit");
        assertEq(adapter.totalAssets(), _idle(), "no live; NAV == idle");
        assertGt(adapter.totalAssets(), DEPOSIT, "NAV grew by realized interest");
    }

    // ─── 6. Withdraw returns assets to the principal ────────────────────────────

    function test_withdraw_returnsAssetsToPrincipal() public {
        _deposit(DEPOSIT);
        uint256 walletBefore = ERC20(mockERC20).balanceOf(aggregator);
        vm.prank(aggregator);
        adapter.withdraw(DEPOSIT, aggregator, aggregator);
        assertEq(
            ERC20(mockERC20).balanceOf(aggregator),
            walletBefore + DEPOSIT,
            "assets returned"
        );
        assertEq(_idle(), 0, "idle drained");
    }

    // ─── 7. Principal wind-down ─────────────────────────────────────────────────

    function test_windDownIntent_principalOnly() public {
        _deposit(DEPOSIT);
        // Non-principal can't wind down.
        vm.prank(keeper);
        vm.expectRevert(
            AggregatorAdapterImplementation.NotAuthorizedPrincipal.selector
        );
        adapter.windDownIntent();
        // Principal winds down: intent inactive afterward.
        vm.prank(aggregator);
        adapter.windDownIntent();
        assertFalse(
            LenderIntentFacet(address(diamond))
                .getLenderIntent(address(adapter), mockERC20, mockCollateralERC20)
                .active,
            "intent cancelled"
        );
        // Idle is still withdrawable after wind-down.
        assertEq(adapter.maxWithdraw(aggregator), DEPOSIT, "idle still withdrawable");
    }

    // ─── 8. Aggregator-pull upgrade ─────────────────────────────────────────────

    function test_pullMigrate_bumpsVersion() public {
        AggregatorAdapterImplementation newImpl =
            new AggregatorAdapterImplementation();
        vm.prank(owner);
        AggregatorAdapterFactoryFacet(address(diamond))
            .upgradeAdapterImplementation(address(newImpl));
        // Aggregator pulls the migration (gated to the principal for voluntary
        // upgrades — no silent push under a live integration).
        vm.prank(aggregator);
        AggregatorAdapterFactoryFacet(address(diamond))
            .upgradeAggregatorAdapter(address(adapter));
        assertEq(
            AggregatorAdapterFactoryFacet(address(diamond))
                .getAggregatorAdapterVersion(address(adapter)),
            AggregatorAdapterFactoryFacet(address(diamond))
                .currentAggregatorAdapterVersion(),
            "adapter migrated to current version"
        );
    }

    /// @dev #626 round-3 P1 — keeper/principal claims a resolved loan's proceeds
    ///      back into the adapter (empty retry list for a clean Repaid loan) and
    ///      re-funds them into idle.
    function test_claimAndCompound_recoversAndReFunds() public {
        _deposit(DEPOSIT);
        uint256 fill = 500 ether;
        uint256 loanId = _match(fill);
        address borrower =
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        // Recover via claimAndCompound (keeper) instead of rollLoan.
        vm.prank(keeper);
        adapter.claimAndCompound(loanId, new LibSwap.AdapterCall[](0));
        assertGt(_idle(), DEPOSIT, "recovered proceeds compounded into idle");
        // Unauthorized caller is rejected.
        vm.prank(makeAddr("rando"));
        vm.expectRevert(
            AggregatorAdapterImplementation.NotKeeperOrPrincipal.selector
        );
        adapter.claimAndCompound(loanId, new LibSwap.AdapterCall[](0));
    }

    /// @dev #626 round-4 P2 — `initialize` is gated to the Diamond deploy path;
    ///      a rogue proxy over the shared impl can't initialize against the real
    ///      Diamond.
    function test_initialize_onlyDiamond_reverts() public {
        AggregatorAdapterImplementation impl =
            new AggregatorAdapterImplementation();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), "");
        AggregatorAdapterImplementation rogue =
            AggregatorAdapterImplementation(address(proxy));
        // msg.sender == this test contract != the real Diamond → NotDiamond.
        vm.expectRevert(AggregatorAdapterImplementation.NotDiamond.selector);
        rogue.initialize(
            address(diamond), aggregator, mockERC20, mockCollateralERC20,
            HAIRCUT_BPS, keeper, "x", "x",
            MAX_EXPOSURE, MIN_RATE, MAX_LTV, MAX_DUR, MIN_FILL
        );
    }

    // ─── 8b. Round-2 gates ──────────────────────────────────────────────────────

    function test_matchLoan_unauthorizedCaller_reverts() public {
        _deposit(DEPOSIT);
        uint256 cp = _postBorrower(500 ether);
        vm.prank(makeAddr("notKeeper"));
        vm.expectRevert(
            AggregatorAdapterImplementation.NotKeeperOrPrincipal.selector
        );
        adapter.matchLoan(cp, 500 ether);
    }

    /// @dev #626 round-2 P1 — a mandated upgrade floor halts new deposits
    ///      (upgrade-or-halt); withdraw stays open.
    function test_mandatoryFloor_blocksDeposit() public {
        _deposit(DEPOSIT); // funds fine before the mandate
        // Adapter is at version 0; mandate version 1 → below floor.
        vm.prank(owner);
        AggregatorAdapterFactoryFacet(address(diamond))
            .setMandatoryAdapterUpgrade(1);
        assertEq(adapter.maxDeposit(aggregator), 0, "deposit advertised closed");
        ERC20Mock(mockERC20).mint(aggregator, DEPOSIT);
        vm.prank(aggregator);
        ERC20(mockERC20).approve(address(adapter), DEPOSIT);
        vm.prank(aggregator);
        vm.expectRevert();
        adapter.deposit(DEPOSIT, aggregator);
        // Exit still works under the mandate.
        vm.prank(aggregator);
        adapter.withdraw(DEPOSIT, aggregator, aggregator);
    }

    /// @dev #626 round-2 P2 — a voluntary (non-mandated) migration is gated to
    ///      the principal; nobody else can change adapter behaviour silently.
    function test_voluntaryUpgrade_nonPrincipal_reverts() public {
        AggregatorAdapterImplementation newImpl =
            new AggregatorAdapterImplementation();
        vm.prank(owner);
        AggregatorAdapterFactoryFacet(address(diamond))
            .upgradeAdapterImplementation(address(newImpl));
        vm.prank(makeAddr("rando"));
        vm.expectRevert(
            AggregatorAdapterFactoryFacet.NotAdapterPrincipal.selector
        );
        AggregatorAdapterFactoryFacet(address(diamond))
            .upgradeAggregatorAdapter(address(adapter));
    }

    // ─── 9. Governance haircut ──────────────────────────────────────────────────

    function test_setHaircut_viaFactory_changesNav() public {
        _deposit(DEPOSIT);
        uint256 fill = 500 ether;
        _match(fill);
        // Raise the haircut to 10% via governance.
        vm.prank(owner);
        AggregatorAdapterFactoryFacet(address(diamond))
            .setAggregatorHaircutBps(address(adapter), 1000);
        assertEq(adapter.haircutBps(), 1000, "haircut updated");
        uint256 idle = _idle();
        uint256 live = LenderIntentFacet(address(diamond))
            .getLenderIntentLivePrincipal(
                address(adapter), mockERC20, mockCollateralERC20
            );
        assertEq(
            adapter.totalAssets(),
            idle + (live * (BPS - 1000)) / BPS,
            "NAV reflects new haircut"
        );
    }

    // ─── 10. Round-6 gates ──────────────────────────────────────────────────────

    /// @dev #626 round-6 P2 — the keeper-callable forwarders call `matchIntent`/
    ///      `rollIntentLoan` AS the adapter, so the Diamond's own `msg.sender`
    ///      sanctions gate only sees the clean adapter. The adapter must screen the
    ///      keeper itself so a keeper that becomes sanctioned can't originate loans.
    function test_sanctionedKeeper_cannotMatch() public {
        _deposit(DEPOSIT);
        MockSanctionsList oracle = new MockSanctionsList();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        oracle.setFlagged(keeper, true); // principal stays clean

        uint256 cp = _postBorrower(500 ether);
        vm.prank(keeper);
        vm.expectRevert(
            AggregatorAdapterImplementation.PrincipalSanctioned.selector
        );
        adapter.matchLoan(cp, 500 ether);
        // The clean principal can still match through its own self-branch.
        vm.prank(aggregator);
        adapter.matchLoan(cp, 500 ether);
    }

    /// @dev #626 round-5 P2 — a sanctioned principal can't withdraw (the funds-out
    ///      screen reverts), so the max methods must advertise 0 to routers.
    function test_sanctionedPrincipal_zerosWithdrawCapacity() public {
        _deposit(DEPOSIT);
        assertEq(adapter.maxWithdraw(aggregator), DEPOSIT, "withdrawable before");
        MockSanctionsList oracle = new MockSanctionsList();
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        oracle.setFlagged(aggregator, true);
        assertEq(adapter.maxWithdraw(aggregator), 0, "maxWithdraw zeroed");
        assertEq(adapter.maxRedeem(aggregator), 0, "maxRedeem zeroed");
    }

    /// @dev #626 round-6 P2 — a global Diamond pause freezes
    ///      `withdrawLenderIntentCapital` (`whenNotPaused`), so the withdraw max
    ///      methods must advertise 0 while paused (they did still report idle).
    function test_globalPause_zerosWithdrawCapacity() public {
        _deposit(DEPOSIT);
        assertEq(adapter.maxWithdraw(aggregator), DEPOSIT, "withdrawable before");
        vm.prank(owner);
        AdminFacet(address(diamond)).pause();
        assertEq(adapter.maxWithdraw(aggregator), 0, "maxWithdraw zeroed while paused");
        assertEq(adapter.maxRedeem(aggregator), 0, "maxRedeem zeroed while paused");
        assertEq(adapter.maxDeposit(aggregator), 0, "maxDeposit zeroed while paused");
    }

    /// @dev #626 round-7 P2 — a mandatory VAULT upgrade (distinct from the adapter
    ///      upgrade floor) makes the adapter's `withdrawLenderIntentCapital` revert
    ///      `VaultUpgradeRequired`, so the withdraw max methods must advertise 0.
    function test_vaultUpgradeRequired_zerosWithdrawCapacity() public {
        _deposit(DEPOSIT); // adapter now has a vault at the current version
        assertEq(adapter.maxWithdraw(aggregator), DEPOSIT, "withdrawable before");
        // Publish a new vault impl (bumps currentVaultVersion) + mandate it.
        VaipakamVaultImplementation newVaultImpl = new VaipakamVaultImplementation();
        vm.startPrank(owner);
        VaultFactoryFacet(address(diamond))
            .upgradeVaultImplementation(address(newVaultImpl));
        (, uint256 currentVaultVersion, , ) = VaultFactoryFacet(address(diamond))
            .getVaultVersionInfo(address(adapter));
        VaultFactoryFacet(address(diamond))
            .setMandatoryVaultUpgrade(currentVaultVersion);
        vm.stopPrank();
        // The adapter's vault is now below the mandatory floor.
        (, , , bool upgradeRequired) = VaultFactoryFacet(address(diamond))
            .getVaultVersionInfo(address(adapter));
        assertTrue(upgradeRequired, "adapter vault below mandatory floor");
        assertEq(adapter.maxWithdraw(aggregator), 0, "maxWithdraw zeroed");
        assertEq(adapter.maxRedeem(aggregator), 0, "maxRedeem zeroed");
        // #626 round-8 P2 — deposit path also reverts under a vault mandate.
        assertEq(adapter.maxDeposit(aggregator), 0, "maxDeposit zeroed");
    }

    /// @dev #626 round-8 P2 — the adapter is ERC20-on-ERC20 and has no NFT sweep,
    ///      so it must reject any safe-transferred ERC721 (only its own Diamond
    ///      lender-position mint is accepted). A foreign NFT would otherwise be
    ///      permanently stuck.
    function test_onERC721Received_rejectsForeignNft() public {
        ERC4907Mock nft = new ERC4907Mock("Foreign", "FRGN");
        address holder = makeAddr("nftHolder");
        nft.mint(holder, 1);
        vm.prank(holder);
        vm.expectRevert(
            AggregatorAdapterImplementation.UnexpectedNFT.selector
        );
        nft.safeTransferFrom(holder, address(adapter), 1);
    }

    /// @dev #626 round-9 P2 — a foreign NFT dumped via NON-safe `transferFrom`
    ///      (no receiver hook) is recoverable by the principal; a Vaipakam
    ///      protocol NFT (nft == diamond) is never sweepable.
    function test_sweepNFTToPrincipal_recoversForeignNft() public {
        ERC4907Mock nft = new ERC4907Mock("Foreign", "FRGN");
        nft.mint(address(adapter), 7); // _mint — no hook, lands on the adapter
        // Protocol NFTs can't be swept (the adapter's own position must stay).
        vm.prank(aggregator);
        vm.expectRevert(
            AggregatorAdapterImplementation.CannotSweepProtocolNFT.selector
        );
        adapter.sweepNFTToPrincipal(address(diamond), 7);
        // Non-principal can't sweep.
        vm.prank(keeper);
        vm.expectRevert(
            AggregatorAdapterImplementation.NotAuthorizedPrincipal.selector
        );
        adapter.sweepNFTToPrincipal(address(nft), 7);
        // Principal recovers the foreign NFT.
        vm.prank(aggregator);
        adapter.sweepNFTToPrincipal(address(nft), 7);
        assertEq(nft.ownerOf(7), aggregator, "foreign NFT returned to principal");
    }

    /// @dev #626 round-9 P2 — the protocol's self-trade guard is preserved: the
    ///      principal can't fill its own intent against a borrow offer it posted.
    function test_matchLoan_selfTrade_reverts() public {
        _deposit(DEPOSIT);
        // The aggregator (principal) posts a borrower offer itself.
        ERC20Mock(mockCollateralERC20).mint(aggregator, 1_000_000 ether);
        vm.prank(aggregator);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(aggregator);
        ProfileFacet(address(diamond)).setUserCountry("US");
        uint256 fill = 500 ether;
        vm.prank(aggregator);
        uint256 selfOffer = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: fill,
                interestRateBps: MIN_RATE,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * fill,
                durationDays: MAX_DUR,
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
                amountMax: fill,
                interestRateBpsMax: MIN_RATE + 100,
                collateralAmountMax: 2 * fill,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
        vm.prank(keeper);
        vm.expectRevert(AggregatorAdapterImplementation.SelfTrade.selector);
        adapter.matchLoan(selfOffer, fill);
    }

    /// @dev #626 round-9 P3 — the reward-claim forwarder is keeper/principal-gated
    ///      (loans' lender-side emissions accrue under the adapter; only the
    ///      adapter can collect them, then they're swept to the principal).
    function test_claimInteractionRewards_gated() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(
            AggregatorAdapterImplementation.NotKeeperOrPrincipal.selector
        );
        adapter.claimInteractionRewards();
        // Keeper passes the adapter gate and forwards to the Diamond — which
        // reverts here because emissions aren't launched in this harness. The
        // protocol-side revert proves the forwarder reached the Diamond.
        vm.prank(keeper);
        vm.expectRevert(
            IVaipakamErrors.InteractionEmissionsNotStarted.selector
        );
        adapter.claimInteractionRewards();
    }

    // ─── 11. #627 — principal KYC screen (fork-only; inert on retail) ───────────

    /// @dev #627 — when KYC enforcement is ON, matchLoan screens the REAL
    ///      principal at the exact accept-path valuation. A fill of 500 (lending)
    ///      + 1000 (collateral) ≈ 1500 numeraire sits in the Tier1 band ([1k,10k)),
    ///      so an unverified aggregator is blocked BEFORE the match (the screen
    ///      fires ahead of the Diamond's acceptor check on the adapter).
    function test_matchLoan_principalKyc_blocksUnverified() public {
        _deposit(DEPOSIT);
        vm.prank(owner);
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        uint256 fill = 500 ether;
        uint256 cp = _postBorrower(fill); // borrower is Tier2; value ≈ 1500
        vm.prank(keeper);
        vm.expectRevert(
            AggregatorAdapterImplementation.PrincipalNotKYCd.selector
        );
        adapter.matchLoan(cp, fill);
    }

    /// @dev #627 — with KYC ON, a Tier1 aggregator (and Tier1 adapter, the
    ///      on-chain lender) clears both the principal screen and the Diamond's
    ///      acceptor check, so the fill proceeds.
    function test_matchLoan_principalKyc_allowsVerified() public {
        _deposit(DEPOSIT);
        vm.startPrank(owner);
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        ProfileFacet(address(diamond))
            .updateKYCTier(aggregator, LibVaipakam.KYCTier.Tier1);
        ProfileFacet(address(diamond))
            .updateKYCTier(address(adapter), LibVaipakam.KYCTier.Tier1);
        vm.stopPrank();
        uint256 loanId = _match(500 ether);
        assertGt(loanId, 0, "verified principal + adapter -> fill succeeds");
    }
}
