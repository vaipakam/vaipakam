// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {ITreasuryFeeHost} from "../src/interfaces/ITreasuryFeeHost.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibTreasury} from "../src/libraries/LibTreasury.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";

/// @title  TreasuryFromVaultCodeTest
/// @notice #3569 (owner decision 2026-11-12, "Vault code only") — the
///         treasury is written in ONE place, the vault code's immutable
///         `TREASURY`. The Diamond reads it through the vault beacon, a
///         Diamond-side fee goes to the current code's treasury, and a vault
///         fee goes to the treasury that vault's OWN code names, so a vault
///         pinned to an older version pays that version's treasury. The
///         Diamond counts a fee as held only when it went to the Diamond.
contract TreasuryFromVaultCodeTest is SetupTest {
    VaultBeacon internal beacon;
    address internal bVault;
    address internal newTreasury;
    uint256 internal v1;
    uint256 internal v2;

    function setUp() public {
        setupHelper();
        beacon = VaultBeacon(VaultFactoryFacet(address(diamond)).getVaultBeacon());
        bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        v1 = beacon.currentVersionId();

        newTreasury = makeAddr("newTreasury");
        VaultOutflowTypes.VaultEndpoints memory e = LibTestVaultBeacon.endpointsOf(address(diamond));
        e.treasury = newTreasury;
        address current = beacon.implementation();
        address impl2 = ArtifactDeploy.deploy(
            type(VaipakamVaultImplementation).name,
            abi.encode(VaipakamVaultImplementation(current).POSITION_NFT(), e)
        );
        v2 = beacon.registerVersion(impl2);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _makeV2Current() internal {
        beacon.proposeCurrentVersion(v2);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeCurrentVersion();
    }

    function _pinBorrowerTo(uint256 id) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPk, beacon.pinChangeDigest(bVault, id));
        vm.prank(borrower);
        VaultDepositoryFacet(address(diamond)).pinVaultVersion(id, abi.encodePacked(r, s, v));
        assertEq(beacon.resolvedVersionOf(bVault), id, "the borrower's vault runs the pinned version");
    }

    function _fundVault(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(bVault, amount);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower, mockERC20, amount);
    }

    function _held() internal view returns (uint256) {
        return TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
    }

    function _vaultFee(uint256 amount) internal returns (uint256 accrued) {
        vm.prank(address(diamond));
        accrued = TreasuryFeeFacet(address(diamond)).collectFeeFromVault(borrower, mockERC20, amount, ITreasuryFeeHost.FeeBasis(ITreasuryFeeHost.FeeKind.Other, 0, 0));
    }

    // ─── The Diamond reads the vault code ────────────────────────────────

    /// @notice `getTreasury` is the current vault code's TREASURY, and moves
    ///         when the beacon's current version moves (after its wait).
    function test_GetTreasuryFollowsTheCurrentVaultCode() public {
        assertEq(AdminFacet(address(diamond)).getTreasury(), address(diamond), "the test install names the Diamond");
        _makeV2Current();
        assertEq(AdminFacet(address(diamond)).getTreasury(), newTreasury, "new vault code moves the treasury");
    }

    // ─── Vault fees follow the vault's own code ──────────────────────────

    /// @notice A vault pinned to v1 keeps paying v1's treasury (the Diamond)
    ///         after v2 is current, and the Diamond counts that fee as held.
    function test_PinnedVaultPaysItsOwnCodesTreasury_AndTheDiamondCountsIt() public {
        _pinBorrowerTo(v1);
        _makeV2Current();
        _fundVault(10 ether);
        uint256 held0 = _held();
        uint256 diamondBal0 = IERC20(mockERC20).balanceOf(address(diamond));

        uint256 accrued = _vaultFee(4 ether);

        assertEq(accrued, 4 ether);
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)) - diamondBal0, 4 ether, "paid to v1's treasury");
        assertEq(IERC20(mockERC20).balanceOf(newTreasury), 0, "not to the current code's");
        assertEq(_held() - held0, 4 ether, "the Diamond holds and counts it");
    }

    /// @notice An unpinned vault runs v2 and pays v2's external treasury;
    ///         nothing is counted as held at the Diamond.
    function test_UnpinnedVaultPaysTheNewTreasury_AndNothingIsHeld() public {
        _makeV2Current();
        _fundVault(10 ether);
        uint256 held0 = _held();

        _vaultFee(4 ether);

        assertEq(IERC20(mockERC20).balanceOf(newTreasury), 4 ether, "paid to the current code's treasury");
        assertEq(_held(), held0, "an external treasury leaves no balance at the Diamond");
    }

    /// @notice The opposite pin: the Diamond is the current treasury, but a
    ///         vault pinned to v2 pays v2's external treasury, and the Diamond
    ///         must not count that fee as held.
    function test_VaultPinnedToExternalTreasuryCodeIsNotCountedAtTheDiamond() public {
        _pinBorrowerTo(v2);
        _fundVault(10 ether);
        uint256 held0 = _held();
        assertEq(AdminFacet(address(diamond)).getTreasury(), address(diamond));

        _vaultFee(4 ether);

        assertEq(IERC20(mockERC20).balanceOf(newTreasury), 4 ether, "paid to the pinned code's treasury");
        assertEq(_held(), held0, "not counted as held at the Diamond");
    }

    /// @notice Revoking the version a vault is pinned to moves that vault
    ///         onto the current code, and its fees with it.
    function test_RevokeMovesAPinnedVaultsFees() public {
        _pinBorrowerTo(v1);
        _makeV2Current();
        // v1 is no longer current, so its revoke names no successor.
        beacon.proposeRevoke(v1, 0);
        vm.warp(block.timestamp + beacon.MIN_CODE_DELAY());
        beacon.executeRevoke();
        assertEq(beacon.resolvedVersionOf(bVault), v2, "the pinned vault runs the current code");

        _fundVault(10 ether);
        _vaultFee(4 ether);
        assertEq(IERC20(mockERC20).balanceOf(newTreasury), 4 ether, "its fees go to the current treasury");
    }

    // ─── Diamond-side fees follow the current code ───────────────────────

    /// @notice A payer's wallet fee goes to the current code's treasury.
    function test_PayerFeeGoesToTheCurrentTreasury() public {
        _makeV2Current();
        ERC20Mock(mockERC20).mint(borrower, 5 ether);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), 5 ether);
        uint256 held0 = _held();

        vm.prank(address(diamond));
        TreasuryFeeFacet(address(diamond)).collectFeeFromPayer(borrower, mockERC20, 5 ether, ITreasuryFeeHost.FeeBasis(ITreasuryFeeHost.FeeKind.Other, 0, 0));

        assertEq(IERC20(mockERC20).balanceOf(newTreasury), 5 ether);
        assertEq(_held(), held0);
    }

    /// @notice Vault code naming no treasury refuses a fee by name, never
    ///         sending it to the zero address.
    function test_UnsetTreasuryRefusesTheFeeByName() public {
        LibTestVaultBeacon.setTreasury(address(diamond), address(0));
        assertEq(AdminFacet(address(diamond)).getTreasury(), address(0));
        vm.prank(address(diamond));
        vm.expectRevert(LibTreasury.TreasuryUnset.selector);
        TreasuryFeeFacet(address(diamond)).collectFeeFromDiamond(mockERC20, 1 ether, ITreasuryFeeHost.FeeBasis(ITreasuryFeeHost.FeeKind.Other, 0, 0));
    }

    /// @notice There is no setter left to move the treasury.
    function test_RetiredSetterIsNotRouted() public {
        (bool ok, bytes memory ret) =
            address(diamond).call(abi.encodeWithSignature("setTreasury(address)", makeAddr("elsewhere")));
        assertFalse(ok);
        assertEq(bytes4(ret), VaipakamDiamond.FunctionDoesNotExist.selector);
    }
}
