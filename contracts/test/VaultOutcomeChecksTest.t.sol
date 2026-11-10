// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {ListingEscrow} from "../src/vault/ListingEscrow.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {
    OrderComponents, OfferItem, ConsiderationItem, OrderType
} from "../src/seaport/ISeaportOrderHash.sol";
import {IOrderMixin} from "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";
import {Address} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import {MakerTraits} from "@1inch/limit-order-protocol/contracts/libraries/MakerTraitsLib.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";

// ─── Fixtures ────────────────────────────────────────────────────────────

/// @dev An ERC-20 whose permit accepts contract signers through
///      OpenZeppelin's SignatureChecker (ERC-1271), as many tokens do.
contract ContractSignerPermitToken is ERC20Mock {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    constructor() ERC20Mock("Permit", "PRM", 18) {}

    function permitDigest(address owner, address spender, uint256 value, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                keccak256(abi.encode(block.chainid, address(this))),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner], deadline))
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata sig) external {
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = permitDigest(owner, spender, value, deadline);
        require(SignatureChecker.isValidSignatureNow(owner, digest, sig), "bad signature");
        nonces[owner]++;
        _approve(owner, spender, value);
    }
}

/// @dev A probe facet: it calls a vault's Diamond-gated entries with whatever
///      it is given (it runs in the Diamond's context), so the vault's own
///      checks are exercised without layer 1.
contract RegistrarProbeFacet {
    function probeRegisterSeaport(address vault, OrderComponents calldata c, bytes32 escrowKey)
        external
        returns (bytes32)
    {
        return VaipakamVaultImplementation(vault).registerSeaportOrder(c, escrowKey);
    }

    function probeRegisterLimit(address vault, IOrderMixin.Order calldata o) external returns (bytes32) {
        return VaipakamVaultImplementation(vault).registerLimitOrder(o);
    }

    function probeSwapOut(address vault, VaultOutflowTypes.SwapOut calldata w)
        external
        returns (uint256 spent, uint256 received)
    {
        return VaipakamVaultImplementation(vault).swapOut(w);
    }
}

/// @dev A Seaport stand-in for the hash: Seaport's own view is what the vault
///      asks; here it is any fixed function of the terms.
contract MockSeaportHasher {
    function getOrderHash(OrderComponents calldata c) external pure returns (bytes32) {
        return keccak256(abi.encode(c));
    }
}

/// @dev A 1inch order-protocol stand-in for the hash.
contract MockLopHasher {
    function hashOrder(IOrderMixin.Order calldata o) external pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }
}

/// @dev A swap adapter on the fixed interface whose behaviour the test sets.
contract ScriptedAdapter is ISwapAdapter {
    uint256 public pull; // how much of the input it takes
    uint256 public pay; // how much output it sends
    address public payTo; // 0 = the recipient it was given

    function script(uint256 pull_, uint256 pay_, address payTo_) external {
        pull = pull_;
        pay = pay_;
        payTo = payTo_;
    }

    function adapterName() external pure returns (string memory) {
        return "scripted";
    }

    function execute(address inputToken, address outputToken, uint256, uint256, address recipient, bytes calldata)
        external
        returns (uint256)
    {
        if (pull != 0) IERC20(inputToken).transferFrom(msg.sender, address(this), pull);
        ERC20Mock(outputToken).mint(payTo == address(0) ? recipient : payTo, pay);
        return pay;
    }
}

/**
 * @title  VaultOutcomeChecksTest
 * @notice #3431 (Stage B1) — the vault checks outcomes, not identities.
 *         - ERC-1271: a vault answers only the protocol an order was hashed
 *           for, and only for a hash it computed itself from the terms; a
 *           token's contract-signature permit gets no valid answer.
 *         - The listing escrow answers only Seaport.
 *         - `swapOut`: the adapter's take and the recipient's receipt are
 *           measured; less than the floor, a wrong recipient or a refused
 *           adapter reverts.
 *         - The endpoints are fixed in the vault code.
 */
contract VaultOutcomeChecksTest is SetupTest {
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");
    ContractSignerPermitToken internal ptoken;
    MockSeaportHasher internal seaport;
    MockLopHasher internal lop;
    address internal vault;

    function setUp() public {
        setupHelper();
        ptoken = new ContractSignerPermitToken();
        seaport = new MockSeaportHasher();
        lop = new MockLopHasher();
        VaultOutflowTypes.VaultEndpoints memory e = LibTestVaultBeacon.endpointsOf(address(diamond));
        e.seaport = address(seaport);
        e.orderProtocol = address(lop);
        e.conduit = makeAddr("conduit");
        e.conduitKey = keccak256("conduit-key");
        LibTestVaultBeacon.setEndpoints(address(diamond), e);

        ptoken.mint(alice, 100 ether);
        vm.startPrank(alice);
        ptoken.approve(address(diamond), 100 ether);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), address(ptoken), 0, 100 ether);
        vm.stopPrank();
        vault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(alice);

        bytes4[] memory sel = new bytes4[](3);
        sel[0] = RegistrarProbeFacet.probeRegisterSeaport.selector;
        sel[1] = RegistrarProbeFacet.probeRegisterLimit.selector;
        sel[2] = RegistrarProbeFacet.probeSwapOut.selector;
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(new RegistrarProbeFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    // ─── ERC-1271 scope ──────────────────────────────────────────────────

    /// @notice The vault takes no hash from the Diamond: it hashes the order
    ///         terms itself, and answers only the protocol it hashed for. A
    ///         token whose permit accepts contract signatures therefore gets
    ///         no valid answer from the vault, whatever orders it holds.
    function test_b1_answersNoPermitSignatureCheck() public {
        uint256 deadline = block.timestamp + 1 hours;
        OrderComponents memory c = _listing(vault);
        bytes32 h = RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, c, bytes32(0));
        assertEq(h, seaport.getOrderHash(c), "the vault hashed the terms itself");

        vm.prank(stranger);
        vm.expectRevert(bytes("bad signature"));
        ptoken.permit(vault, stranger, type(uint256).max, deadline, "");

        // The token asking about the registered hash itself is refused too.
        vm.prank(address(ptoken));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0xffffffff), "only Seaport is answered");
        // Seaport is answered for it; the 1inch protocol is not.
        vm.prank(address(seaport));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0x1626ba7e), "Seaport is answered");
        vm.prank(address(lop));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0xffffffff), "not the other protocol");
        assertEq(ptoken.allowance(vault, stranger), 0, "no allowance arose");
    }

    /// @notice A listing whose offerer is not this vault (or its own escrow
    ///         for the named key), or whose conduit key is not the vault
    ///         code's, cannot be registered.
    function test_b1_refusesAListingThatIsNotTheVaults() public {
        OrderComponents memory c = _listing(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaipakamVaultImplementation.OrderNotThisVaults.selector, stranger));
        RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, c, bytes32(0));

        // An escrow offerer must be this vault's escrow for the named key.
        bytes32 key = keccak256("k");
        c = _listing(VaipakamVaultImplementation(vault).listingEscrowAddress(key));
        vm.expectRevert(abi.encodeWithSelector(VaipakamVaultImplementation.OrderNotThisVaults.selector, c.offerer));
        RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, c, keccak256("other"));
        RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, c, key);

        c = _listing(vault);
        c.conduitKey = keccak256("rogue");
        vm.expectRevert(abi.encodeWithSelector(VaipakamVaultImplementation.OrderConduitRefused.selector, c.conduitKey));
        RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, c, bytes32(0));
    }

    /// @notice A limit order must name this vault as maker, and is answered
    ///         only to the order protocol fixed in the vault code.
    function test_b1_limitOrderIsTheVaultsAndAnsweredOnlyToItsProtocol() public {
        IOrderMixin.Order memory o = _limit(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaipakamVaultImplementation.OrderNotThisVaults.selector, stranger));
        RegistrarProbeFacet(address(diamond)).probeRegisterLimit(vault, o);

        o = _limit(vault);
        bytes32 h = RegistrarProbeFacet(address(diamond)).probeRegisterLimit(vault, o);
        assertEq(h, lop.hashOrder(o), "the vault asked its protocol for the hash");
        vm.prank(address(lop));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0x1626ba7e));
        vm.prank(address(seaport));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0xffffffff));

        // A revoked hash is answered to no one.
        vm.prank(address(diamond));
        VaipakamVaultImplementation(vault).revokeListingOrderHash(h);
        vm.prank(address(lop));
        assertEq(VaipakamVaultImplementation(vault).isValidSignature(h, ""), bytes4(0xffffffff));
    }

    /// @notice The listing escrow answers only Seaport, with the vault's
    ///         answer for an order the vault hashed for its escrow.
    function test_b1_theEscrowAnswersOnlySeaport() public {
        bytes32 key = keccak256("escrowed");
        VaultOutflowTypes.VaultEndpoints memory e = LibTestVaultBeacon.endpointsOf(address(diamond));
        address coll = address(new ERC1155Mock());
        vm.prank(address(diamond));
        address escrow = VaipakamVaultImplementation(vault).openListingEscrow(key, coll, e.conduit);
        bytes32 h = RegistrarProbeFacet(address(diamond)).probeRegisterSeaport(vault, _listing(escrow), key);

        vm.prank(address(seaport));
        assertEq(ListingEscrow(escrow).isValidSignature(h, ""), bytes4(0x1626ba7e), "Seaport, through the escrow");
        vm.prank(address(ptoken));
        assertEq(ListingEscrow(escrow).isValidSignature(h, ""), bytes4(0xffffffff), "anyone else is refused");
        vm.prank(address(lop));
        assertEq(ListingEscrow(escrow).isValidSignature(h, ""), bytes4(0xffffffff), "the other protocol too");
    }

    // ─── swapOut ─────────────────────────────────────────────────────────

    function test_swapOut_measuresBothSides() public {
        ERC20Mock out = new ERC20Mock("Out", "OUT", 18);
        ScriptedAdapter a = new ScriptedAdapter();
        a.script(4 ether, 9 ether, address(0));
        (uint256 spent, uint256 received) =
            RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, vault));
        assertEq(spent, 4 ether, "what the adapter took, measured");
        assertEq(received, 9 ether, "what arrived, measured");
        assertEq(ptoken.allowance(vault, address(a)), 0, "the allowance is closed in the call");
        assertEq(out.balanceOf(vault), 9 ether);
    }

    function test_swapOut_refusesLessThanTheFloor_aWrongRecipient_andARefusedAdapter() public {
        ERC20Mock out = new ERC20Mock("Out", "OUT", 18);
        ScriptedAdapter a = new ScriptedAdapter();

        // Delivers less than the floor.
        a.script(4 ether, 8 ether, address(0));
        vm.expectRevert(VaipakamVaultImplementation.SwapOutcomeRefused.selector);
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, vault));

        // Pays someone else than the recipient.
        a.script(4 ether, 9 ether, stranger);
        vm.expectRevert(VaipakamVaultImplementation.SwapOutcomeRefused.selector);
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, vault));

        // Takes nothing (a swap that sold nothing is not a swap).
        a.script(0, 9 ether, address(0));
        vm.expectRevert(VaipakamVaultImplementation.SwapOutcomeRefused.selector);
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, vault));

        // A recipient the vault cannot establish.
        a.script(4 ether, 9 ether, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector,
                VaultOutflowTypes.OutflowClass.SwapAdapter,
                stranger
            )
        );
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, stranger));

        // The asset itself, or the Diamond, as the adapter.
        vm.expectRevert(VaipakamVaultImplementation.SwapOutcomeRefused.selector);
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(ptoken), address(out), 5 ether, 9 ether, vault));
        vm.expectRevert(VaipakamVaultImplementation.SwapOutcomeRefused.selector);
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(diamond), address(out), 5 ether, 9 ether, vault));
        assertEq(ptoken.balanceOf(vault), 100 ether, "nothing left the vault");
    }

    function test_swapOut_paysTheOwnerWallet() public {
        ERC20Mock out = new ERC20Mock("Out", "OUT", 18);
        ScriptedAdapter a = new ScriptedAdapter();
        a.script(5 ether, 9 ether, address(0));
        RegistrarProbeFacet(address(diamond)).probeSwapOut(vault, _swap(address(a), address(out), 5 ether, 9 ether, alice));
        assertEq(out.balanceOf(alice), 9 ether);
    }

    // ─── Endpoints in the code ──────────────────────────────────────────

    /// @notice The vault reads no registry: its treasury class pays the
    ///         treasury fixed in its code, and a Diamond-side treasury change
    ///         does not move it (the class then fails closed).
    function test_theTreasuryIsTheOneTheVaultCodeFixes() public {
        VaultOutflowTypes.VaultEndpoints memory e = LibTestVaultBeacon.endpointsOf(address(diamond));
        assertEq(e.treasury, address(diamond), "the suite's treasury, fixed in the code");
        assertEq(VaipakamVaultImplementation(vault).TREASURY(), e.treasury);

        VaultOutflowTypes.Outflow memory o;
        o.class_ = VaultOutflowTypes.OutflowClass.Treasury;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(ptoken);
        o.amount = 1 ether;
        o.to = stranger;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector, VaultOutflowTypes.OutflowClass.Treasury, stranger
            )
        );
        VaipakamVaultImplementation(vault).transferOut(o);
        // A plain transfer to a swap adapter is never a destination.
        o.class_ = VaultOutflowTypes.OutflowClass.SwapAdapter;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector, VaultOutflowTypes.OutflowClass.SwapAdapter, stranger
            )
        );
        VaipakamVaultImplementation(vault).transferOut(o);
    }

    // ─── Builders ────────────────────────────────────────────────────────

    function _listing(address offerer) internal view returns (OrderComponents memory c) {
        c.offerer = offerer;
        c.offer = new OfferItem[](0);
        c.consideration = new ConsiderationItem[](0);
        c.orderType = OrderType.FULL_RESTRICTED;
        c.endTime = block.timestamp + 1 days;
        c.salt = 7;
        c.conduitKey = keccak256("conduit-key");
    }

    function _limit(address maker) internal returns (IOrderMixin.Order memory o) {
        o.salt = 1;
        o.maker = Address.wrap(uint256(uint160(maker)));
        o.receiver = Address.wrap(uint256(uint160(address(diamond))));
        o.makerAsset = Address.wrap(uint256(uint160(address(ptoken))));
        o.takerAsset = Address.wrap(uint256(uint160(makeAddr("principal"))));
        o.makingAmount = 1 ether;
        o.takingAmount = 1 ether;
        o.makerTraits = MakerTraits.wrap(0);
    }

    function _swap(address adapter, address out, uint256 maxIn, uint256 minOut, address to)
        internal
        view
        returns (VaultOutflowTypes.SwapOut memory w)
    {
        w.assetIn = address(ptoken);
        w.maxIn = maxIn;
        w.adapter = adapter;
        w.assetOut = out;
        w.minOut = minOut;
        w.to = to;
        w.ref = 1;
        w.adapterData = "";
    }
}
