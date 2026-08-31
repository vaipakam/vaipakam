// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {PerkFacet} from "../src/facets/PerkFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  PerkSpendTest
 * @notice #1204 (E-2, plan §M6) — the spend-gated perk channel.
 *
 *         The property under test is ABSORPTION, not the perks themselves:
 *         a purchase must move VPFI from the buyer's vault into Diamond
 *         custody and credit the recycle bucket under its own source, so the
 *         day feed and the reported cumulative can tell perk spend apart from
 *         the notification tariff and the Full tariff.
 *
 *         The design's open decisions — which perks ship, at what price —
 *         are configuration, so the tests assert the DARK default as
 *         carefully as the armed behaviour: a perk with no configured price
 *         cannot be bought at all, and that is what a fresh deployment has.
 */
contract PerkSpendTest is SetupTest {
    VPFIToken internal vpfiToken;
    address internal buyer;

    uint256 internal constant PERK_PRIORITY = 1;
    uint256 internal constant PERK_VISIBILITY = 2;

    event PerkPurchased(
        address indexed buyer,
        uint256 indexed perkId,
        uint256 units,
        uint256 vpfiSpent,
        uint64 entitledUntil,
        uint256 creditsAfter
    );

    function setUp() public {
        setupHelper();
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfiToken = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));

        buyer = lender;
        vpfiToken.transfer(buyer, 100e18);
        vm.startPrank(buyer);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();
    }

    function _perk() internal view returns (PerkFacet) {
        return PerkFacet(address(diamond));
    }

    /// Vault VPFI held by `who`, read from the vault proxy itself — the same
    /// way the notification-tariff suite measures a debit.
    function _vaultVpfi(address who) internal view returns (uint256) {
        return vpfiToken.balanceOf(
            VaultFactoryFacet(address(diamond)).getUserVaultAddress(who)
        );
    }

    // ── the dark default ────────────────────────────────────────────────

    function testUnpricedPerkCannotBeBought() public {
        // A fresh deployment prices nothing, so the whole channel is closed
        // until an owner arms a perk. This is the state the open design
        // decisions leave it in, and it must be a refusal rather than a
        // free grant.
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(PerkFacet.PerkNotForSale.selector, PERK_PRIORITY)
        );
        _perk().purchasePerk(PERK_PRIORITY, 1);
    }

    function testDisarmingStopsSalesWithoutTouchingHeldEntitlements() public {
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);
        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);
        (bool activeBefore, , ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);
        assertTrue(activeBefore, "entitlement held after purchase");

        _perk().setPerkConfig(PERK_PRIORITY, 0, 1 days);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(PerkFacet.PerkNotForSale.selector, PERK_PRIORITY)
        );
        _perk().purchasePerk(PERK_PRIORITY, 1);

        // Disarming is a decision about FUTURE sales. Revoking what someone
        // already paid for would make the purchase refundable-by-governance,
        // which is the deposit shape this channel deliberately is not.
        (bool activeAfter, , ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);
        assertTrue(activeAfter, "held entitlement survives disarming");
    }

    function testOnlyAdminCanConfigure() public {
        vm.prank(buyer);
        vm.expectRevert();
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);
    }

    // ── the absorption property ─────────────────────────────────────────

    function testPurchaseMovesVaultVpfiIntoTheRecycleBucket() public {
        _perk().setPerkConfig(PERK_PRIORITY, 3e18, 1 days);

        uint256 bucketBefore = ConfigFacet(address(diamond)).getRecycleBucket();
        uint256 vaultBefore = _vaultVpfi(buyer);
        uint256 diamondBefore = vpfiToken.balanceOf(address(diamond));

        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 2);

        uint256 spend = 6e18;
        assertEq(
            vaultBefore - _vaultVpfi(buyer),
            spend,
            "buyer's vault debited by price x units"
        );
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket() - bucketBefore,
            spend,
            "bucket credited by the same amount"
        );
        // The Diamond's own VPFI balance rises: unlike a forfeit (a ledger
        // re-label of tokens already held) this is fresh value arriving from
        // a user's vault.
        assertEq(
            vpfiToken.balanceOf(address(diamond)) - diamondBefore,
            spend,
            "tokens really moved into Diamond custody"
        );
        assertEq(_perk().getPerkSpendCumulative(), spend, "channel cumulative");
    }

    function testPurchaseAnnouncesItselfAsSpendGatedPerk() public {
        // The source discriminator is the whole reason for appending an enum
        // member instead of reusing NotificationFee: the day feed has to be
        // readable per class.
        _perk().setPerkConfig(PERK_VISIBILITY, 2e18, 0);

        vm.recordLogs();
        vm.prank(buyer);
        _perk().purchasePerk(PERK_VISIBILITY, 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        // WHICH event fires depends on whether the emission schedule is
        // active, and on a fresh test deployment it is not — so a credit
        // announces itself as pre-launch. The class discriminator is the
        // assertion either way; keying the test on one event would make it
        // pass for a reason unrelated to the property (and it did fail
        // exactly that way first).
        bytes32 live = keccak256("VpfiRecycled(uint8,uint256,uint256,uint256)");
        bytes32 preLaunch = keccak256("VpfiRecycledPreLaunch(uint8,uint256,uint256)");
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            bytes32 t = logs[i].topics[0];
            if (t != live && t != preLaunch) continue;
            seen = true;
            assertEq(
                uint256(logs[i].topics[1]),
                uint256(uint8(LibVpfiRecycle.RecycleSource.SpendGatedPerk)),
                "source is SpendGatedPerk"
            );
            assertEq(uint256(logs[i].topics[2]), PERK_VISIBILITY, "refId is the perk id");
        }
        assertTrue(seen, "the purchase announced a recycle credit");
    }

    function testCreditedDayFeedCountsPerkSpend() public {
        // Perk spend is fresh-from-user absorption, so it belongs in the
        // day-bucketed feed the governor's trailing average reads — the
        // distinction between `credit` and `creditCustodyRelocated`.
        _perk().setPerkConfig(PERK_PRIORITY, 4e18, 1 days);
        uint256 cumBefore = ConfigFacet(address(diamond)).getRecycleCreditedCumulative();

        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);

        assertEq(
            ConfigFacet(address(diamond)).getRecycleCreditedCumulative() - cumBefore,
            4e18,
            "counted as genuine absorption, not relocated custody"
        );
    }

    // ── entitlement shapes ──────────────────────────────────────────────

    function testTimedEntitlementStacksRatherThanBurningTheRemainder() public {
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);

        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);
        (, uint64 firstUntil, ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);

        // Buy again while the first window is still open. Buying early must
        // not cost the buyer the unused remainder.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);
        (, uint64 secondUntil, ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);

        assertEq(secondUntil, firstUntil + 1 days, "second window extends the first");
    }

    function testLapsedTimedEntitlementRestartsFromNow() public {
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);
        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);

        vm.warp(block.timestamp + 10 days);
        (bool active, , ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);
        assertFalse(active, "entitlement lapsed");

        vm.prank(buyer);
        _perk().purchasePerk(PERK_PRIORITY, 1);
        (, uint64 until, ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);
        assertEq(until, uint64(block.timestamp + 1 days), "restarts from now, not from the stale expiry");
    }

    function testCountedPerkAccumulatesCredits() public {
        _perk().setPerkConfig(PERK_VISIBILITY, 1e18, 0);
        vm.prank(buyer);
        _perk().purchasePerk(PERK_VISIBILITY, 3);
        (bool active, uint64 until, uint256 credits) =
            _perk().getPerkEntitlement(buyer, PERK_VISIBILITY);
        assertTrue(active, "counted units make the perk active");
        assertEq(until, 0, "a counted perk has no expiry");
        assertEq(credits, 3, "three units held");
    }

    function testCreditsAreConsumedOnlyThroughTheDiamond() public {
        _perk().setPerkConfig(PERK_VISIBILITY, 1e18, 0);
        vm.prank(buyer);
        _perk().purchasePerk(PERK_VISIBILITY, 1);

        // An open `consumePerkCredit` would let anyone burn another user's
        // paid-for units.
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _perk().consumePerkCredit(buyer, PERK_VISIBILITY);
    }

    function testZeroUnitsIsRefusedRatherThanSilentlyIgnored() public {
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);
        vm.prank(buyer);
        vm.expectRevert(PerkFacet.PerkUnitsZero.selector);
        _perk().purchasePerk(PERK_PRIORITY, 0);
    }

    function testHugeUnitCountSaturatesRatherThanWrappingTheExpiry() public {
        // The arithmetic is checked but the uint64 CAST is not, so a wrap
        // would sell the buyer a near expiry for an enormous price — a silent
        // loss in the buyer's direction. Saturation makes it loud-by-absence.
        _perk().setPerkConfig(PERK_PRIORITY, 1, type(uint32).max);
        uint256 units = uint256(type(uint64).max) / uint256(type(uint32).max) + 2;
        vpfiToken.transfer(buyer, units);
        vm.startPrank(buyer);
        vpfiToken.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(units);
        _perk().purchasePerk(PERK_PRIORITY, units);
        vm.stopPrank();

        (, uint64 until, ) = _perk().getPerkEntitlement(buyer, PERK_PRIORITY);
        assertEq(until, type(uint64).max, "expiry saturates instead of wrapping");
    }

    function testPurchaseWithAnEmptyVaultReverts() public {
        _perk().setPerkConfig(PERK_PRIORITY, 1e18, 1 days);
        address pauper = makeAddr("pauper");
        vm.prank(pauper);
        vm.expectRevert();
        _perk().purchasePerk(PERK_PRIORITY, 1);
    }
}
