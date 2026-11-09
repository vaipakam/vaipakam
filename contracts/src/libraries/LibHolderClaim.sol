// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibSwap} from "./LibSwap.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/// @dev The Diamond surface a contract position holder needs to claim and
///      receive its proceeds.
interface IHolderClaimDiamond {
    function getLoanDetails(uint256 loanId) external view returns (LibVaipakam.Loan memory);
    function claimAsLenderWithRetry(uint256 loanId, LibSwap.AdapterCall[] calldata retryCalls) external;
    function getDepositoryHolding(address user, address asset, uint256 tokenId) external view returns (uint256);
    function withdrawFromVault(
        address account,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external returns (uint256 queuedId);
}

/**
 * @title  LibHolderClaim
 * @author Vaipakam Developer Team
 * @notice THE way a contract that holds a lender position (the backstop vault,
 *         an aggregator adapter) claims and receives the proceeds in the same
 *         transaction (#3205 part 2, Codex #3387 r2). A claim pays the holder's
 *         Vaipakam VAULT as free money; this library snapshots the holder's
 *         depository credit for the loan's principal and collateral, claims,
 *         withdraws exactly what the claim credited (ERC-20, or the collateral
 *         in kind: ERC-721 / ERC-1155) to the holder contract through its own
 *         withdrawal, and returns the amounts measured at the holder. A holder
 *         contract never measures its own balance around a claim alone.
 * @dev    Called from the holder contract's own code (`address(this)` is the
 *         holder and the vault's owner). The withdrawal is the owner's own, to
 *         its own address, so it passes the own-wallet rule.
 */
library LibHolderClaim {
    struct Recovered {
        address principalAsset;
        uint256 principal;
        address collateralAsset;
        uint8 collateralKind;
        uint256 collateralTokenId;
        uint256 collateral;
    }

    function claimAsLender(address diamond, uint256 loanId, LibSwap.AdapterCall[] calldata retryCalls)
        internal
        returns (Recovered memory r)
    {
        IHolderClaimDiamond d = IHolderClaimDiamond(diamond);
        LibVaipakam.Loan memory loan = d.getLoanDetails(loanId);
        r.principalAsset = loan.principalAsset;
        r.collateralAsset = loan.collateralAsset;
        r.collateralKind = uint8(loan.collateralAssetType);
        r.collateralTokenId = r.collateralKind == uint8(LibVaipakam.AssetType.ERC20) ? 0 : loan.collateralTokenId;
        bool distinct = r.collateralAsset != r.principalAsset || r.collateralTokenId != 0;

        uint256 p0 = d.getDepositoryHolding(address(this), r.principalAsset, 0);
        uint256 c0 = distinct ? d.getDepositoryHolding(address(this), r.collateralAsset, r.collateralTokenId) : 0;
        uint256 pBal0 = IERC20(r.principalAsset).balanceOf(address(this));
        uint256 cBal0 = _held(r, address(this));

        d.claimAsLenderWithRetry(loanId, retryCalls);

        _withdrawCredit(d, uint8(LibVaipakam.AssetType.ERC20), r.principalAsset, 0, p0);
        if (distinct) _withdrawCredit(d, r.collateralKind, r.collateralAsset, r.collateralTokenId, c0);

        r.principal = IERC20(r.principalAsset).balanceOf(address(this)) - pBal0;
        if (distinct) r.collateral = _held(r, address(this)) - cBal0;
    }

    /// @dev Withdraw to this contract what the claim credited to its vault for
    ///      `asset` / `tokenId` (the rise above `before`).
    function _withdrawCredit(IHolderClaimDiamond d, uint8 kind, address asset, uint256 tokenId, uint256 before)
        private
    {
        uint256 nowHeld = d.getDepositoryHolding(address(this), asset, tokenId);
        if (nowHeld > before) d.withdrawFromVault(address(this), kind, asset, tokenId, nowHeld - before, address(this));
    }

    /// @dev The holder's balance of the collateral (ERC-20 units, or 1/0 for an
    ///      ERC-721, or ERC-1155 units).
    function _held(Recovered memory r, address who) private view returns (uint256) {
        if (r.collateralKind == uint8(LibVaipakam.AssetType.ERC20)) return IERC20(r.collateralAsset).balanceOf(who);
        if (r.collateralKind == uint8(LibVaipakam.AssetType.ERC721)) {
            (bool ok, bytes memory out) =
                r.collateralAsset.staticcall(abi.encodeWithSignature("ownerOf(uint256)", r.collateralTokenId));
            return ok && out.length == 32 && abi.decode(out, (address)) == who ? 1 : 0;
        }
        (bool ok1155, bytes memory o1155) = r.collateralAsset.staticcall(
            abi.encodeWithSignature("balanceOf(address,uint256)", who, r.collateralTokenId)
        );
        return ok1155 && o1155.length == 32 ? abi.decode(o1155, (uint256)) : 0;
    }
}
