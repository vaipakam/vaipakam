// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title VPFIDiscountBoundariesTest
/// @notice Pinpoint-coverage for the T0/T1/T2/T3/T4 tier boundaries defined
///         in docs/BorrowerVPFIDiscountMechanism.md and docs/TokenomicsTechSpec.md
///         §6. Each boundary value is checked twice — one wei below and
///         at/above the threshold — to lock the semantics:
///
///           0                               T0 (0%)
///           99 VPFI                         T0 (0%)
///           100 VPFI          (T1 floor)    T1 (10%)
///           999 VPFI                        T1 (10%)
///           1,000 VPFI        (T2 floor)    T2 (15%)
///           4,999 VPFI                      T2 (15%)
///           5,000 VPFI        (T3 floor)    T3 (20%)
///           20,000 VPFI       (T3 ceiling)  T3 (20%)   <-- inclusive
///           20,000 + 1 wei                  T4 (24%)
///
///         Also covers the platform-level consent toggle roundtrip because
///         the consent flag is a hard prerequisite for the discount to be
///         applied at fee-collection time.
contract VPFIDiscountBoundariesTest is SetupTest {
    VPFIToken internal vpfi;
    VPFIDiscountFacet internal discountFacet;

    uint256 internal constant DIAMOND_SEED = 10_000_000 ether;

    address internal alice;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        discountFacet = new VPFIDiscountFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(discountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        alice = makeAddr("alice");
        vpfi.mint(alice, 100_000 ether);
    }

    function _facet() internal view returns (VPFIDiscountFacet) {
        return VPFIDiscountFacet(address(diamond));
    }

    function _resetEscrowTo(uint256 target) internal {
        uint256 current = _currentEscrowBalance();
        if (target > current) {
            _deposit(alice, target - current);
        } else if (target < current) {
            _withdraw(alice, current - target);
        }
    }

    function _currentEscrowBalance() internal view returns (uint256 bal) {
        (, bal, ) = _facet().getVPFIDiscountTier(alice);
    }

    function _deposit(address user, uint256 amt) internal {
        if (amt == 0) return;
        vm.startPrank(user);
        vpfi.approve(address(diamond), amt);
        _facet().depositVPFIToEscrow(amt);
        vm.stopPrank();
    }

    function _withdraw(address user, uint256 amt) internal {
        if (amt == 0) return;
        vm.prank(user);
        _facet().withdrawVPFIFromEscrow(amt);
    }

    function _assertTier(
        uint256 bal,
        uint8 expectedTier,
        uint256 expectedBps,
        string memory tag
    ) internal {
        _resetEscrowTo(bal);
        (uint8 tier, uint256 escrowBal, uint256 discountBps) = _facet()
            .getVPFIDiscountTier(alice);
        assertEq(uint256(tier), uint256(expectedTier), tag);
        assertEq(discountBps, expectedBps, tag);
        assertEq(escrowBal, bal, tag);
    }

    // ─── T0 boundary ─────────────────────────────────────────────────────────

    function testTier0AtZero() public {
        _assertTier(0, 0, 0, "T0 at zero");
    }

    function testTier0JustBelowT1() public {
        // 100 VPFI - 1 wei -> still T0.
        _assertTier(100 ether - 1, 0, 0, "T0 at 99.999... VPFI");
    }

    // ─── T0 -> T1 boundary ───────────────────────────────────────────────────

    function testTier1AtFloor() public {
        _assertTier(100 ether, 1, 1000, "T1 at 100 VPFI");
    }

    function testTier1JustBelowT2() public {
        _assertTier(1_000 ether - 1, 1, 1000, "T1 at 999.999... VPFI");
    }

    // ─── T1 -> T2 boundary ───────────────────────────────────────────────────

    function testTier2AtFloor() public {
        _assertTier(1_000 ether, 2, 1500, "T2 at 1,000 VPFI");
    }

    function testTier2JustBelowT3() public {
        _assertTier(5_000 ether - 1, 2, 1500, "T2 at 4,999.999... VPFI");
    }

    // ─── T2 -> T3 boundary ───────────────────────────────────────────────────

    function testTier3AtFloor() public {
        _assertTier(5_000 ether, 3, 2000, "T3 at 5,000 VPFI");
    }

    function testTier3AtCeilingInclusive() public {
        // Spec: "20k inclusive" — exactly 20,000 VPFI is T3, not T4.
        _assertTier(20_000 ether, 3, 2000, "T3 at 20,000 VPFI (inclusive)");
    }

    // ─── T3 -> T4 boundary ───────────────────────────────────────────────────

    function testTier4JustAboveT3Ceiling() public {
        // Strictly above 20,000 VPFI -> T4.
        _assertTier(20_000 ether + 1, 4, 2400, "T4 at 20,000 + 1 wei");
    }

    function testTier4AtLargeBalance() public {
        _assertTier(50_000 ether, 4, 2400, "T4 at 50,000 VPFI");
    }

    // ─── Monotonicity sanity ────────────────────────────────────────────────

    function testDiscountBpsMonotonicAcrossTiers() public {
        // Walk through one sample per tier; bps must be non-decreasing.
        _resetEscrowTo(0);
        (, , uint256 d0) = _facet().getVPFIDiscountTier(alice);

        _resetEscrowTo(100 ether);
        (, , uint256 d1) = _facet().getVPFIDiscountTier(alice);

        _resetEscrowTo(1_000 ether);
        (, , uint256 d2) = _facet().getVPFIDiscountTier(alice);

        _resetEscrowTo(5_000 ether);
        (, , uint256 d3) = _facet().getVPFIDiscountTier(alice);

        _resetEscrowTo(20_001 ether);
        (, , uint256 d4) = _facet().getVPFIDiscountTier(alice);

        assertLt(d0, d1, "T0 < T1");
        assertLt(d1, d2, "T1 < T2");
        assertLt(d2, d3, "T2 < T3");
        assertLt(d3, d4, "T3 < T4");
    }

    // ─── Consent roundtrip ──────────────────────────────────────────────────

    function testConsentDefaultsOff() public {
        assertFalse(
            _facet().getVPFIDiscountConsent(alice),
            "fresh user defaults to consent off"
        );
    }

    function testConsentToggleRoundtrip() public {
        vm.prank(alice);
        _facet().setVPFIDiscountConsent(true);
        assertTrue(
            _facet().getVPFIDiscountConsent(alice),
            "consent on after opt-in"
        );

        vm.prank(alice);
        _facet().setVPFIDiscountConsent(false);
        assertFalse(
            _facet().getVPFIDiscountConsent(alice),
            "consent off after opt-out"
        );
    }

    function testTierViewIndependentOfConsent() public {
        // Tier math is a pure balance lookup — consent state must not move it.
        _resetEscrowTo(5_000 ether);
        (uint8 tierOff, , uint256 bpsOff) = _facet().getVPFIDiscountTier(alice);
        assertEq(uint256(tierOff), 3);
        assertEq(bpsOff, 2000);

        vm.prank(alice);
        _facet().setVPFIDiscountConsent(true);

        (uint8 tierOn, , uint256 bpsOn) = _facet().getVPFIDiscountTier(alice);
        assertEq(uint256(tierOn), 3, "tier unchanged by consent flip");
        assertEq(bpsOn, 2000, "bps unchanged by consent flip");
    }

    // ─── Post-withdrawal tier demotion ──────────────────────────────────────

    function testTierDemotesAfterEscrowWithdrawal() public {
        _resetEscrowTo(5_000 ether);
        (uint8 before_, , ) = _facet().getVPFIDiscountTier(alice);
        assertEq(uint256(before_), 3);

        // Withdraw down to below T1 floor.
        _withdraw(alice, 4_901 ether); // 5000 - 4901 = 99
        (uint8 after_, uint256 bal, uint256 bps) = _facet()
            .getVPFIDiscountTier(alice);
        assertEq(uint256(after_), 0, "demoted to T0");
        assertEq(bal, 99 ether, "escrow residual");
        assertEq(bps, 0, "T0 has no discount");
    }
}
