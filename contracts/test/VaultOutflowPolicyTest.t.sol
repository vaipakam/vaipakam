// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaultOutflowFacet} from "../src/facets/VaultOutflowFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {VaultOutflowTypes, OutflowReason} from "../src/vault/VaultOutflowTypes.sol";
import {RegistryKeys} from "../src/governance/RegistryKeys.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {MockProtocolRegistry} from "./mocks/MockProtocolRegistry.sol";

/**
 * @title  VaultOutflowPolicyTest
 * @notice #3205 part 2 Stage A — the one vault outflow policy.
 *         - Every policy entry (the struct entry and the scalar entries) runs
 *           the same class checks: one class matrix, each entry against it.
 *         - Layer 2: the vault refuses a destination its class may not reach
 *           with layer 1 bypassed (the vault called directly as the Diamond).
 *         - Own wallet only: without protected mode a withdrawal pays only the
 *           account's own wallet.
 *         - Just-in-time grants: registry spenders only, one at a time, the
 *           vault refuses every other outflow while one is open, and anyone
 *           may close it, which measures what the spender took.
 *         - The ERC-1155 listing escrow: the lot moves only into this vault's
 *           own escrow, and comes back on close.
 *         - Claim custody (the coordinator's condition): a parked share is
 *           reserved against its stored party's own withdrawal, and the claim
 *           pays the current holder.
 */
contract VaultOutflowPolicyTest is SetupTest {
    ERC20Mock internal token;
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");
    MockProtocolRegistry internal registry;

    function setUp() public {
        setupHelper();
        token = new ERC20Mock("Outflow", "OUT", 18);
        registry = LibTestVaultBeacon.registryOf(address(diamond));
        _fund(alice, 1000 ether);
    }

    // ─── Fixtures ────────────────────────────────────────────────────────

    /// @dev `amount` of `token` into `who`'s vault through the depository
    ///      (tracked and depository ledgers both credited).
    function _fund(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(diamond), amount);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), address(token), 0, amount);
        vm.stopPrank();
    }

    function _vault(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _outflow(VaultOutflowTypes.OutflowClass c, address to, uint256 amount)
        internal
        view
        returns (VaultOutflowTypes.Outflow memory o)
    {
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(token);
        o.amount = amount;
        o.to = to;
        o.class_ = c;
    }

    /// @dev Run outflow `o` from `user`'s vault through policy entry `entry`
    ///      (0 = struct, 1 = scalar args, 2 = compact Owner, 3 = compact
    ///      Diamond ERC-20), as the Diamond itself.
    function _run(uint8 entry, address user, VaultOutflowTypes.Outflow memory o) internal returns (uint256) {
        vm.prank(address(diamond));
        if (entry == 0) return VaultOutflowFacet(address(diamond)).vaultOutflow(user, o);
        if (entry == 1) {
            return VaultOutflowFacet(address(diamond)).vaultOutflowArgs(
                user, uint8(o.kind), o.asset, o.tokenId, o.amount, o.to, uint8(o.class_), o.ref, o.positionToken, o.reason
            );
        }
        if (entry == 2) {
            return VaultOutflowFacet(address(diamond)).vaultOutflowToOwner(
                user, uint8(o.kind), o.asset, o.tokenId, o.amount, o.reason
            );
        }
        return VaultOutflowFacet(address(diamond)).vaultOutflowToDiamondERC20(user, o.asset, o.amount, o.ref, o.reason);
    }

    // ─── One check path, every entry ─────────────────────────────────────

    /// @notice The Owner class through every entry that can carry it: the
    ///         owner's own wallet is paid, by the same amount.
    function test_ownerClassPaysTheOwnerThroughEveryEntry() public {
        for (uint8 entry; entry < 3; ++entry) {
            uint256 before = token.balanceOf(alice);
            uint256 got = _run(entry, alice, _outflow(VaultOutflowTypes.OutflowClass.Owner, alice, 10 ether));
            assertEq(got, 10 ether, "delivered");
            assertEq(token.balanceOf(alice) - before, 10 ether, "the owner's wallet received it");
        }
    }

    /// @notice The Owner class refuses any other recipient, through every
    ///         entry that takes a recipient (the compact Owner entry takes none).
    function test_ownerClassRefusesAnyoneElseThroughEveryEntry() public {
        for (uint8 entry; entry < 2; ++entry) {
            VaultOutflowTypes.Outflow memory o = _outflow(VaultOutflowTypes.OutflowClass.Owner, stranger, 1 ether);
            vm.expectRevert(
                abi.encodeWithSelector(
                    VaultOutflowFacet.OutflowRecipientInvalid.selector, VaultOutflowTypes.OutflowClass.Owner, stranger
                )
            );
            _run(entry, alice, o);
        }
    }

    /// @notice The Diamond-transient class through every entry that carries
    ///         it: the recipient is the Diamond whatever the caller named.
    function test_diamondTransientReachesOnlyTheDiamondThroughEveryEntry() public {
        uint8[3] memory entries = [uint8(0), 1, 3];
        for (uint256 i; i < entries.length; ++i) {
            uint256 before = token.balanceOf(address(diamond));
            _run(entries[i], alice, _outflow(VaultOutflowTypes.OutflowClass.DiamondTransient, stranger, 2 ether));
            assertEq(token.balanceOf(address(diamond)) - before, 2 ether, "the Diamond received it");
            assertEq(token.balanceOf(stranger), 0, "the named recipient is ignored");
        }
    }

    /// @notice The treasury class pays the configured treasury, never the
    ///         recipient the caller names, through both struct and scalars.
    function test_treasuryClassPaysTheTreasuryThroughEveryEntry() public {
        address treasury = registry.requirePointer(RegistryKeys.TREASURY);
        for (uint8 entry; entry < 2; ++entry) {
            uint256 before = token.balanceOf(treasury);
            _run(entry, alice, _outflow(VaultOutflowTypes.OutflowClass.Treasury, stranger, 3 ether));
            assertEq(token.balanceOf(treasury) - before, 3 ether, "the treasury received it");
        }
        assertEq(token.balanceOf(stranger), 0);
    }

    /// @notice A zero amount moves nothing, through every entry.
    function test_zeroIsANoOpThroughEveryEntry() public {
        for (uint8 entry; entry < 4; ++entry) {
            assertEq(_run(entry, alice, _outflow(VaultOutflowTypes.OutflowClass.Owner, alice, 0)), 0);
        }
    }

    // ─── Layer 2: the vault, with layer 1 bypassed ───────────────────────

    /// @dev Call alice's vault directly as the Diamond (layer 1 bypassed) and
    ///      expect the vault to refuse `o` for its class and recipient. The
    ///      vault address is read BEFORE the expectation, so the expectation
    ///      binds to the vault call itself.
    function _directRefused(VaultOutflowTypes.Outflow memory o) internal {
        address v = _vault(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamVaultImplementation.OutflowDestinationRefused.selector, o.class_, o.to)
        );
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).transferOut(o);
    }

    function test_theVaultRefusesAForgedOwnerPayout() public {
        _directRefused(_outflow(VaultOutflowTypes.OutflowClass.Owner, stranger, 1 ether));
    }

    function test_theVaultRefusesAForgedTreasuryPayout() public {
        _directRefused(_outflow(VaultOutflowTypes.OutflowClass.Treasury, stranger, 1 ether));
    }

    function test_theVaultRefusesAForgedDiamondLeg() public {
        _directRefused(_outflow(VaultOutflowTypes.OutflowClass.DiamondTransient, stranger, 1 ether));
    }

    /// @notice Claim custody reaches only a genuine Vaipakam vault (same
    ///         BeaconProxy code), never a wallet.
    function test_theVaultRefusesClaimCustodyToAWallet() public {
        _directRefused(_outflow(VaultOutflowTypes.OutflowClass.ClaimCustody, stranger, 1 ether));
    }

    /// @notice A holder payout reaches only the vault whose own owner record
    ///         is the position's holder: another genuine vault is refused.
    function test_theVaultRefusesAHolderPayoutToANonHolderVault() public {
        uint256 tokenId = 77_001;
        vm.prank(address(diamond));
        LibTestPositionNFT.core(address(diamond)).mint(alice, tokenId);
        _fund(stranger, 1 ether); // stranger now has a genuine vault
        address strangersVault = _vault(stranger);
        VaultOutflowTypes.Outflow memory o =
            _outflow(VaultOutflowTypes.OutflowClass.PositionHolder, strangersVault, 1 ether);
        o.positionToken = tokenId;
        _directRefused(o);
    }

    // ─── Own wallet only ─────────────────────────────────────────────────

    function test_aWithdrawalPaysOnlyTheOwnersWallet() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VaultDepositoryFacet.RecipientNotOwnWallet.selector, alice, stranger));
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            alice, uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 1 ether, stranger
        );
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            alice, uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 1 ether, alice
        );
        assertEq(token.balanceOf(alice) - before, 1 ether);
    }

    // ─── Just-in-time grants ─────────────────────────────────────────────

    function _grant(address spender, VaultOutflowTypes.GrantClass c, uint256 amount) internal {
        vm.prank(address(diamond));
        VaultOutflowFacet(address(diamond)).vaultGrant(
            alice,
            VaultOutflowTypes.Grant({
                kind: VaultOutflowTypes.AssetKind.ERC20,
                asset: address(token),
                tokenId: 0,
                amount: amount,
                spender: spender,
                class_: c,
                ref: 5
            })
        );
    }

    function test_aGrantNamesOnlyARegistrySpender() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.GrantRefused.selector, VaultOutflowTypes.GrantClass.OrderTaker, stranger
            )
        );
        _grant(stranger, VaultOutflowTypes.GrantClass.OrderTaker, 1 ether);
    }

    /// @notice One fill, one transaction: the grant exposes exactly its
    ///         amount, every other outflow is refused while it is open, a
    ///         party reentering during the fill cannot close it, and the
    ///         Diamond's close measures what the spender took. Driven inside
    ///         ONE call (an external self-call), so the transaction-scoped
    ///         rule holds on every forge version (CLAUDE.md: transient storage
    ///         does not survive between a test's top-level calls on forge 1.8+).
    function test_anOpenGrantBlocksEveryOtherOutflow_andOnlyTheDiamondClosesItInItsTx() public {
        address taker = makeAddr("orderProtocol");
        registry.setMember(RegistryKeys.SWAP_ADAPTERS, taker, true);
        this.oneFill(taker);
        // After the fill the vault is open for outflows again.
        _run(0, alice, _outflow(VaultOutflowTypes.OutflowClass.Owner, alice, 1 ether));
    }

    /// @dev The fill, as one transaction (called through `this`).
    function oneFill(address taker) external {
        _grant(taker, VaultOutflowTypes.GrantClass.OrderTaker, 4 ether);
        address v = _vault(alice);
        assertEq(token.allowance(v, taker), 4 ether, "the exact amount is approved");

        vm.expectRevert(abi.encodeWithSelector(VaipakamVaultImplementation.GrantOpen.selector, 5));
        _run(0, alice, _outflow(VaultOutflowTypes.OutflowClass.Owner, alice, 1 ether));

        // The spender takes part of it.
        vm.prank(taker);
        token.transferFrom(v, taker, 3 ether);

        // A reentering party cannot close the grant inside its transaction.
        vm.prank(stranger);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(v).closeGrant();

        // The Diamond closes it and books what the spender took.
        vm.prank(address(diamond));
        uint256 consumed = VaultOutflowFacet(address(diamond)).vaultCloseGrant(alice);
        assertEq(consumed, 3 ether, "what the spender took, measured from the approval");
        assertEq(token.allowance(v, taker), 0, "nothing left standing");
    }

    // ─── The ERC-1155 listing escrow ─────────────────────────────────────

    function test_aListingLotMovesOnlyIntoTheVaultsOwnEscrow() public {
        ERC1155Mock coll = ERC1155Mock(deployCode("ERC1155Mock.sol:ERC1155Mock"));
        address v = _vault(alice);
        vm.prank(address(diamond)); // the vault accepts NFTs only from the Diamond
        coll.mint(v, 7, 3);
        bytes32 key = keccak256("listing-key");
        VaultOutflowTypes.Outflow memory o = _outflow(VaultOutflowTypes.OutflowClass.ListingEscrow, stranger, 2);
        o.kind = VaultOutflowTypes.AssetKind.ERC1155;
        o.asset = address(coll);
        o.tokenId = 7;
        o.positionToken = uint256(key);
        // Not this vault's escrow: refused at the vault.
        _directRefused(o);

        // The address the vault predicts is where it creates the escrow.
        address predicted = VaipakamVaultImplementation(v).listingEscrowAddress(key);
        address conduit = makeAddr("conduit");
        registry.setMember(RegistryKeys.CONDUITS, conduit, true);
        vm.prank(address(diamond));
        address escrow = VaipakamVaultImplementation(v).openListingEscrow(key, address(coll), conduit);
        assertEq(escrow, predicted, "CREATE2: the order can name the escrow before it exists");

        // The lot moves into exactly that escrow, and nowhere else.
        o.to = escrow;
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).transferOut(o);
        assertEq(coll.balanceOf(escrow, 7), 2, "the listed lot is in the escrow");
        assertEq(coll.balanceOf(v, 7), 1, "the rest stays in the vault");

        // Teardown brings it back.
        vm.prank(address(diamond));
        uint256 returned = VaipakamVaultImplementation(v).closeListingEscrow(key, address(coll), 7);
        assertEq(returned, 2, "the whole lot came back");
        assertEq(coll.balanceOf(v, 7), 3);
    }

    /// @notice Codex #3387 r1 — every spender right the vault grants or causes
    ///         passes ONE registry rule: a conduit outside CONDUITS is refused
    ///         for an ERC-721 listing grant and for an ERC-1155 listing
    ///         escrow alike, whoever asked for it.
    function test_aConduitOutsideTheRegistryIsRefusedForEveryListingKind() public {
        address rogue = makeAddr("rogueConduit");
        address v = _vault(alice);
        // ERC-721 listing grant.
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamVaultImplementation.GrantRefused.selector, VaultOutflowTypes.GrantClass.Conduit, rogue)
        );
        vm.prank(address(diamond));
        VaultOutflowFacet(address(diamond)).vaultGrant(
            alice,
            VaultOutflowTypes.Grant({
                kind: VaultOutflowTypes.AssetKind.ERC721,
                asset: address(token),
                tokenId: 1,
                amount: 1,
                spender: rogue,
                class_: VaultOutflowTypes.GrantClass.Conduit,
                ref: 5
            })
        );
        // ERC-1155 listing escrow.
        ERC1155Mock coll = ERC1155Mock(deployCode("ERC1155Mock.sol:ERC1155Mock"));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamVaultImplementation.GrantRefused.selector, VaultOutflowTypes.GrantClass.Conduit, rogue)
        );
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).openListingEscrow(keccak256("rogue-listing"), address(coll), rogue);
    }

    /// @notice Codex #3387 r1 — ONE free-balance rule for the policy and the
    ///         depository: 12 tracked units, a 10-unit lien, the 10 liened
    ///         units moved into this vault's own listing escrow, leaves the
    ///         owner 2 withdrawable (not 0).
    function test_anEscrowedLotDoesNotHideTheOwnersOtherFreeUnits() public {
        ERC1155Mock coll = ERC1155Mock(deployCode("ERC1155Mock.sol:ERC1155Mock"));
        coll.mint(alice, 7, 12);
        vm.startPrank(alice);
        coll.setApprovalForAll(address(diamond), true);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC1155), address(coll), 7, 12);
        vm.stopPrank();
        TestMutatorFacet(address(diamond)).setEncumberedRaw(alice, address(coll), 7, 10);

        address v = _vault(alice);
        bytes32 key = keccak256("liened-listing");
        address conduit = makeAddr("conduit1155");
        registry.setMember(RegistryKeys.CONDUITS, conduit, true);
        vm.prank(address(diamond));
        address escrow = VaipakamVaultImplementation(v).openListingEscrow(key, address(coll), conduit);
        VaultOutflowTypes.Outflow memory o = _outflow(VaultOutflowTypes.OutflowClass.ListingEscrow, escrow, 10);
        o.kind = VaultOutflowTypes.AssetKind.ERC1155;
        o.asset = address(coll);
        o.tokenId = 7;
        o.positionToken = uint256(key);
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).transferOut(o);
        assertEq(coll.balanceOf(v, 7), 2, "fixture: 2 units left in the vault, 10 in the escrow");

        uint8 k1155 = uint8(LibVaipakam.AssetType.ERC1155);
        assertEq(VaultDepositoryFacet(address(diamond)).withdrawableNow(alice, k1155, address(coll), 7), 2, "2 withdrawable");
        vm.prank(alice);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(alice, k1155, address(coll), 7, 2, alice);
        assertEq(coll.balanceOf(alice, 7), 2, "and the owner withdraws them");
    }

    /// @notice The property the registry exists for, on a REAL
    ///         ProtocolRegistry (not the test mirror): an order protocol the
    ///         Diamond is configured with, but that the registry does not list
    ///         in SWAP_ADAPTERS, is refused at the vault's grant. A member the
    ///         registry was built with is accepted.
    function test_aRealRegistryRefusesAnOrderProtocolTheDiamondConfiguredButItDoesNotList() public {
        address lop = makeAddr("configuredLop");
        address listed = makeAddr("listedAdapter");
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(lop);

        bytes32[] memory keys = new bytes32[](1);
        address[] memory values = new address[](1);
        keys[0] = RegistryKeys.TREASURY;
        values[0] = address(diamond);
        bytes32[] memory sets = new bytes32[](1);
        address[] memory members = new address[](1);
        sets[0] = RegistryKeys.SWAP_ADAPTERS;
        members[0] = listed;
        address real = deployCode(
            "ProtocolRegistry.sol:ProtocolRegistry",
            abi.encode(address(this), address(this), uint256(3 days), keys, values, sets, members)
        );
        address impl = deployCode(
            "VaipakamVaultImplementation.sol:VaipakamVaultImplementation",
            abi.encode(address(LibTestPositionNFT.core(address(diamond))), real)
        );
        address beacon = deployCode(
            "VaultBeacon.sol:VaultBeacon", abi.encode(address(this), address(diamond), address(this), impl)
        );
        address v = deployCode(
            "BeaconProxy.sol:BeaconProxy",
            abi.encode(beacon, abi.encodeCall(VaipakamVaultImplementation.initialize, (address(diamond), alice)))
        );

        VaultOutflowTypes.Grant memory g = VaultOutflowTypes.Grant({
            kind: VaultOutflowTypes.AssetKind.ERC20,
            asset: address(token),
            tokenId: 0,
            amount: 1 ether,
            spender: lop,
            class_: VaultOutflowTypes.GrantClass.OrderTaker,
            ref: 1
        });
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamVaultImplementation.GrantRefused.selector, VaultOutflowTypes.GrantClass.OrderTaker, lop)
        );
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).grantAllowance(g);

        g.spender = listed;
        vm.prank(address(diamond));
        VaipakamVaultImplementation(v).grantAllowance(g);
        assertEq(token.allowance(v, listed), 1 ether, "a listed adapter is granted");
    }

    // ─── Claim custody: reserved until the claim ─────────────────────────

    /// @notice The coordinator's condition: a share parked as claim custody in
    ///         the stored lender's vault cannot be withdrawn by that lender
    ///         (it is never credited to the depository ledger), and the claim
    ///         pays the CURRENT holder's vault, from which the holder withdraws.
    function test_parkedCustodyIsReservedUntilTheClaimPaysTheHolder() public {
        address storedLender = makeAddr("storedLender");
        address newHolder = makeAddr("newHolder");
        uint256 loanId = 9_001;
        uint256 lenderToken = 90_011;
        uint256 borrowerToken = 90_012;
        // A loan whose lender side is held by `storedLender`, then moved.
        LibVaipakam.Loan memory l;
        l.id = loanId;
        l.lender = storedLender;
        l.borrower = alice;
        l.lenderTokenId = lenderToken;
        l.borrowerTokenId = borrowerToken;
        l.status = LibVaipakam.LoanStatus.Defaulted;
        l.principalAsset = address(token);
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);
        vm.startPrank(address(diamond));
        LibTestPositionNFT.core(address(diamond)).mint(storedLender, lenderToken);
        LibTestPositionNFT.core(address(diamond)).mint(alice, borrowerToken);
        vm.stopPrank();
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(storedLender);

        // The settlement parks 5 tokens of the borrower's into the stored
        // lender's vault, as claim custody; the payee comes from loan state.
        VaultOutflowTypes.Outflow memory park =
            _outflow(VaultOutflowTypes.OutflowClass.ClaimCustody, address(0), 5 ether);
        park.ref = loanId;
        park.positionToken = lenderToken;
        _run(0, alice, park);
        assertEq(token.balanceOf(_vault(storedLender)), 5 ether, "parked in the stored lender's vault");
        assertEq(
            VaultFactoryFacet(address(diamond)).getTrackedHolding(storedLender, address(token), 0), 5 ether,
            "the policy booked the parked share to the stored party's tracked holding"
        );

        // The position moves on.
        LibTestPositionNFT.move(address(diamond), lenderToken, newHolder);

        // The stored lender cannot take the parked share.
        vm.prank(storedLender);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 5 ether, 0));
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            storedLender, uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 5 ether, storedLender
        );

        // The claim pays the current holder's vault, as free money.
        VaultOutflowTypes.Outflow memory claim =
            _outflow(VaultOutflowTypes.OutflowClass.PositionHolder, address(0), 5 ether);
        claim.ref = loanId;
        claim.positionToken = lenderToken;
        _run(1, storedLender, claim);
        assertEq(token.balanceOf(_vault(newHolder)), 5 ether, "the holder's vault received the claim");

        uint256 before = token.balanceOf(newHolder);
        vm.prank(newHolder);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            newHolder, uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 5 ether, newHolder
        );
        assertEq(token.balanceOf(newHolder) - before, 5 ether, "and the holder withdraws it");
        assertEq(IERC20(address(token)).balanceOf(storedLender), 0, "the stored lender got nothing");
    }

    /// @notice The matched variant: a matched liquidation's leg pays the
    ///         receiving loan's STORED lender's vault (the payee is read from
    ///         both loans; the caller's recipient is ignored). The lender
    ///         position then moves; the old holder cannot withdraw the parked
    ///         leg, and the claim pays the new holder.
    function test_matchedLegIsReservedUntilTheClaimPaysTheNewHolder() public {
        address storedLender = makeAddr("matchedLender");
        address newHolder = makeAddr("matchedNewHolder");
        uint256 payingId = 9_101;
        uint256 receivingId = 9_102;
        uint256 lenderToken = 91_021;
        // The paying loan: alice borrowed against `token`.
        LibVaipakam.Loan memory a;
        a.id = payingId;
        a.borrower = alice;
        a.collateralAsset = address(token);
        a.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).setLoan(payingId, a);
        // The receiving loan: lent `token` by `storedLender`.
        LibVaipakam.Loan memory b;
        b.id = receivingId;
        b.lender = storedLender;
        b.lenderTokenId = lenderToken;
        b.borrowerTokenId = lenderToken + 1;
        b.principalAsset = address(token);
        b.status = LibVaipakam.LoanStatus.Defaulted;
        TestMutatorFacet(address(diamond)).setLoan(receivingId, b);
        vm.prank(address(diamond));
        LibTestPositionNFT.core(address(diamond)).mint(storedLender, lenderToken);
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(storedLender);

        VaultOutflowTypes.Outflow memory leg =
            _outflow(VaultOutflowTypes.OutflowClass.MatchedCounterparty, stranger, 6 ether);
        leg.ref = payingId;
        leg.counterRef = receivingId;
        _run(0, alice, leg);
        assertEq(token.balanceOf(_vault(storedLender)), 6 ether, "parked with the receiving loan's stored lender");
        assertEq(token.balanceOf(stranger), 0, "the named recipient is ignored");
        assertEq(
            VaultFactoryFacet(address(diamond)).getTrackedHolding(storedLender, address(token), 0), 6 ether,
            "the policy booked the parked share to the stored party's tracked holding"
        );

        // A mismatched pair is refused: the asset is not the receiving
        // loan's principal.
        VaultOutflowTypes.Outflow memory bad = leg;
        bad.counterRef = payingId;
        vm.expectRevert(abi.encodeWithSelector(VaultOutflowFacet.OutflowPositionMismatch.selector, payingId, payingId));
        _run(0, alice, bad);

        LibTestPositionNFT.move(address(diamond), lenderToken, newHolder);

        vm.prank(storedLender);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 6 ether, 0));
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            storedLender, uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 6 ether, storedLender
        );

        VaultOutflowTypes.Outflow memory claim =
            _outflow(VaultOutflowTypes.OutflowClass.PositionHolder, address(0), 6 ether);
        claim.ref = receivingId;
        claim.positionToken = lenderToken;
        _run(0, storedLender, claim);
        assertEq(token.balanceOf(_vault(newHolder)), 6 ether, "the claim paid the new holder's vault");
        assertEq(token.balanceOf(storedLender), 0, "the old holder got nothing");
    }

    /// @notice The vault's refusals are re-declared on the policy facet so the
    ///         Diamond's ABI decodes them; the two declarations must agree.
    function test_theFacetRedeclaresTheVaultsRefusalsByteIdentical() public pure {
        assertEq(VaultOutflowFacet.OutflowDestinationRefused.selector, VaipakamVaultImplementation.OutflowDestinationRefused.selector);
        assertEq(VaultOutflowFacet.GrantRefused.selector, VaipakamVaultImplementation.GrantRefused.selector);
        assertEq(VaultOutflowFacet.GrantOpen.selector, VaipakamVaultImplementation.GrantOpen.selector);
        assertEq(VaultOutflowFacet.ZeroOutflow.selector, VaipakamVaultImplementation.ZeroOutflow.selector);
    }
}
