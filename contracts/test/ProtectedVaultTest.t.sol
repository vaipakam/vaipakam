// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibTestOutflow} from "./helpers/LibTestOutflow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {Test} from "forge-std/Test.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {ProtectedAccountFacet} from "../src/facets/ProtectedAccountFacet.sol";
import {VaultPayoutFacet} from "../src/facets/VaultPayoutFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {LibDepositoryLedger} from "../src/libraries/LibDepositoryLedger.sol";
import {LibPositionNFT} from "../src/libraries/LibPositionNFT.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {VaultProtection} from "../src/vault/VaultProtection.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";

/**
 * @title ProtectedVaultTest
 * @notice The depository vault (deposit, withdraw, adopt, disown, pin), the
 *         tracked ledger across asset kinds, and protected account mode (the
 *         payout delay, allowlist, signers, lock, replacement of the primary,
 *         the escape route and the position-NFT owner lock).
 */
contract ProtectedVaultTest is Test {
    VaipakamDiamond diamond;
    HelperTest helperTest;
    ERC20Mock token;
    ERC1155Mock multi;
    MockRentableNFT721 nft;
    MockSanctionsList sanctionsList;

    uint256 constant USER_KEY = 0xA11CE;
    address user;
    address friend = makeAddr("friend");
    address thief = makeAddr("thief");
    address source = makeAddr("source");
    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address nominee = makeAddr("nominee");
    address keeper = makeAddr("keeper");

    uint32 constant DELAY = 2 days;
    uint8 constant K20 = uint8(LibVaipakam.AssetType.ERC20);
    uint8 constant K721 = uint8(LibVaipakam.AssetType.ERC721);
    uint8 constant K1155 = uint8(LibVaipakam.AssetType.ERC1155);

    function setUp() public {
        user = vm.addr(USER_KEY);
        helperTest = new HelperTest();
        DiamondCutFacet cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cutFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = _cut(type(VaultFactoryFacet).name, helperTest.getVaultFactoryFacetSelectorsExtended());
        cuts[1] = _cut(type(AdminFacet).name, helperTest.getAdminFacetSelectors());
        cuts[2] = _cut(type(ProfileFacet).name, helperTest.getProfileFacetSelectors());
        cuts[3] = _cut(type(AccessControlFacet).name, helperTest.getAccessControlFacetSelectors());
        cuts[4] = _cut(type(VaipakamNFTFacet).name, helperTest.getVaipakamNFTFacetSelectors());
        cuts[5] = _cut(type(ProtectedAccountFacet).name, helperTest.getProtectedAccountFacetSelectors());
        cuts[6] = _cut(type(VaultPayoutFacet).name, helperTest.getVaultPayoutFacetSelectors());
        cuts[7] = _cut(type(VaultDepositoryFacet).name, helperTest.getVaultDepositoryFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        LibTestVaultBeacon.install(address(diamond), address(this));
        LibTestPositionNFT.install(address(diamond), address(this));
        sanctionsList = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctionsList));

        token = new ERC20Mock("Token", "TKN", 18);
        multi = new ERC1155Mock();
        nft = new MockRentableNFT721();
        token.mint(user, 1_000 ether);
        nft.mint(user, 7);
        multi.mint(user, 3, 10);
        vm.startPrank(user);
        token.approve(address(diamond), type(uint256).max);
        nft.setApprovalForAll(address(diamond), true);
        multi.setApprovalForAll(address(diamond), true);
        vm.stopPrank();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _cut(string memory name, bytes4[] memory sels) internal returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
    }

    function _depo() internal view returns (VaultDepositoryFacet) {
        return VaultDepositoryFacet(address(diamond));
    }

    function _prot() internal view returns (ProtectedAccountFacet) {
        return ProtectedAccountFacet(address(diamond));
    }

    function _pay() internal view returns (VaultPayoutFacet) {
        return VaultPayoutFacet(address(diamond));
    }

    function _nftFacet() internal view returns (VaipakamNFTFacet) {
        return VaipakamNFTFacet(address(diamond));
    }

    function _core() internal view returns (PositionNFT) {
        return LibTestPositionNFT.core(address(diamond));
    }

    function _mintTo(address to, uint256 id) internal {
        vm.prank(address(diamond));
        _nftFacet().mintNFT(to, id, id, 0, true, LibVaipakam.LoanPositionStatus.OfferCreated);
    }

    function _vault(address u) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(u);
    }

    function _tracked(address u, address asset, uint256 id) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getTrackedHolding(u, asset, id);
    }

    function _deposit20(uint256 amount) internal {
        vm.prank(user);
        _depo().depositToVault(K20, address(token), 0, amount);
    }

    /// @dev #3379 B2 — protected mode is the vault's own record: the owner
    ///      switches it on there (with NFT protection, as the old
    ///      `enableProtectedMode(DELAY, true)` did) and the platform applies it.
    function _enable() internal {
        P.enableWithNfts(address(diamond), user, DELAY);
    }

    /// @dev `user`'s vault, where its protected record lives.
    function _v() internal returns (VaipakamVaultImplementation) {
        return P.vaultOf(address(diamond), user);
    }

    function _locked() internal returns (bool locked) {
        (, locked,,,) = _v().protectionCore();
    }

    function _enabled() internal returns (bool enabled) {
        (enabled,,,,) = _v().protectionCore();
    }

    /// @dev A direct vault write `key` makes, expected to revert with `err`.
    ///      The vault is resolved first so the expectation binds to the write.
    function _expectProtectRevert(address key, bytes memory data, bytes memory err) internal {
        VaipakamVaultImplementation v = _v();
        vm.prank(key);
        vm.expectRevert(err);
        v.protect(data);
    }

    /// @dev A permissionless vault finalize, expected to revert with `err`.
    function _expectFinalizeRevert(bytes memory data, bytes memory err) internal {
        VaipakamVaultImplementation v = _v();
        vm.expectRevert(err);
        v.protect(data);
    }

    function _queue(uint256 amount, address to) internal returns (uint256 id) {
        vm.prank(user);
        id = _depo().withdrawFromVault(user, K20, address(token), 0, amount, to);
    }

    function _adoptSig(address asset, uint8 kind, uint256 id, address src, uint256 amount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        uint256 nonce = _depo().adoptionNonce(user);
        bytes32 d = _depo().adoptionDigest(user, kind, asset, id, src, amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, d);
        return abi.encodePacked(r, s, v);
    }

    function _addSigner(address signer) internal {
        P.addSigner(address(diamond), user, user, signer, DELAY);
    }

    function _threeSigners() internal {
        _addSigner(s1);
        _addSigner(s2);
        _addSigner(s3);
    }

    // ─── Depository: deposit and withdraw ────────────────────────────────

    function testDepositAndWithdrawEveryAssetKind() public {
        _deposit20(100 ether);
        vm.startPrank(user);
        _depo().depositToVault(K721, address(nft), 7, 0);
        _depo().depositToVault(K1155, address(multi), 3, 4);
        vm.stopPrank();
        address v = _vault(user);
        assertEq(_tracked(user, address(token), 0), 100 ether);
        assertEq(_tracked(user, address(nft), 7), 1);
        assertEq(_tracked(user, address(multi), 3), 4);
        assertEq(nft.ownerOf(7), v);

        // #3205 part 2 — without protected mode a withdrawal pays only the
        // owner's own wallet: another recipient is refused.
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(VaultDepositoryFacet.RecipientNotOwnWallet.selector, user, friend));
        _depo().withdrawFromVault(user, K20, address(token), 0, 40 ether, friend);
        uint256 walletBefore = token.balanceOf(user);
        _depo().withdrawFromVault(user, K20, address(token), 0, 40 ether, user);
        _depo().withdrawFromVault(user, K721, address(nft), 7, 0, user);
        _depo().withdrawFromVault(user, K1155, address(multi), 3, 4, user);
        vm.stopPrank();
        assertEq(token.balanceOf(friend), 0, "nothing reached another address");
        assertEq(token.balanceOf(user) - walletBefore, 40 ether, "the owner's own wallet received it");
        assertEq(_tracked(user, address(token), 0), 60 ether);
        assertEq(nft.ownerOf(7), user);
        assertEq(_tracked(user, address(nft), 7), 0);
        assertEq(multi.balanceOf(user, 3), 10);
        assertEq(_tracked(user, address(multi), 3), 0);
    }

    function testDepositedAssetsAreListedOnceAndStayListed() public {
        _deposit20(100 ether);
        vm.startPrank(user);
        _depo().depositToVault(K721, address(nft), 7, 0);
        _depo().depositToVault(K1155, address(multi), 3, 4);
        _depo().withdrawFromVault(user, K20, address(token), 0, 100 ether, user);
        vm.stopPrank();
        _deposit20(1 ether); // a second credit of a listed asset adds nothing

        (address[] memory all, uint256 total) = _depo().getDepositoryAssets(user, 0, 10);
        assertEq(total, 3);
        assertEq(all.length, 3);
        assertEq(all[0], address(token));
        assertEq(all[1], address(nft));
        assertEq(all[2], address(multi));

        (address[] memory page, uint256 t2) = _depo().getDepositoryAssets(user, 1, 1);
        assertEq(t2, 3);
        assertEq(page.length, 1);
        assertEq(page[0], address(nft));
        (address[] memory none,) = _depo().getDepositoryAssets(user, 5, 1);
        assertEq(none.length, 0);
        (address[] memory empty, uint256 t3) = _depo().getDepositoryAssets(friend, 0, 10);
        assertEq(t3, 0);
        assertEq(empty.length, 0);
    }

    function testUntrackedAssetCannotBeWithdrawnUntilAdopted() public {
        token.mint(_vault(user), 50 ether);
        assertEq(_depo().untrackedHolding(user, K20, address(token), 0), 50 ether);
        assertEq(_depo().freeHolding(user, K20, address(token), 0), 0);
        vm.prank(user);
        vm.expectRevert();
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);
    }

    function testOnlyTheOwnerWithdraws() public {
        _deposit20(10 ether);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotAccountManager.selector, user, thief));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, thief);
    }

    // ─── Adopt and disown ────────────────────────────────────────────────

    function testWithdrawalToASanctionedRecipientIsRefused() public {
        _deposit20(10 ether);
        sanctionsList.setFlagged(thief, true);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, thief));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, thief);
    }

    function testAdoptCreditsLedgerAndThenWithdraws() public {
        token.mint(_vault(user), 50 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(token), K20, 0, source, 30 ether, deadline);
        vm.prank(user);
        _depo().adoptUntracked(K20, address(token), 0, 30 ether, source, deadline, sig);
        assertEq(_tracked(user, address(token), 0), 30 ether);
        assertEq(_depo().untrackedHolding(user, K20, address(token), 0), 20 ether);
        assertEq(_depo().adoptionNonce(user), 1);
        vm.prank(user);
        _depo().withdrawFromVault(user, K20, address(token), 0, 30 ether, user);
        assertEq(token.balanceOf(user), 1_030 ether);
    }

    function testAdoptAnNftThatArrivedByPlainTransfer() public {
        address v = _vault(user);
        vm.prank(user);
        nft.transferFrom(user, v, 7);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(nft), K721, 7, user, 1, deadline);
        vm.prank(user);
        _depo().adoptUntracked(K721, address(nft), 7, 1, user, deadline, sig);
        assertEq(_tracked(user, address(nft), 7), 1);
    }

    function testAdoptCannotReachTrackedHolding() public {
        _deposit20(100 ether);
        token.mint(_vault(user), 5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(token), K20, 0, source, 6 ether, deadline);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryAmountExceedsUnsolicited.selector);
        _depo().adoptUntracked(K20, address(token), 0, 6 ether, source, deadline, sig);
    }

    function testAdoptFromSanctionedSourceBansAndCreditsNothing() public {
        token.mint(_vault(user), 50 ether);
        sanctionsList.setFlagged(source, true);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(token), K20, 0, source, 50 ether, deadline);
        vm.prank(user);
        _depo().adoptUntracked(K20, address(token), 0, 50 ether, source, deadline, sig);
        assertEq(_tracked(user, address(token), 0), 0);
        assertEq(_depo().vaultBannedSource(user), source);
        assertTrue(ProfileFacet(address(diamond)).isSanctionedAddress(user));
        sanctionsList.setFlagged(source, false);
        assertFalse(ProfileFacet(address(diamond)).isSanctionedAddress(user));
    }

    function testAdoptRefusesReplayExpiryAndOracleOutage() public {
        token.mint(_vault(user), 50 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(token), K20, 0, source, 10 ether, deadline);
        vm.prank(user);
        _depo().adoptUntracked(K20, address(token), 0, 10 ether, source, deadline, sig);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoverySignatureInvalid.selector);
        _depo().adoptUntracked(K20, address(token), 0, 10 ether, source, deadline, sig);

        bytes memory late = _adoptSig(address(token), K20, 0, source, 10 ether, deadline);
        vm.warp(deadline + 1);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RecoveryDeadlineExpired.selector);
        _depo().adoptUntracked(K20, address(token), 0, 10 ether, source, deadline, late);

        deadline = vm.getBlockTimestamp() + 1 hours;
        sig = _adoptSig(address(token), K20, 0, source, 10 ether, deadline);
        sanctionsList.setRevertOnRead(true);
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        _depo().adoptUntracked(K20, address(token), 0, 10 ether, source, deadline, sig);
    }

    function testDisownEmitsTheObservedUntrackedAmount() public {
        token.mint(_vault(user), 9 ether);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit VaultDepositoryFacet.UntrackedDisowned(user, address(token), 0, 9 ether, block.number);
        vm.prank(user);
        _depo().disownUntracked(K20, address(token), 0);
    }

    // ─── Protected mode: the payout delay ────────────────────────────────

    function testProtectedWithdrawQueuesAndReleasesAfterDelay() public {
        _deposit20(100 ether);
        _enable();
        uint256 id = _queue(40 ether, user);
        assertGt(id, 0);
        assertEq(_pay().getPayoutEarmark(user, address(token), 0), 40 ether);
        assertEq(_depo().freeHolding(user, K20, address(token), 0), 60 ether);

        vm.expectRevert();
        _pay().releasePayout(id);

        vm.warp(block.timestamp + DELAY);
        uint256 delivered = _pay().releasePayout(id);
        assertEq(delivered, 40 ether);
        assertEq(token.balanceOf(user), 940 ether);
        assertEq(_tracked(user, address(token), 0), 60 ether);
        assertEq(_pay().getPayoutEarmark(user, address(token), 0), 0);
    }

    function testProtectedWithdrawRefusesUnlistedRecipient() public {
        _deposit20(100 ether);
        _enable();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.RecipientNotAllowlisted.selector, user, thief));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, thief);
    }

    function testAllowlistAdditionWaitsTheDelay() public {
        _deposit20(100 ether);
        _enable();
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        _expectFinalizeRevert(
            abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)),
            abi.encodeWithSelector(VaultProtection.NotReady.selector, uint64(block.timestamp + DELAY))
        );
        vm.warp(block.timestamp + DELAY);
        _v().protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)));
        _queue(1 ether, friend);
    }

    /// @dev #3379 B2 — each pending addition is read per entry from the
    ///      vault: its ready time until it is applied or cancelled.
    function testPendingAdditionsAreReadableUntilAppliedOrCancelled() public {
        _enable();
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (thief, P.direct(user))));
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s1, P.direct(user)))
        );
        assertEq(_v().allowEntry(friend).readyAt, block.timestamp + DELAY);
        assertEq(_v().allowEntry(thief).readyAt, block.timestamp + DELAY);
        assertEq(_v().signerEntry(s1).addAt, block.timestamp + DELAY);
        assertFalse(_v().signerEntry(s1).accepted);

        // A cancelled addition reads as none; an applied one becomes active.
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.cancelAllowlisted, (thief, P.direct(user))));
        assertEq(_v().allowEntry(thief).readyAt, 0);
        vm.warp(block.timestamp + DELAY);
        _v().protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)));
        assertTrue(_v().allowEntry(friend).active);
        assertEq(_v().allowEntry(friend).readyAt, 0);
        (,,,,,, address[] memory allowlist) = _v().protectionState();
        assertEq(allowlist.length, 1);
        assertEq(allowlist[0], friend);
    }

    /// @dev #3379 B2 — the vault caps the allowlist at MAX_ALLOWLIST active
    ///      destinations: an addition is refused once that many are active.
    function testAllowlistIsCapped() public {
        _enable();
        VaipakamVaultImplementation v = _v();
        uint256 max = VaultProtection(v.PROTECTION()).MAX_ALLOWLIST();
        for (uint256 i; i < max; ++i) {
            P.call(
                address(diamond),
                user,
                user,
                abi.encodeCall(VaultProtection.addAllowlisted, (address(uint160(0xD000 + i)), P.direct(user)))
            );
        }
        // Asking again for one already pending is not a new entry.
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (address(0xD000), P.direct(user)))
        );
        vm.warp(block.timestamp + DELAY);
        for (uint256 i; i < max; ++i) {
            v.protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (address(uint160(0xD000 + i)))));
        }
        _expectProtectRevert(
            user,
            abi.encodeCall(VaultProtection.addAllowlisted, (address(0xDEAD), P.direct(user))),
            abi.encodeWithSelector(VaultProtection.TooMany.selector)
        );
    }

    function testAllowlistAdditionExpiresOneDelayAfterItMatures() public {
        _enable();
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        uint64 at = _v().allowEntry(friend).readyAt;
        vm.warp(at + DELAY + 1);
        _expectFinalizeRevert(
            abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)),
            abi.encodeWithSelector(VaultProtection.Expired.selector, at + DELAY)
        );
    }

    function testLockVoidsPendingAllowlistAndSignerChanges() public {
        _enable();
        _addSigner(s1);
        // Say a thief asked for these.
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s2, P.direct(user)))
        );
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(user)))
        );
        P.call(address(diamond), user, s2, abi.encodeCall(VaultProtection.signerChange, (uint8(2), s2, P.direct(s2))));

        P.lock(address(diamond), user, s1);
        // None can be finalized once the account unlocks, though all would
        // have matured by then.
        P.requestUnlock(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_locked());

        bytes memory notRequested = abi.encodeWithSelector(VaultProtection.NotRequested.selector);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)), notRequested);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeSigner, (s2)), notRequested);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeSigner, (s1)), notRequested);
        assertTrue(_v().signerEntry(s1).active, "the voided removal left s1 a signer");

        // They can be asked for again, and then wait a fresh delay.
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        assertEq(_v().allowEntry(friend).readyAt, block.timestamp + DELAY);
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s2, P.direct(user)))
        );
    }

    function testSwitchOffVoidsPendingChangesForALaterReEnable() public {
        _enable();
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(user))));
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s2, P.direct(user)))
        );
        P.requestDisable(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_enabled());

        _enable();
        bytes memory notRequested = abi.encodeWithSelector(VaultProtection.NotRequested.selector);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeAllowlisted, (friend)), notRequested);
        // The old nominee's acceptance belongs to the cleared posture: it is
        // refused, and the addition can never be applied.
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), user);
        vm.prank(s2);
        vm.expectRevert(VaultProtection.NotRequested.selector);
        v.protect(abi.encodeCall(VaultProtection.signerChange, (uint8(2), s2, P.direct(s2))));
        vm.warp(block.timestamp + DELAY);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeSigner, (s2)), notRequested);
    }

    /// @dev A due co-sign switch-off applies while a payout row is open, and a
    ///      requested switch-off does not stand in its way.
    function testWaitingSwitchOffDoesNotHoldBackOtherDueChanges() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(1 ether, user);
        vm.prank(user);
        _prot().setRequireCosign(user, false);
        P.requestDisable(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeSettingChanges(user);
        (, , uint64 pendingOff) = _prot().getProtection(user);
        assertEq(pendingOff, 0, "the co-sign switch-off applied");
        assertTrue(_enabled());
        _pay().releasePayout(id);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_enabled());
    }

    function testEarmarkStopsQueueingMoreThanIsFree() public {
        _deposit20(10 ether);
        _enable();
        _queue(8 ether, user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 3 ether, 2 ether));
        _depo().withdrawFromVault(user, K20, address(token), 0, 3 ether, user);
    }

    function testProtocolPayoutToOwnerWalletIsQueuedNotPaid() public {
        _deposit20(10 ether);
        _enable();
        // A settlement route paying the owner's own wallet is gated ...
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), user, address(token), user, 4 ether);
        assertEq(token.balanceOf(user), 990 ether);
        assertEq(_pay().getPendingPayoutIds(user).length, 1);
        // ... while a payment to a counterparty passes untouched.
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), user, address(token), friend, 1 ether);
        assertEq(token.balanceOf(friend), 1 ether);
    }

    function testCancelledPayoutLeavesAssetInVault() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(5 ether, user);
        vm.prank(user);
        _pay().cancelPayout(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.RowNotQueued.selector, id));
        _pay().releasePayout(id);
        assertEq(_depo().freeHolding(user, K20, address(token), 0), 10 ether);
    }

    /// @dev #3361 — the global open-payout set holds exactly the queued ids:
    ///      a queue adds, a cancel, a release and a lock's cancel-all remove.
    function testOpenPayoutSetTracksQueueCancelReleaseAndLock() public {
        _deposit20(100 ether);
        _enable();
        _addSigner(s1);
        uint256 a = _queue(10 ether, user);
        uint256 b = _queue(10 ether, user);
        uint256 c = _queue(10 ether, user);
        assertEq(_pay().getOpenPayoutCount(), 3);
        uint256[] memory page = _pay().getOpenPayoutIds(1, 5);
        assertEq(page.length, 2, "a page stops at the end of the set");
        assertEq(_pay().getOpenPayoutIds(3, 5).length, 0, "an offset past the end is empty");

        vm.prank(user);
        _pay().cancelPayout(a);
        assertEq(_pay().getOpenPayoutCount(), 2);

        vm.warp(block.timestamp + DELAY);
        _pay().releasePayout(b);
        uint256[] memory open = _pay().getOpenPayoutIds(0, 10);
        assertEq(open.length, 1);
        assertEq(open[0], c);

        P.lock(address(diamond), user, s1);
        assertEq(_pay().getOpenPayoutCount(), 0, "a lock's cancel-all empties it");
    }

    // ─── Signers, co-sign and the lock ───────────────────────────────────

    function testSignerNeedsItsOwnAcceptance() public {
        _enable();
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(1), s1, P.direct(user)))
        );
        vm.warp(block.timestamp + DELAY);
        _expectFinalizeRevert(
            abi.encodeCall(VaultProtection.finalizeSigner, (s1)),
            abi.encodeWithSelector(VaultProtection.NotRequested.selector)
        );
        // Only the nominee's own key accepts.
        _expectProtectRevert(
            user,
            abi.encodeCall(VaultProtection.signerChange, (uint8(2), s1, P.direct(user))),
            abi.encodeWithSelector(VaultProtection.NotRequested.selector)
        );
    }

    function testCosignRequiredForRelease() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        vm.prank(user);
        _prot().setRequireCosign(user, true);
        uint256 id = _queue(5 ether, user);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.CosignRequired.selector, id));
        _pay().releasePayout(id);
        vm.prank(s1);
        _pay().cosignPayout(id);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(user), 995 ether);
    }

    /// @dev #3415 — a payout to an allowlisted destination that has not
    ///      verified itself needs a secondary signer's co-sign whenever the
    ///      account has signers, though the account's own co-sign setting is
    ///      off. Once the destination verifies itself, a fresh row to it
    ///      releases without one.
    function test3415_unverifiedDestinationNeedsACosignUntilItVerifies() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        P.allow(address(diamond), user, user, friend, DELAY);
        assertTrue(_v().allowEntry(friend).active);
        assertFalse(_v().allowEntry(friend).verified);
        (, bool requireCosign,) = _prot().getProtection(user);
        assertFalse(requireCosign, "the account's own co-sign setting is off");

        uint256 id = _queue(2 ether, friend);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.CosignRequired.selector, id));
        _pay().releasePayout(id);
        vm.prank(user);
        _pay().cancelPayout(id);

        P.verify(address(diamond), user, friend);
        assertTrue(_v().allowEntry(friend).verified);
        uint256 id2 = _queue(3 ether, friend);
        vm.warp(block.timestamp + DELAY);
        _pay().releasePayout(id2);
        assertEq(token.balanceOf(friend), 3 ether, "a verified destination is paid without a co-sign");
    }

    function testSignerLockCancelsRowsAndBlocksNewOnes() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        uint256 id = _queue(5 ether, user);
        P.lock(address(diamond), user, s1);
        assertEq(_pay().getPendingPayout(id).state, LibProtectedAccount.ROW_CANCELLED);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.ProtectedVaultLocked.selector, user));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);
        // A settlement payout to the owner is held in the vault, not refused.
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), user, address(token), user, 1 ether);
        assertEq(token.balanceOf(user), 990 ether);

        P.requestUnlock(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_locked());
    }

    function testKeeperWithTheLockBitLocks() public {
        _enable();
        vm.startPrank(user);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        ProfileFacet(address(diamond)).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_LOCK_VAULT);
        vm.stopPrank();
        vm.prank(keeper);
        _prot().lockVaultFor(user);
        assertTrue(_locked());
    }

    function testKeeperWithoutTheLockBitCannotLock() public {
        _enable();
        vm.prank(keeper);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        _prot().lockVaultFor(user);
    }

    // ─── Replacement of the primary ──────────────────────────────────────

    function testSignerMajorityReplacesPrimaryAndPayoutsFollow() public {
        _deposit20(10 ether);
        _enable();
        _replaceWithNominee();

        assertEq(_v().vaultOwner(), nominee, "the vault's owner record moved");
        assertEq(_prot().getRetiredAccountOf(nominee), user);

        // The old wallet has lost the account.
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotAccountManager.selector, user, user));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);

        // The controller withdraws through the delay; loosening waits out the cool-down.
        vm.prank(nominee);
        uint256 id = _depo().withdrawFromVault(user, K20, address(token), 0, 4 ether, nominee);
        _expectProtectRevert(
            nominee,
            abi.encodeCall(VaultProtection.addAllowlisted, (friend, P.direct(nominee))),
            abi.encodeWithSelector(VaultProtection.InCooldown.selector, uint64(block.timestamp + DELAY))
        );
        vm.warp(block.timestamp + DELAY);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(nominee), 4 ether);
    }

    function testReplacementDropsEveryPendingChangeTheOldKeyRequested() public {
        _enable();
        _threeSigners();
        // The outgoing primary asks for loosening changes just before it is
        // replaced: a signer removal, an allowlist addition, co-sign off and
        // NFT protection off.
        vm.prank(user);
        _prot().setRequireCosign(user, true);
        P.call(
            address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s3, P.direct(user)))
        );
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.addAllowlisted, (thief, P.direct(user))));
        vm.prank(user);
        _prot().setRequireCosign(user, false);
        // ...and asks the PositionNFT core to unlock its positions (#3205).
        vm.prank(user);
        _core().requestUnlock();

        P.propose(address(diamond), user, s1, nominee);
        P.approve(address(diamond), user, s2, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), user);

        // Nothing the old key asked for survives the handover.
        (, bool requireCosign, uint64 pendingCosignOffAt) = _prot().getProtection(user);
        assertEq(pendingCosignOffAt, 0);
        (, , uint256 unlockAt, , ) = _core().lockOf(user);
        assertEq(unlockAt, 0, "the replacement voided the pending unlock");
        bytes memory notRequested = abi.encodeWithSelector(VaultProtection.NotRequested.selector);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeSigner, (s3)), notRequested);
        _expectFinalizeRevert(abi.encodeCall(VaultProtection.finalizeAllowlisted, (thief)), notRequested);
        assertTrue(_v().signerEntry(s3).active, "the voided removal left s3 a signer");
        vm.expectRevert(LibProtectedAccount.ChangeNotRequested.selector);
        _prot().finalizeSettingChanges(user);
        assertTrue(requireCosign);
        assertTrue(_core().isLocked(user), "positions stay locked");
    }

    function _replaceWithNominee() internal {
        _threeSigners();
        P.propose(address(diamond), user, s1, nominee);
        P.approve(address(diamond), user, s2, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), user);
    }

    function testRetiredWalletCannotLockOrAdoptButTheControllerLocks() public {
        _enable();
        _replaceWithNominee();
        // The replaced wallet no longer manages the account: no lock in its
        // name, no adoption into the vault it lost.
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        _prot().lockVaultFor(user);
        address v = _vault(user);
        vm.prank(user);
        nft.transferFrom(user, v, 7);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _adoptSig(address(nft), K721, 7, user, 1, deadline);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotAccountManager.selector, user, user));
        _depo().adoptUntracked(K721, address(nft), 7, 1, user, deadline, sig);
        // The controller can lock the account it now manages.
        vm.prank(nominee);
        _prot().lockVaultFor(user);
        assertTrue(_locked());
    }

    function testTwoSignersCannotRecover() public {
        _enable();
        _addSigner(s1);
        _addSigner(s2);
        _expectProtectRevert(
            s1,
            abi.encodeCall(VaultProtection.replacement, (uint8(1), nominee, P.direct(s1))),
            abi.encodeWithSelector(VaultProtection.NotEnoughSigners.selector, 2, 3)
        );
    }

    function testOwnerCannotCancelReplacementUnderSignerLock() public {
        _enable();
        _threeSigners();
        P.lock(address(diamond), user, s1);
        P.propose(address(diamond), user, s1, nominee);
        _expectProtectRevert(
            user,
            abi.encodeCall(VaultProtection.replacement, (uint8(3), nominee, P.direct(user))),
            abi.encodeWithSelector(VaultProtection.OwnerBlockedBySignerLock.selector)
        );
    }

    // ─── Switching off ───────────────────────────────────────────────────

    /// @dev #3379 B2 — the switch-off waits the delay. (The "no open rows"
    ///      half of the old test is not enforced by the vault's switch-off;
    ///      see the port report.)
    function testDisableWaitsTheDelayAndNeedsNoOpenRows() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(1 ether, user);
        P.requestDisable(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY - 1);
        P.finalizeSettings(address(diamond), user);
        assertTrue(_enabled(), "not before the delay");
        vm.warp(block.timestamp + 1);
        // The switch-off waits while a row is queued: it was the one change
        // due, so it says so rather than succeed doing nothing.
        address v = address(P.vaultOf(address(diamond), user));
        vm.expectRevert(VaultProtection.PendingRowsExist.selector);
        VaipakamVaultImplementation(v).protect(abi.encodeCall(VaultProtection.finalizeSettings, ()));
        assertTrue(_enabled(), "not while a row is queued");
        _pay().releasePayout(id);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_enabled());
    }

    // ─── The escape route ────────────────────────────────────────────────

    function testEscapeOpensOnlyAfterTheGraceOfAManualPause() public {
        _deposit20(10 ether);
        AdminFacet(address(diamond)).pause();
        vm.prank(user);
        vm.expectRevert(LibProtectedAccount.EscapeClosed.selector);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);

        vm.warp(block.timestamp + LibPausable.ESCAPE_GRACE_DEFAULT);
        assertTrue(_pay().isEscapeOpen());
        vm.prank(user);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);
        assertEq(token.balanceOf(user), 1_000 ether);
    }

    function testAutoPauseDuringAManualPauseDoesNotRestartTheEscapeGrace() public {
        _deposit20(10 ether);
        AccessControlFacet(address(diamond)).grantRole(keccak256("WATCHER_ROLE"), address(this));
        AdminFacet(address(diamond)).pause();
        uint256 start = block.timestamp;
        // A watcher fires twice during the manual pause; each restamps the
        // pause boundary, but the escape grace runs from the manual pause.
        vm.warp(start + 1 days);
        AdminFacet(address(diamond)).autoPause("probe");
        vm.warp(start + 2 days + 12 hours);
        AdminFacet(address(diamond)).autoPause("probe again");
        vm.warp(start + LibPausable.ESCAPE_GRACE_DEFAULT);
        assertTrue(_pay().isEscapeOpen());
        vm.prank(user);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);
        assertEq(token.balanceOf(user), 1_000 ether);
    }

    function testProtectedPayoutStillReleasesDuringEscape() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(3 ether, user);
        AdminFacet(address(diamond)).pause();
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        _pay().releasePayout(id);
        vm.warp(block.timestamp + LibPausable.ESCAPE_GRACE_DEFAULT);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(user), 993 ether);
    }

    // ─── The escape period knob (#3173) ──────────────────────────────────

    function testEscapePeriodDefaultsToThreeDays() public view {
        (uint256 nextPause, uint256 currentPause) = AdminFacet(address(diamond)).getEscapeGraceSeconds();
        assertEq(nextPause, 3 days);
        assertEq(currentPause, 0);
        assertEq(_pay().escapeOpensAt(), 0);
    }

    function testEscapePeriodBoundsAndZeroRestoresTheDefault() public {
        AdminFacet admin = AdminFacet(address(diamond));
        uint32 justUnder = uint32(LibPausable.MIN_ESCAPE_GRACE - 1);
        vm.expectRevert(abi.encodeWithSelector(
            LibPausable.InvalidEscapeGrace.selector, justUnder, LibPausable.MIN_ESCAPE_GRACE, LibPausable.MAX_ESCAPE_GRACE));
        admin.setEscapeGraceSeconds(justUnder);
        uint32 justOver = uint32(LibPausable.MAX_ESCAPE_GRACE + 1);
        vm.expectRevert(abi.encodeWithSelector(
            LibPausable.InvalidEscapeGrace.selector, justOver, LibPausable.MIN_ESCAPE_GRACE, LibPausable.MAX_ESCAPE_GRACE));
        admin.setEscapeGraceSeconds(justOver);

        vm.expectEmit(address(diamond));
        emit LibPausable.EscapeGraceSet(49 hours);
        admin.setEscapeGraceSeconds(49 hours);
        (uint256 nextPause,) = admin.getEscapeGraceSeconds();
        assertEq(nextPause, 49 hours);
        admin.setEscapeGraceSeconds(7 days);
        (nextPause,) = admin.getEscapeGraceSeconds();
        assertEq(nextPause, 7 days);
        admin.setEscapeGraceSeconds(0);
        (nextPause,) = admin.getEscapeGraceSeconds();
        assertEq(nextPause, 3 days);
    }

    function testOnlyTheAdminSetsTheEscapePeriod() public {
        vm.prank(thief);
        vm.expectRevert();
        AdminFacet(address(diamond)).setEscapeGraceSeconds(5 days);
        (uint256 nextPause,) = AdminFacet(address(diamond)).getEscapeGraceSeconds();
        assertEq(nextPause, 3 days);
    }

    function testAChangeDuringAPauseDoesNotMoveItsEscape() public {
        _deposit20(10 ether);
        AdminFacet admin = AdminFacet(address(diamond));
        admin.pause();
        uint256 start = block.timestamp;
        assertEq(_pay().escapeOpensAt(), start + 3 days);

        // Shortening the period mid-pause does not open the escape early...
        admin.setEscapeGraceSeconds(49 hours);
        assertEq(_pay().escapeOpensAt(), start + 3 days);
        (uint256 nextPause, uint256 currentPause) = admin.getEscapeGraceSeconds();
        assertEq(nextPause, 49 hours);
        assertEq(currentPause, 3 days);
        vm.warp(start + 49 hours);
        assertFalse(_pay().isEscapeOpen());
        vm.prank(user);
        vm.expectRevert(LibProtectedAccount.EscapeClosed.selector);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);

        // ...and lengthening it does not close an escape the users were promised.
        admin.setEscapeGraceSeconds(7 days);
        vm.warp(start + 3 days);
        assertTrue(_pay().isEscapeOpen());

        // A repeat pause inside the same manual pause keeps the period too.
        admin.pause();
        assertEq(_pay().escapeOpensAt(), start + 3 days);
        assertTrue(_pay().isEscapeOpen());
    }

    function testTheNextPauseUsesTheNewPeriod() public {
        _deposit20(10 ether);
        AdminFacet admin = AdminFacet(address(diamond));
        admin.setEscapeGraceSeconds(5 days);
        admin.pause();
        uint256 start = block.timestamp;
        assertEq(_pay().escapeOpensAt(), start + 5 days);
        vm.warp(start + 5 days - 1);
        assertFalse(_pay().isEscapeOpen());
        vm.warp(start + 5 days);
        assertTrue(_pay().isEscapeOpen());
        vm.prank(user);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);
        assertEq(token.balanceOf(user), 1_000 ether);

        // Once unpaused there is no escape time; a later pause stamps afresh.
        admin.unpause();
        assertEq(_pay().escapeOpensAt(), 0);
        (, uint256 currentPause) = admin.getEscapeGraceSeconds();
        assertEq(currentPause, 0);
        admin.setEscapeGraceSeconds(0);
        admin.pause();
        assertEq(_pay().escapeOpensAt(), block.timestamp + 3 days);
    }

    // ─── Implementation pin ──────────────────────────────────────────────

    // ─── Position NFTs ───────────────────────────────────────────────────

    /// @dev #3205 — a protected account's positions sit under the
    ///      PositionNFT core's holder lock, and a NEW position minted to it
    ///      is locked from the start: no transfer, no approval.
    function testProtectedAccountsNewPositionIsMintedLocked() public {
        _enable();
        _mintTo(user, 1);
        assertTrue(_core().isLocked(user));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, user));
        _core().transferFrom(user, friend, 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, user));
        _core().setApprovalForAll(friend, true);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, user));
        _core().approve(friend, 1);
    }

    /// @dev Enabling raises the core lock delay toward the account's delay
    ///      (capped at the core's Diamond cap); the holder's own unlock then
    ///      waits it, after which the position moves freely.
    function testHolderUnlocksAfterTheDelayThenMoves() public {
        _mintTo(user, 1);
        _enable();
        (, uint256 delay, , , ) = _core().lockOf(user);
        uint256 cap = _core().MAX_DIAMOND_LOCK_DELAY();
        assertEq(delay, DELAY > cap ? cap : DELAY, "lock delay follows the protected delay");
        vm.prank(user);
        _core().requestUnlock();
        vm.warp(block.timestamp + delay - 1);
        vm.expectRevert();
        _core().executeUnlock(user);
        vm.warp(block.timestamp + 1);
        _core().executeUnlock(user);
        vm.prank(user);
        _core().transferFrom(user, friend, 1);
        assertEq(_core().ownerOf(1), friend);
    }

    /// @dev A pending unlock is voided by a protected-mode lock, by a
    ///      switch-off, and by a re-enable: none matures under the next posture.
    function testPendingUnlockIsVoidedByLockSwitchOffAndReEnable() public {
        _mintTo(user, 1);
        _enable();
        uint256 at;
        // 1. A lock voids it (and keeps the tokens locked).
        vm.prank(user);
        _core().requestUnlock();
        (, , at, , ) = _core().lockOf(user);
        assertGt(at, 0);
        P.lock(address(diamond), user, user);
        (, , at, , ) = _core().lockOf(user);
        assertEq(at, 0, "lock voids the pending unlock");
        assertTrue(_core().isLocked(user));
        // Unlock the protected vault again (its own delayed path).
        P.requestUnlock(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        // 2. A switch-off voids it.
        vm.prank(user);
        _core().requestUnlock();
        P.requestDisable(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_enabled());
        (, , at, , ) = _core().lockOf(user);
        assertEq(at, 0, "switch-off voids the pending unlock");
        // 3. A re-enable voids it.
        vm.prank(user);
        _core().requestUnlock();
        (, , at, , ) = _core().lockOf(user);
        assertGt(at, 0);
        _enable();
        (, , at, , ) = _core().lockOf(user);
        assertEq(at, 0, "re-enable voids the pending unlock");
        assertTrue(_core().isLocked(user));
    }

    /// @dev The Diamond can lock a holder and raise the lock delay (capped),
    ///      and void a pending change, but it has no path that unlocks a
    ///      holder or lowers a delay.
    function testTheDiamondCannotUnlockOrLowerTheDelay() public {
        _mintTo(user, 1);
        _enable();
        PositionNFT c = _core();
        (, uint256 delay, , , ) = c.lockOf(user);
        // No pending unlock: executing one reverts for anyone, the Diamond too.
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NoUnlockPending.selector, user));
        c.executeUnlock(user);
        // The Diamond's own requestUnlock acts on the Diamond's address only.
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderNotLocked.selector, address(diamond)));
        c.requestUnlock();
        // Its raise only raises, and never past its cap.
        uint256 cap = c.MAX_DIAMOND_LOCK_DELAY();
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.DelayNotHigher.selector, delay, delay));
        c.raiseLockDelay(user, delay);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.DelayAboveDiamondCap.selector, cap + 1, cap));
        c.raiseLockDelay(user, cap + 1);
        // Lowering the delay is the holder's own setLockDelay; the Diamond
        // calling it changes only the Diamond's own (unlocked) record.
        vm.prank(address(diamond));
        c.setLockDelay(0);
        (bool locked, uint256 after_, , , ) = c.lockOf(user);
        assertTrue(locked);
        assertEq(after_, delay);
        // And no one but the Diamond may use its lock powers.
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NotDiamond.selector, thief));
        c.voidPending(user);
    }

    function testALockVoidsTheOwnersReplacementProposal() public {
        _enable();
        _addSigner(s1);
        P.propose(address(diamond), user, user, nominee);
        P.lock(address(diamond), user, s1);
        vm.warp(block.timestamp + DELAY);
        _expectFinalizeRevert(
            abi.encodeCall(VaultProtection.finalizeReplacement, ()),
            abi.encodeWithSelector(VaultProtection.NoProposal.selector)
        );
    }

    // ─── The depository ledger ───────────────────────────────────────────

    /// @dev A balance the protocol puts in `who`'s vault for its own purpose
    ///      (an offer escrow, a rental prepayment, a claim): tracked, never
    ///      credited to the depository ledger.
    function _protocolPlaces20(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(diamond), type(uint256).max);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(who, address(token), amount);
    }

    function testProtocolPlacedBalanceIsNotWithdrawable() public {
        _protocolPlaces20(user, 50 ether);
        assertEq(_depo().freeHolding(user, K20, address(token), 0), 50 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 1, 0));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1, user);

        _deposit20(10 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 10 ether);
        vm.prank(user);
        _depo().withdrawFromVault(user, K20, address(token), 0, 10 ether, user);
        assertEq(_depo().getDepositoryHolding(user, address(token), 0), 0);
        assertEq(_tracked(user, address(token), 0), 50 ether);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 1, 0));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1, user);
    }

    function testProtocolPlacedNftIsNotWithdrawable() public {
        // A lent or pledged NFT the protocol pulled into the vault.
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC721(user, user, address(nft), 7);
        assertEq(_tracked(user, address(nft), 7), 1);
        assertEq(_depo().withdrawableNow(user, K721, address(nft), 7), 0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 1, 0));
        _depo().withdrawFromVault(user, K721, address(nft), 7, 1, user);
    }

    function testPayoutKeptInLockedVaultBecomesTheOwners() public {
        _protocolPlaces20(user, 10 ether);
        _enable();
        P.lock(address(diamond), user, user);
        // A settlement paying the locked owner's wallet stays in the vault ...
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), user, address(token), user, 4 ether);
        // ... and is theirs to withdraw once unlocked.
        assertEq(_depo().getDepositoryHolding(user, address(token), 0), 4 ether);
        P.requestUnlock(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 4 ether);
    }

    function testCancelledProtocolPayoutIsCreditedToTheOwner() public {
        _protocolPlaces20(user, 10 ether);
        _enable();
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), user, address(token), user, 4 ether);
        uint256 id = _pay().getPendingPayoutIds(user)[0];
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 0);
        vm.prank(user);
        _pay().cancelPayout(id);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 4 ether);
    }

    function testCancelledOwnWithdrawalIsCreditedBack() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(6 ether, user);
        assertEq(_depo().getDepositoryHolding(user, address(token), 0), 4 ether);
        vm.prank(user);
        _pay().cancelPayout(id);
        assertEq(_depo().getDepositoryHolding(user, address(token), 0), 10 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 10 ether);
    }

    function testPaymentToProtectedWalletIsCreditedToItsVault() public {
        _protocolPlaces20(friend, 5 ether);
        _enable();
        address userVault = _vault(user);
        vm.expectEmit(address(diamond));
        emit LibProtectedAccount.PaymentCreditedToVault(user, address(token), 0, 5 ether, 5 ether);
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC20(address(diamond), friend, address(token), user, 5 ether);
        assertEq(token.balanceOf(user), 1_000 ether);
        assertEq(token.balanceOf(userVault), 5 ether);
        assertEq(_tracked(friend, address(token), 0), 0);
        assertEq(_tracked(user, address(token), 0), 5 ether);
        assertEq(_depo().withdrawableNow(user, K20, address(token), 0), 5 ether);
    }

    function testNftPaidToProtectedWalletIsCreditedToItsVault() public {
        nft.mint(friend, 8);
        vm.prank(friend);
        nft.setApprovalForAll(address(diamond), true);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC721(friend, friend, address(nft), 8);
        _enable();
        vm.prank(address(diamond));
        LibTestOutflow.withdrawERC721(address(diamond), friend, address(nft), 8, user);
        assertEq(nft.ownerOf(8), _vault(user));
        assertEq(_tracked(user, address(nft), 8), 1);
        assertEq(_depo().withdrawableNow(user, K721, address(nft), 8), 1);
    }

    function testVaultAcceptsAnNftFromAnotherVaipakamVaultOnly() public {
        address mine = _vault(user);
        address other = _vault(friend);
        assertEq(_depo().getVaultOwner(other), friend);
        assertEq(_depo().getVaultOwner(friend), address(0));
        assertEq(
            VaipakamVaultImplementation(mine).onERC721Received(other, other, 1, ""),
            IERC721Receiver.onERC721Received.selector
        );
        assertEq(
            VaipakamVaultImplementation(mine).onERC1155Received(other, other, 1, 5, ""),
            IERC1155Receiver.onERC1155Received.selector
        );
        vm.expectRevert(VaipakamVaultImplementation.UnauthorizedNFTSender.selector);
        VaipakamVaultImplementation(mine).onERC721Received(friend, friend, 1, "");
    }

    function testEscapeIsBoundedByTheDepositoryLedger() public {
        _protocolPlaces20(user, 10 ether);
        _deposit20(3 ether);
        AdminFacet(address(diamond)).pause();
        vm.warp(block.timestamp + LibPausable.ESCAPE_GRACE_DEFAULT);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.AmountExceedsFree.selector, 10 ether, 3 ether));
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);
        vm.prank(user);
        _pay().escapeWithdraw(K20, address(token), 0, 3 ether);
        // The 3 deposited came back; the 10 the protocol placed stayed.
        assertEq(token.balanceOf(user), 1_000 ether);
        assertEq(_tracked(user, address(token), 0), 10 ether);
    }

    function testSpendDrawsTheDepositoryLedgerDownFirst() public {
        DepositoryLedgerHarness h = new DepositoryLedgerHarness();
        h.credit(user, address(token), 0, 10);
        h.spend(user, address(token), 0, 4);
        assertEq(h.holding(user, address(token), 0), 6);
        h.spend(user, address(token), 0, 100);
        assertEq(h.holding(user, address(token), 0), 0);
        h.spend(user, address(token), 0, 1); // saturating, never reverts
        assertEq(h.withdrawable(user, address(token), 0, 5), 0);
        h.credit(user, address(token), 0, 9);
        assertEq(h.withdrawable(user, address(token), 0, 5), 5);
        vm.expectRevert(abi.encodeWithSelector(LibDepositoryLedger.DepositoryHoldingExceeded.selector, 10, 9));
        h.debit(user, address(token), 0, 10);
    }

    // ─── Round-1 review fixes ────────────────────────────────────────────

    function testRepeatLockByOwnerKeepsTheSignerOrigin() public {
        _enable();
        _threeSigners();
        P.lock(address(diamond), user, s1);
        P.lock(address(diamond), user, user);
        (,,,, address lockedBy,,) = _v().protectionState();
        assertEq(lockedBy, s1);
        _expectProtectRevert(
            user,
            abi.encodeCall(VaultProtection.replacement, (uint8(1), friend, P.direct(user))),
            abi.encodeWithSelector(VaultProtection.OwnerBlockedBySignerLock.selector)
        );
    }

    function testApprovalsOfAClearedRoundDoNotCarryOver() public {
        _enable();
        _threeSigners();
        P.propose(address(diamond), user, s1, nominee);
        (,,, uint32 firstRound) = _v().replacementProposal();

        // Switching off clears the account; switching on again starts over.
        P.requestDisable(address(diamond), user, user);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), user);
        assertFalse(_enabled());
        _enable();
        _threeSigners();

        P.propose(address(diamond), user, s2, friend);
        (,, uint64 readyAt, uint32 round) = _v().replacementProposal();
        assertGt(round, firstRound);
        assertEq(readyAt, 0, "one of three is no majority");
        // s1's approval of the cleared round does not count for this one:
        // s1 may approve, and only now is the majority reached.
        P.approve(address(diamond), user, s1, friend);
        (,, readyAt,) = _v().replacementProposal();
        assertTrue(readyAt != 0);
    }

    function testRetiredAccountProtectsPositionNftsEvenIfNotChosen() public {
        _mintTo(user, 1);
        P.enable(address(diamond), user, DELAY);
        assertFalse(_core().isLocked(user));
        _replaceWithNominee();
        // The old wallet still holds the token but can no longer move it:
        // the replacement put it under the core's holder lock (#3205; the
        // vault-verified recovery transfer to the new wallet is PR 2).
        assertTrue(_core().isLocked(user));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, user));
        _core().transferFrom(user, thief, 1);
    }

    // ─── Codex #3489 round 1 ─────────────────────────────────────────────

    /// @dev A second replacement is a handover too: the outgoing controller's
    ///      pending co-sign switch-off dies with it and can never apply.
    function testSecondReplacementDropsTheOutgoingControllersPendingChanges() public {
        _deposit20(10 ether);
        _enable();
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1); // past the cool-down
        P.addSigner(address(diamond), user, nominee, s1, DELAY);
        vm.startPrank(nominee);
        _prot().setRequireCosign(user, true);
        _prot().setRequireCosign(user, false);
        vm.stopPrank();
        (,, uint64 offAt) = _prot().getProtection(user);
        assertGt(offAt, 0, "fixture: the controller's switch-off is pending");

        address nominee2 = makeAddr("nominee2");
        P.propose(address(diamond), user, nominee, nominee2);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        (,, offAt) = _prot().getProtection(user);
        assertEq(offAt, 0, "the handover dropped it");
        assertEq(_prot().getRetiredAccountOf(nominee2), user, "the new controller is recorded");
        assertEq(_prot().getRetiredAccountOf(nominee), address(0), "the outgoing one is not");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(LibProtectedAccount.ChangeNotRequested.selector);
        _prot().finalizeSettingChanges(user);
    }

    /// @dev Every platform-side loosening waits out a new owner's cool-down.
    function testCosignOffIsRefusedDuringTheNewOwnersCooldown() public {
        _enable();
        _addSigner(s1);
        vm.prank(user);
        _prot().setRequireCosign(user, true);
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.prank(nominee);
        vm.expectRevert(
            abi.encodeWithSelector(LibProtectedAccount.PrimaryInCooldown.selector, vm.getBlockTimestamp() + DELAY)
        );
        _prot().setRequireCosign(user, false);
    }

    /// @dev Removing the last signer leaves nobody to co-sign: the requirement
    ///      stops binding at once and is cleared when applied.
    function testRemovingTheLastSignerClearsTheCosignRequirement() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        vm.prank(user);
        _prot().setRequireCosign(user, true);
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(user))));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.vaultOf(address(diamond), user).protect(abi.encodeCall(VaultProtection.finalizeSigner, (s1)));
        uint256 id = _queue(1 ether, user);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        // Before anyone applies the platform side, the stored flag is still
        // set: every reader uses the effective rule, so nothing waits on a
        // co-signature nobody can give.
        assertFalse(_pay().payoutNeedsCosign(id), "the view: no co-sign needed");
        (, bool inForce,) = _prot().getProtection(user);
        assertFalse(inForce, "reported as it binds");
        uint256 before = token.balanceOf(user);
        _pay().releasePayout(id); // no co-sign: no signer is left to give one
        assertEq(token.balanceOf(user) - before, 1 ether, "paid without a co-sign");
        _prot().applyProtection(user);
        (, bool requireCosign,) = _prot().getProtection(user);
        assertFalse(requireCosign, "cleared on apply");
    }

    /// @dev Codex #3489 r2 — one co-sign rule, read per row: the view agrees
    ///      with the release, the account's setting binds only while it has a
    ///      signer, and an unverified destination needs a co-sign with the
    ///      setting off.
    function testPayoutNeedsCosignFollowsTheReleaseRule() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        P.allow(address(diamond), user, user, friend, DELAY);
        uint256 toFriend = _queue(1 ether, friend);
        uint256 toUser = _queue(1 ether, user);
        assertTrue(_pay().payoutNeedsCosign(toFriend), "unverified destination, setting off");
        assertFalse(_pay().payoutNeedsCosign(toUser), "the owner's wallet, setting off");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.CosignRequired.selector, toFriend));
        _pay().releasePayout(toFriend);

        vm.prank(user);
        _prot().setRequireCosign(user, true);
        assertTrue(_pay().payoutNeedsCosign(toUser), "setting on, a signer to give it");
        (, bool on,) = _prot().getProtection(user);
        assertTrue(on);
        // The last signer leaves: the setting stops binding before anyone applies.
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(user))));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.vaultOf(address(diamond), user).protect(abi.encodeCall(VaultProtection.finalizeSigner, (s1)));
        assertFalse(_pay().payoutNeedsCosign(toUser), "no signer left");
        (, on,) = _prot().getProtection(user);
        assertFalse(on, "reported as it binds");
        _pay().releasePayout(toUser);
        assertFalse(_pay().payoutNeedsCosign(toUser), "not queued any more");
    }

    /// @dev Codex #3489 r4 — a replacement may not name the account's own
    ///      wallet: the creation owner (which would undo the retirement) or
    ///      the wallet holding it now.
    function testAReplacementBackToTheAccountsOwnWalletIsRefused() public {
        _enable();
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), user);
        vm.prank(nominee);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.NomineeIsAccountWallet.selector, user));
        v.protect(abi.encodeCall(VaultProtection.replacement, (uint8(1), user, P.direct(nominee))));
        vm.prank(nominee);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.NomineeIsAccountWallet.selector, nominee));
        v.protect(abi.encodeCall(VaultProtection.replacement, (uint8(1), nominee, P.direct(nominee))));
    }

    /// @dev Codex #3489 r4 — after A→B→C the account stays retired, protected
    ///      and routed through its vault, even once switched off.
    function testRetirementIsPermanentAcrossReplacementsAndASwitchOff() public {
        _deposit20(10 ether);
        _enable();
        address third = makeAddr("third");
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        P.propose(address(diamond), user, nominee, third);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        P.requestDisable(address(diamond), user, third);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeSettings(address(diamond), user);
        (bool on,,,, bool retired) = P.vaultOf(address(diamond), user).protectionCore();
        assertFalse(on, "fixture: switched off");
        assertTrue(retired, "still retired");
        assertTrue(_prot().isProtectionOn(user), "still governed");
        assertEq(_prot().protectionManagerOf(user), third, "managed by the latest wallet");
        vm.prank(user);
        vm.expectRevert();
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);
        vm.prank(third);
        uint256 id = _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, third);
        assertEq(token.balanceOf(third), 0, "queued through the vault");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(third), 1 ether, "paid to the latest wallet");
    }

    /// @dev Codex #3489 r3 — a row the release would cancel (its destination
    ///      removed) is not reported as waiting on a co-signature, so a
    ///      keeper's release settles it.
    function testARowTheReleaseWouldCancelNeedsNoCosign() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        P.allow(address(diamond), user, user, friend, DELAY);
        uint256 id = _queue(1 ether, friend);
        assertTrue(_pay().payoutNeedsCosign(id), "fixture: unverified destination");
        P.removeAllowed(address(diamond), user, user, friend);
        assertFalse(_pay().payoutNeedsCosign(id), "the release cancels it first");
        _pay().releasePayout(id);
        assertEq(_pay().getPendingPayout(id).state, 3, "cancelled by the release");
    }

    /// @dev Codex #3489 r3 — a removal voided by a lock or a replacement
    ///      reads as not pending, and a fresh one can be requested.
    function testAVoidedSignerRemovalReadsAsNotPending() public {
        _enable();
        _addSigner(s1);
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(user))));
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), user);
        assertGt(v.signerEntry(s1).removeAt, 0, "fixture: removal pending");
        P.lock(address(diamond), user, user);
        assertEq(v.signerEntry(s1).removeAt, 0, "a lock voids it");
        assertTrue(v.signerEntry(s1).active, "still a signer");
    }

    function testAVoidedSignerRemovalCanBeAskedAgainAfterAReplacement() public {
        _enable();
        _addSigner(s1);
        P.call(address(diamond), user, user, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(user))));
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), user);
        assertEq(v.signerEntry(s1).removeAt, 0, "the replacement voids it");
        vm.warp(vm.getBlockTimestamp() + DELAY + 1); // past the new owner's cool-down
        P.call(address(diamond), user, nominee, abi.encodeCall(VaultProtection.signerChange, (uint8(3), s1, P.direct(nominee))));
        assertGt(v.signerEntry(s1).removeAt, 0, "asked again");
    }

    /// @dev Codex #3489 r3 — a replacement's routing is permanent: after the
    ///      new wallet switches protected mode off, the retired wallet's
    ///      payouts still go through the vault to the new wallet.
    function testARetiredAccountStaysRoutedAfterASwitchOff() public {
        _deposit20(10 ether);
        _enable();
        P.propose(address(diamond), user, user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeReplacement(address(diamond), user);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        P.requestDisable(address(diamond), user, nominee);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        P.finalizeSettings(address(diamond), user);
        (bool on,,,,,,) = P.vaultOf(address(diamond), user).protectionState();
        assertFalse(on, "fixture: switched off");
        assertTrue(_prot().isProtectionOn(user), "still governed: retired");
        uint256 before = token.balanceOf(user);
        vm.prank(nominee);
        uint256 id = _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, nominee);
        assertEq(token.balanceOf(nominee), 0, "queued, not paid at once");
        assertEq(token.balanceOf(user), before, "the retired wallet got nothing");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(nominee), 1 ether, "paid to the new wallet");
    }

    /// @dev An allowlisted destination that has protected mode on is paid
    ///      into its own vault, which the paying vault accepts.
    function testAllowlistedProtectedDestinationIsPaidIntoItsVault() public {
        _deposit20(10 ether);
        _enable();
        P.enable(address(diamond), friend, DELAY);
        P.allow(address(diamond), user, user, friend, DELAY);
        P.verify(address(diamond), user, friend);
        address friendVault = address(P.vaultOf(address(diamond), friend));
        uint256 before = token.balanceOf(friendVault);
        uint256 id = _queue(2 ether, friend);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(friendVault) - before, 2 ether, "landed in the destination's vault");
        assertEq(token.balanceOf(friend), 0, "not in its wallet");
    }
}

/// @dev Exposes `LibDepositoryLedger` on its own storage for the unit test.
contract DepositoryLedgerHarness {
    function credit(address u, address a, uint256 id, uint256 n) external {
        LibDepositoryLedger.credit(u, a, id, n);
    }

    function debit(address u, address a, uint256 id, uint256 n) external {
        LibDepositoryLedger.debit(u, a, id, n);
    }

    function spend(address u, address a, uint256 id, uint256 n) external {
        LibDepositoryLedger.spend(u, a, id, n);
    }

    function holding(address u, address a, uint256 id) external view returns (uint256) {
        return LibDepositoryLedger.holding(u, a, id);
    }

    function withdrawable(address u, address a, uint256 id, uint256 free) external view returns (uint256) {
        return LibDepositoryLedger.withdrawable(u, a, id, free);
    }
}
