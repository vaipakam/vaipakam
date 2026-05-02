// test/TreasuryFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title TreasuryFacetTest
 * @notice Full coverage for TreasuryFacet: claimTreasuryFees and getTreasuryBalance.
 */
contract TreasuryFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user;
    address mockERC20;

    DiamondCutFacet cutFacet;
    TreasuryFacet treasuryFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        user = makeAddr("user");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        treasuryFacet = new TreasuryFacet();
        adminFacet = new AdminFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(treasuryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTreasuryFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        AdminFacet(address(diamond)).setTreasury(address(diamond));
    }

    // ─── getTreasuryBalance ───────────────────────────────────────────────────

    function testGetTreasuryBalanceZeroInitially() public view {
        assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20), 0);
    }

    function testGetTreasuryBalanceReflectsDeposit() public {
        // Seed treasury balance via storage slot (simulate fee accumulation)
        // The treasuryBalances mapping is at storageSlot + some offset
        // Easiest: deal tokens to diamond and set balance via deal + vm.store approach.
        // Use deal to directly give diamond tokens and set balance in storage.
        ERC20Mock(mockERC20).mint(address(diamond), 1000 ether);

        // Manually seed treasuryBalances by writing to storage
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        // treasuryBalances is the mapping at offset within Storage
        // Find the slot for treasuryBalances mapping: iterate struct fields
        // Storage layout (from LibVaipakam.sol):
        // slot+0: nextOfferId, +1: nextLoanId, +2: nextTokenId
        // +3: vaipakamEscrowTemplate, +4: treasury, +5: zeroExProxy
        // +6: allowanceTarget, +7: numeraireChainlinkDenominator, +8: chainlnkRegistry
        // +9: usdtContract, +10: uniswapV3Factory, +11: diamondAddress
        // +12: loanToSaleOfferId mapping, +13: offers mapping, +14: loans mapping
        // +15: userEscrows mapping, +16: liquidAssets mapping, +17: assetRiskParams mapping
        // +18: treasuryBalances mapping
        uint256 treasuryBalancesSlot = uint256(baseSlot) + 17;
        bytes32 balanceSlot = keccak256(abi.encode(mockERC20, treasuryBalancesSlot));
        vm.store(address(diamond), balanceSlot, bytes32(uint256(500 ether)));

        assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20), 500 ether);
    }

    // ─── claimTreasuryFees ────────────────────────────────────────────────────

    function testClaimTreasuryFeesSuccess() public {
        // Set up: mint tokens to diamond and seed treasuryBalances
        ERC20Mock(mockERC20).mint(address(diamond), 1000 ether);
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        uint256 treasuryBalancesSlot = uint256(baseSlot) + 17;
        bytes32 balanceSlot = keccak256(abi.encode(mockERC20, treasuryBalancesSlot));
        vm.store(address(diamond), balanceSlot, bytes32(uint256(1000 ether)));

        address claimant = makeAddr("claimant");
        uint256 claimantBefore = ERC20(mockERC20).balanceOf(claimant);

        vm.expectEmit(true, false, true, true);
        emit TreasuryFacet.TreasuryFeesClaimed(mockERC20, 1000 ether, claimant);
        TreasuryFacet(address(diamond)).claimTreasuryFees(mockERC20, claimant);

        assertEq(ERC20(mockERC20).balanceOf(claimant) - claimantBefore, 1000 ether);
        assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20), 0);
    }

    function testClaimTreasuryFeesRevertsZeroBalance() public {
        vm.expectRevert(TreasuryFacet.ZeroAmount.selector);
        TreasuryFacet(address(diamond)).claimTreasuryFees(mockERC20, makeAddr("claimant"));
    }

    function testClaimTreasuryFeesRevertsZeroClaimant() public {
        // Seed some balance first
        ERC20Mock(mockERC20).mint(address(diamond), 100 ether);
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        uint256 treasuryBalancesSlot = uint256(baseSlot) + 17;
        bytes32 balanceSlot = keccak256(abi.encode(mockERC20, treasuryBalancesSlot));
        vm.store(address(diamond), balanceSlot, bytes32(uint256(100 ether)));

        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        TreasuryFacet(address(diamond)).claimTreasuryFees(mockERC20, address(0));
    }

    function testClaimTreasuryFeesRevertsNonOwner() public {
        ERC20Mock(mockERC20).mint(address(diamond), 100 ether);
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        uint256 treasuryBalancesSlot = uint256(baseSlot) + 17;
        bytes32 balanceSlot = keccak256(abi.encode(mockERC20, treasuryBalancesSlot));
        vm.store(address(diamond), balanceSlot, bytes32(uint256(100 ether)));

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user, LibAccessControl.ADMIN_ROLE));
        TreasuryFacet(address(diamond)).claimTreasuryFees(mockERC20, user);
    }

    function testClaimTreasuryFeesResetsBalance() public {
        ERC20Mock(mockERC20).mint(address(diamond), 200 ether);
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        uint256 treasuryBalancesSlot = uint256(baseSlot) + 17;
        bytes32 balanceSlot = keccak256(abi.encode(mockERC20, treasuryBalancesSlot));
        vm.store(address(diamond), balanceSlot, bytes32(uint256(200 ether)));

        TreasuryFacet(address(diamond)).claimTreasuryFees(mockERC20, owner);
        assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20), 0);
    }
}
