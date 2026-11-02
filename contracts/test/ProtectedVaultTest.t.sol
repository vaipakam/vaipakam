// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
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
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {LibERC721} from "../src/libraries/LibERC721.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

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
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
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

    function _enable() internal {
        vm.prank(user);
        _prot().enableProtectedMode(DELAY, true);
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
        vm.prank(user);
        _prot().addSigner(user, signer);
        vm.prank(signer);
        _prot().acceptSignerRole(user);
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeAddSigner(user, signer);
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

        vm.startPrank(user);
        _depo().withdrawFromVault(user, K20, address(token), 0, 40 ether, friend);
        _depo().withdrawFromVault(user, K721, address(nft), 7, 0, user);
        _depo().withdrawFromVault(user, K1155, address(multi), 3, 4, user);
        vm.stopPrank();
        assertEq(token.balanceOf(friend), 40 ether);
        assertEq(_tracked(user, address(token), 0), 60 ether);
        assertEq(nft.ownerOf(7), user);
        assertEq(_tracked(user, address(nft), 7), 0);
        assertEq(multi.balanceOf(user, 3), 10);
        assertEq(_tracked(user, address(multi), 3), 0);
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
        vm.expectRevert(abi.encodeWithSelector(VaultDepositoryFacet.NotAccountOwner.selector, user, thief));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, thief);
    }

    // ─── Adopt and disown ────────────────────────────────────────────────

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
        vm.prank(user);
        _prot().addAllowlisted(user, friend);
        vm.expectRevert();
        _prot().finalizeAddAllowlisted(user, friend);
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeAddAllowlisted(user, friend);
        _queue(1 ether, friend);
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
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user, address(token), user, 4 ether);
        assertEq(token.balanceOf(user), 990 ether);
        assertEq(_pay().getPendingPayoutIds(user).length, 1);
        // ... while a payment to a counterparty passes untouched.
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user, address(token), friend, 1 ether);
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

    // ─── Signers, co-sign and the lock ───────────────────────────────────

    function testSignerNeedsItsOwnAcceptance() public {
        _enable();
        vm.prank(user);
        _prot().addSigner(user, s1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.SignerNotAccepted.selector, s1));
        _prot().finalizeAddSigner(user, s1);
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

    function testSignerLockCancelsRowsAndBlocksNewOnes() public {
        _deposit20(10 ether);
        _enable();
        _addSigner(s1);
        uint256 id = _queue(5 ether, user);
        vm.prank(s1);
        _prot().lockVault(user);
        assertEq(_pay().getPendingPayout(id).state, LibProtectedAccount.ROW_CANCELLED);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.ProtectedVaultLocked.selector, user));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);
        // A settlement payout to the owner is held in the vault, not refused.
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user, address(token), user, 1 ether);
        assertEq(token.balanceOf(user), 990 ether);

        vm.prank(user);
        _prot().requestUnlock(user);
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeSettingChanges(user);
        assertFalse(_prot().getProtectedAccount(user).locked);
    }

    function testKeeperWithTheLockBitLocks() public {
        _enable();
        vm.startPrank(user);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        ProfileFacet(address(diamond)).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_LOCK_VAULT);
        vm.stopPrank();
        vm.prank(keeper);
        _prot().lockVaultFor(user);
        assertTrue(_prot().getProtectedAccount(user).locked);
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
        _threeSigners();
        vm.prank(s1);
        _prot().proposeReplacement(user, nominee);
        vm.prank(s2);
        _prot().approveReplacement(user);
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeReplacement(user);

        LibVaipakam.ProtectedAccount memory a = _prot().getProtectedAccount(user);
        assertTrue(a.retired);
        assertEq(a.controller, nominee);
        assertEq(_prot().getRetiredAccountOf(nominee), user);

        // The old wallet has lost the account.
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(VaultDepositoryFacet.NotAccountOwner.selector, user, user));
        _depo().withdrawFromVault(user, K20, address(token), 0, 1 ether, user);

        // The controller withdraws through the delay; loosening waits out the cool-down.
        vm.prank(nominee);
        uint256 id = _depo().withdrawFromVault(user, K20, address(token), 0, 4 ether, nominee);
        vm.prank(nominee);
        vm.expectRevert();
        _prot().addAllowlisted(user, friend);
        vm.warp(block.timestamp + DELAY);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(nominee), 4 ether);
    }

    function testTwoSignersCannotRecover() public {
        _enable();
        _addSigner(s1);
        _addSigner(s2);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotEnoughSigners.selector, 2, 3));
        _prot().proposeReplacement(user, nominee);
    }

    function testOwnerCannotCancelReplacementUnderSignerLock() public {
        _enable();
        _threeSigners();
        vm.prank(s1);
        _prot().lockVault(user);
        vm.prank(s1);
        _prot().proposeReplacement(user, nominee);
        vm.prank(user);
        vm.expectRevert(LibProtectedAccount.OwnerCannotCancelWhileSignerLock.selector);
        _prot().cancelReplacement(user);
    }

    // ─── Switching off ───────────────────────────────────────────────────

    function testDisableWaitsTheDelayAndNeedsNoOpenRows() public {
        _deposit20(10 ether);
        _enable();
        uint256 id = _queue(1 ether, user);
        vm.prank(user);
        _prot().requestDisableProtectedMode();
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(LibProtectedAccount.PendingRowsExist.selector);
        _prot().finalizeSettingChanges(user);
        _pay().releasePayout(id);
        _prot().finalizeSettingChanges(user);
        assertFalse(_prot().getProtectedAccount(user).enabled);
    }

    // ─── The escape route ────────────────────────────────────────────────

    function testEscapeOpensOnlyAfterTheGraceOfAManualPause() public {
        _deposit20(10 ether);
        AdminFacet(address(diamond)).pause();
        vm.prank(user);
        vm.expectRevert(LibProtectedAccount.EscapeClosed.selector);
        _pay().escapeWithdraw(K20, address(token), 0, 10 ether);

        vm.warp(block.timestamp + LibProtectedAccount.ESCAPE_GRACE);
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
        vm.warp(block.timestamp + LibProtectedAccount.ESCAPE_GRACE);
        _pay().releasePayout(id);
        assertEq(token.balanceOf(user), 993 ether);
    }

    // ─── Implementation pin ──────────────────────────────────────────────

    function testProtectedUnpinWaitsTheDelay() public {
        vm.prank(user);
        _depo().pinVaultImplementation();
        assertTrue(_depo().getVaultPin(user) != address(0));
        _enable();
        vm.prank(user);
        _depo().unpinVaultImplementation();
        assertTrue(_depo().getVaultPin(user) != address(0));
        vm.warp(block.timestamp + DELAY);
        _prot().finalizeSettingChanges(user);
        assertEq(_depo().getVaultPin(user), address(0));
    }

    // ─── Position NFTs ───────────────────────────────────────────────────

    function testProtectedOwnerPositionMovesOnlyThroughTheQueue() public {
        vm.prank(address(diamond));
        _nftFacet().mintNFT(user, 1, 1, 0, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        _enable();
        assertEq(uint8(_nftFacet().positionLock(1)), uint8(LibERC721.LockReason.ProtectedOwner));
        vm.prank(user);
        vm.expectRevert();
        _nftFacet().transferFrom(user, friend, 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LibERC721.ProtectedOwnerApprovalForbidden.selector, user));
        _nftFacet().setApprovalForAll(friend, true);

        vm.prank(user);
        uint256 id = _nftFacet().queuePositionTransfer(1, friend);
        vm.warp(block.timestamp + DELAY);
        _nftFacet().releasePositionTransfer(id);
        assertEq(_nftFacet().ownerOf(1), friend);
    }
}
