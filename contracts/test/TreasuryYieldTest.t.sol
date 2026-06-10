// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {LibTreasuryYield} from "../src/libraries/LibTreasuryYield.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Mock Aave V3 Pool — accepts supply, records balance,
///      returns same amount on withdraw.
contract MockAavePool {
    mapping(address => uint256) public supplied;

    function supply(
        address asset,
        uint256 amount,
        address /* onBehalfOf */,
        uint16 /* referralCode */
    ) external {
        ERC20Mock(asset).transferFrom(msg.sender, address(this), amount);
        supplied[asset] += amount;
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256) {
        require(supplied[asset] >= amount, "insufficient");
        supplied[asset] -= amount;
        ERC20Mock(asset).transfer(to, amount);
        return amount;
    }
}

/// @dev Mock Lido staking — receives ETH; returns submitted amount.
contract MockLidoStaking {
    uint256 public totalSubmitted;
    receive() external payable {}
    function submit(address /* _referral */) external payable returns (uint256) {
        totalSubmitted += msg.value;
        return msg.value;
    }
}

contract TreasuryYieldTest is SetupTest {
    ERC20Mock internal wbtc;
    MockAavePool internal aave;
    MockLidoStaking internal lido;

    uint256 internal constant SEED = 1_000e8;

    function setUp() public {
        setupHelper();
        wbtc = new ERC20Mock("WBTC", "WBTC", 8);
        aave = new MockAavePool();
        lido = new MockLidoStaking();
        // Mint to the diamond + seed the treasuryBalances slot
        // directly so deploy/withdraw can debit it.
        wbtc.mint(address(diamond), SEED);
        _seedTreasuryBalance(address(wbtc), SEED);
    }

    /// @dev Write directly into `s.treasuryBalances[token]` via the
    ///      Diamond's storage slot. Path:
    ///        base = keccak256("vaipakam.storage")
    ///        mappingSlot = base + offset_of(treasuryBalances)
    ///        valueSlot = keccak256(abi.encode(token, mappingSlot))
    ///      For test simplicity we crack this open via vm.load /
    ///      vm.store after first probing where the diamond reports
    ///      the value via getTreasuryBalance.
    function _seedTreasuryBalance(address token, uint256 amount) internal {
        // The slot for `treasuryBalances[token]` is deterministic
        // once we know the mapping's slot index within the Storage
        // struct. Probe iteratively: try slot offsets 0..100 against
        // the base, find which slot offset makes
        // `vm.load(diamond, valueSlot)` reflect a known-set value.
        // EIP-7201 namespaced storage position, matches
        // `LibVaipakam.VANGKI_STORAGE_POSITION` exactly.
        bytes32 baseSlot = 0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00;
        // Set sentinel value at a wide range of candidate offsets.
        // For determinism in a single test run, just write at the
        // offset we observe in the live storage layout. The Storage
        // struct's `treasuryBalances` mapping is at offset 0 of the
        // entire struct (it's the first mapping field) — but we
        // can't rely on that across compiler versions.
        //
        // Safer: write via a known set+read API. Since no such API
        // exists in TreasuryFacet, we use vm.store at the canonical
        // slot, computed from the offset known by inspecting
        // `forge inspect TreasuryFacet storageLayout`. For this test
        // we hard-code the offset and verify it by reading back.
        //
        // Iterate slot offsets 0..200; pick the one where writing
        // and reading back agrees with the diamond's
        // `getTreasuryBalance`.
        for (uint256 i = 0; i < 5000; ++i) {
            bytes32 mappingSlot = bytes32(uint256(baseSlot) + i);
            bytes32 valueSlot = keccak256(abi.encode(token, mappingSlot));
            // Snapshot prior value so we can restore if this probe misses.
            bytes32 prior = vm.load(address(diamond), valueSlot);
            vm.store(address(diamond), valueSlot, bytes32(amount));
            uint256 readBack = TreasuryFacet(address(diamond)).getTreasuryBalance(token);
            if (readBack == amount) {
                return;
            }
            // Restore so we don't corrupt other state.
            vm.store(address(diamond), valueSlot, prior);
        }
        revert("could not locate treasuryBalances slot");
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    // ─── Config ──────────────────────────────────────────────────

    function test_SetTreasuryYieldVenue_HappyPath() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        assertEq(
            _t().getTreasuryYieldVenue(address(wbtc)),
            LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3
        );
    }

    function test_SetTreasuryYieldVenue_RevertWhen_InvalidVenue() public {
        vm.expectRevert();
        _t().setTreasuryYieldVenue(address(wbtc), 99);
    }

    function test_SetTreasuryYieldVenue_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setTreasuryYieldVenue(address(wbtc), 1);
    }

    function test_SetTreasuryExternalYieldMaxBps_RevertWhen_AboveMax() public {
        vm.expectRevert();
        _t().setTreasuryExternalYieldMaxBps(9000);
    }

    function test_GetTreasuryExternalYieldMaxBps_DefaultsTo7000() public view {
        assertEq(_t().getTreasuryExternalYieldMaxBps(), 7000);
    }

    function test_SetAaveV3Pool_HappyPath() public {
        _t().setAaveV3Pool(address(aave));
        assertEq(_t().getAaveV3Pool(), address(aave));
    }

    function test_SetAaveV3Pool_RevertWhen_NotContract() public {
        vm.expectRevert();
        _t().setAaveV3Pool(makeAddr("eoaPool"));
    }

    function test_SetLidoStaking_HappyPath() public {
        _t().setLidoStaking(address(lido));
        assertEq(_t().getLidoStaking(), address(lido));
    }

    // ─── Aave deploy + withdraw ──────────────────────────────────

    function test_AaveDeploy_HappyPath() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));

        // Default cap 7000bps of 1000 WBTC = 700 WBTC.
        uint256 amount = 500e8;
        _t().deployTreasuryYield(address(wbtc), amount);

        assertEq(wbtc.balanceOf(address(aave)), amount, "Aave got WBTC");
        assertEq(_t().getTreasuryDeployedExternal(address(wbtc)), amount, "deployed counter");
        assertEq(_t().getTreasuryBalance(address(wbtc)), SEED - amount, "treasury debited");
    }

    function test_AaveWithdraw_HappyPath() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));
        _t().deployTreasuryYield(address(wbtc), 500e8);

        _t().withdrawTreasuryYield(address(wbtc), 200e8);

        assertEq(_t().getTreasuryDeployedExternal(address(wbtc)), 300e8, "remaining deployed");
        assertEq(_t().getTreasuryBalance(address(wbtc)), SEED - 500e8 + 200e8, "treasury credited");
    }

    function test_AaveDeploy_RevertWhen_VenueNotConfigured() public {
        _t().setAaveV3Pool(address(aave));
        vm.expectRevert();
        _t().deployTreasuryYield(address(wbtc), 100e8);
    }

    function test_AaveDeploy_RevertWhen_PoolNotSet() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        vm.expectRevert();
        _t().deployTreasuryYield(address(wbtc), 100e8);
    }

    function test_AaveDeploy_RevertWhen_ExceedsCap() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));

        // Default cap 7000bps of 1000 WBTC = 700 WBTC.
        // 800 WBTC exceeds the cap.
        vm.expectRevert();
        _t().deployTreasuryYield(address(wbtc), 800e8);
    }

    function test_Withdraw_RevertWhen_ExceedsDeployed() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));
        _t().deployTreasuryYield(address(wbtc), 100e8);

        vm.expectRevert();
        _t().withdrawTreasuryYield(address(wbtc), 200e8);
    }

    // ─── Round-1 P1 — Lido deferred ───────────────────────────────

    function test_LidoDeploy_RevertWhen_PhaseZeroDeferral() public {
        address ethSentinel = makeAddr("ethSentinel");
        _t().setTreasuryYieldVenue(ethSentinel, LibVaipakam.TREASURY_YIELD_VENUE_LIDO_STETH);
        _t().setLidoStaking(address(lido));
        vm.expectRevert(LibTreasuryYield.LidoVenueNotYetSupported.selector);
        _t().deployTreasuryYield(ethSentinel, 1 ether);
    }

    // ─── Round-2 P1 #1 — Aave pool rotation blocked while deployed ──

    function test_SetAaveV3Pool_RevertWhen_RotationWithDeployedPrincipal() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));
        _t().deployTreasuryYield(address(wbtc), 100e8);

        // Try to rotate to a new pool — should revert.
        MockAavePool newAave = new MockAavePool();
        vm.expectRevert();
        _t().setAaveV3Pool(address(newAave));

        // Same-pool write (idempotent) is allowed.
        _t().setAaveV3Pool(address(aave));
        assertEq(_t().getAaveV3Pool(), address(aave));

        // Withdraw frees the rotation.
        _t().withdrawTreasuryYield(address(wbtc), 100e8);
        _t().setAaveV3Pool(address(newAave));
        assertEq(_t().getAaveV3Pool(), address(newAave));
    }

    // ─── Round-1 P2 #1 — Venue change blocked while deployed ─────

    function test_SetTreasuryYieldVenue_RevertWhen_DeployedPrincipalExists() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));
        _t().deployTreasuryYield(address(wbtc), 100e8);

        // Attempt to switch the venue — should revert because principal is deployed.
        vm.expectRevert();
        _t().setTreasuryYieldVenue(
            address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_NONE
        );

        // Same-venue write (idempotent) is allowed.
        _t().setTreasuryYieldVenue(
            address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3
        );

        // After withdrawing everything, change is allowed.
        _t().withdrawTreasuryYield(address(wbtc), 100e8);
        _t().setTreasuryYieldVenue(
            address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_NONE
        );
        assertEq(
            _t().getTreasuryYieldVenue(address(wbtc)),
            LibVaipakam.TREASURY_YIELD_VENUE_NONE
        );
    }

    function test_CapEnforced_AfterPartialDeploy() public {
        _t().setTreasuryYieldVenue(address(wbtc), LibVaipakam.TREASURY_YIELD_VENUE_AAVE_V3);
        _t().setAaveV3Pool(address(aave));

        // Deploy 500 WBTC (under cap of 700).
        _t().deployTreasuryYield(address(wbtc), 500e8);

        // Try to deploy another 300 WBTC. cap = 700, already-deployed
        // = 500 + 300 = 800 > 700. Revert.
        vm.expectRevert();
        _t().deployTreasuryYield(address(wbtc), 300e8);

        // 200 WBTC additional is OK (500 + 200 = 700, exactly the cap).
        _t().deployTreasuryYield(address(wbtc), 200e8);
        assertEq(_t().getTreasuryDeployedExternal(address(wbtc)), 700e8);
    }
}
