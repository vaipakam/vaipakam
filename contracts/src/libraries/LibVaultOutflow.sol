// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VaultOutflowTypes, OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibRevert} from "./LibRevert.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/// @dev The policy host's entries, for the self-call encoding.
interface IVaultOutflowHost {
    function vaultOutflow(address user, VaultOutflowTypes.Outflow calldata o) external returns (uint256 delivered);
    function vaultGrant(address user, VaultOutflowTypes.Grant calldata g) external;
    function vaultCloseGrant(address user) external returns (uint256 consumed);
}

/**
 * @title  LibVaultOutflow
 * @author Vaipakam Developer Team
 * @notice The typed doors every facet uses to move an asset out of a user
 *         vault (#3205 part 2, `VaultOutflowPolicyDesign.md` §3.2). Each helper
 *         takes only what its class allows: a class whose payee comes from
 *         state (the position holder, the treasury, the backstop, the Diamond)
 *         takes no recipient at all, so a facet cannot name one.
 * @dev    Every helper is one self-call to `VaultOutflowFacet`, the one
 *         policy host; nothing else in the Diamond calls the vault's
 *         `transferOut` / `grantAllowance` (a deploy-sanity test holds it).
 *         Each returns what the recipient received (ERC-20, measured; NFT =
 *         the amount), or the amount when protected mode held the payout.
 */
library LibVaultOutflow {
    uint8 internal constant ERC20 = uint8(VaultOutflowTypes.AssetKind.ERC20);
    uint8 internal constant ERC721 = uint8(VaultOutflowTypes.AssetKind.ERC721);
    uint8 internal constant ERC1155 = uint8(VaultOutflowTypes.AssetKind.ERC1155);

    // ─── Owner ───────────────────────────────────────────────────────────

    /// @notice To `user`'s own wallet.
    function toOwner(address user, uint8 kind, address asset, uint256 tokenId, uint256 amount, uint8 reason)
        internal
        returns (uint256)
    {
        return _go(user, kind, asset, tokenId, amount, user, VaultOutflowTypes.OutflowClass.Owner, 0, 0, reason);
    }

    /// @notice To an address on `user`'s protected-mode allowlist (or its
    ///         controller), as a released payout.
    function toAllowlisted(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address to,
        uint8 reason
    ) internal returns (uint256) {
        return _go(user, kind, asset, tokenId, amount, to, VaultOutflowTypes.OutflowClass.OwnerAllowlisted, 0, 0, reason);
    }

    // ─── Holders (the payee is resolved from the PositionNFT) ────────────

    /// @notice To the vault of whoever holds `positionToken` of loan `loanId`
    ///         now, on `user`'s own side (a release, a claim).
    function toPositionHolder(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        uint256 loanId,
        uint256 positionToken,
        uint8 reason
    ) internal returns (uint256) {
        return _go(
            user, kind, asset, tokenId, amount, address(0), VaultOutflowTypes.OutflowClass.PositionHolder, loanId, positionToken, reason
        );
    }

    /// @notice To the vault of whoever holds `positionToken`, the OTHER side
    ///         of loan `loanId`, now.
    function toCounterparty(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        uint256 loanId,
        uint256 positionToken,
        uint8 reason
    ) internal returns (uint256) {
        return _go(
            user, kind, asset, tokenId, amount, address(0), VaultOutflowTypes.OutflowClass.Counterparty, loanId, positionToken, reason
        );
    }

    /// @notice To the vault of whoever holds `lenderToken`, the lender side of
    ///         ANOTHER loan that loan `loanId` was matched against. The caller
    ///         has checked the match.
    function toMatchedCounterparty(
        address user,
        address asset,
        uint256 amount,
        uint256 loanId,
        uint256 lenderToken,
        uint8 reason
    ) internal returns (uint256) {
        return _go(
            user, ERC20, asset, 0, amount, address(0), VaultOutflowTypes.OutflowClass.MatchedCounterparty, loanId, lenderToken, reason
        );
    }

    /// @notice Into the vault of loan `loanId`'s STORED party on the side
    ///         `sideToken` names (that side's position token), where the share
    ///         waits for its claim. The payee comes from loan state; the
    ///         settlement books the custody (tracked ledger, claim row).
    function toClaimCustody(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        uint256 loanId,
        uint256 sideToken,
        uint8 reason
    ) internal returns (uint256) {
        return _go(
            user, kind, asset, tokenId, amount, address(0), VaultOutflowTypes.OutflowClass.ClaimCustody, loanId, sideToken, reason
        );
    }

    // ─── Configured payees ───────────────────────────────────────────────

    /// @notice To the treasury.
    function toTreasury(address user, address asset, uint256 amount, uint256 ref, uint8 reason) internal returns (uint256) {
        return _go(user, ERC20, asset, 0, amount, address(0), VaultOutflowTypes.OutflowClass.Treasury, ref, 0, reason);
    }

    /// @notice To the backstop vault.
    function toBackstop(address user, uint8 kind, address asset, uint256 tokenId, uint256 amount, uint256 ref, uint8 reason)
        internal
        returns (uint256)
    {
        return _go(user, kind, asset, tokenId, amount, address(0), VaultOutflowTypes.OutflowClass.Backstop, ref, 0, reason);
    }

    /// @notice To the Diamond, within this transaction; `reason` names the
    ///         onward leg.
    function toDiamond(address user, uint8 kind, address asset, uint256 tokenId, uint256 amount, uint256 ref, uint8 reason)
        internal
        returns (uint256)
    {
        return _go(user, kind, asset, tokenId, amount, address(0), VaultOutflowTypes.OutflowClass.DiamondTransient, ref, 0, reason);
    }

    // ─── Actors the caller names ─────────────────────────────────────────

    /// @notice To the actor of this action (a liquidator bonus, a match fee, a
    ///         keeper reward). Bounded by the lien's incentive budget in Stage B.
    function toIncentive(address user, address asset, uint256 amount, address actor, uint256 ref, uint8 reason)
        internal
        returns (uint256)
    {
        return _go(user, ERC20, asset, 0, amount, actor, VaultOutflowTypes.OutflowClass.Incentive, ref, 0, reason);
    }

    /// @notice To the liquidator that paid loan `loanId`'s debt in this same
    ///         transaction: the caller passes `msg.sender` of its entry.
    function toLiquidationBuyer(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address liquidator,
        uint256 loanId,
        uint8 reason
    ) internal returns (uint256) {
        return _go(user, kind, asset, tokenId, amount, liquidator, VaultOutflowTypes.OutflowClass.LiquidationBuyer, loanId, 0, reason);
    }

    /// @notice To a recorded prior seller of loan `loanId`.
    function toSellerClaim(address user, address asset, uint256 amount, address seller, uint256 loanId)
        internal
        returns (uint256)
    {
        return _go(
            user, ERC20, asset, 0, amount, seller, VaultOutflowTypes.OutflowClass.SellerClaim, loanId, 0, OutflowReason.SELLER_CLAIM
        );
    }

    // ─── Just-in-time allowances ─────────────────────────────────────────

    /// @notice Open a just-in-time allowance on `user`'s vault for this
    ///         transaction; close it with {closeGrant} before it ends.
    function grant(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address spender,
        VaultOutflowTypes.GrantClass class_,
        uint256 ref
    ) internal {
        VaultOutflowTypes.Grant memory g = VaultOutflowTypes.Grant({
            kind: VaultOutflowTypes.AssetKind(kind),
            asset: asset,
            tokenId: tokenId,
            amount: amount,
            spender: spender,
            class_: class_,
            ref: ref
        });
        _call(abi.encodeCall(IVaultOutflowHost.vaultGrant, (user, g)));
    }

    /// @notice Close `user`'s vault's open allowance; returns what its spender
    ///         took (0 when none was open).
    function closeGrant(address user) internal returns (uint256) {
        return abi.decode(_call(abi.encodeCall(IVaultOutflowHost.vaultCloseGrant, (user))), (uint256));
    }

    // ─── The one encoding ────────────────────────────────────────────────

    function _go(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address to,
        VaultOutflowTypes.OutflowClass class_,
        uint256 ref,
        uint256 positionToken,
        uint8 reason
    ) private returns (uint256) {
        VaultOutflowTypes.Outflow memory o = VaultOutflowTypes.Outflow({
            kind: VaultOutflowTypes.AssetKind(kind),
            asset: asset,
            tokenId: tokenId,
            amount: amount,
            to: to,
            class_: class_,
            ref: ref,
            positionToken: positionToken,
            reason: reason
        });
        return abi.decode(_call(abi.encodeCall(IVaultOutflowHost.vaultOutflow, (user, o))), (uint256));
    }

    function _call(bytes memory data) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(this).call(data);
        LibRevert.bubbleOnFailureTyped(ok, ret, IVaipakamErrors.VaultWithdrawFailed.selector);
    }
}
