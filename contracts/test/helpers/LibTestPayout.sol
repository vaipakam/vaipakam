// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/// @title  LibTestPayout
/// @notice #3205 part 2 — claims, the lender share of an open loan's
///         repayment and new principal are paid into the payee's VAULT as
///         free money; the payee then withdraws it to their own wallet, as
///         the app does. A scenario that asserts what a wallet ended with
///         calls {withdrawAllFree} where the user would withdraw.
library LibTestPayout {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Withdraw every ERC-20 balance withdrawable now from to `user`'s vault
    ///         to `user`'s own wallet. Returns how many assets it withdrew.
    function withdrawAllFree(address diamond, address user) internal returns (uint256 n) {
        VaultDepositoryFacet depo = VaultDepositoryFacet(diamond);
        (address[] memory assets,) = depo.getDepositoryAssets(user, 0, 64);
        for (uint256 i; i < assets.length; ++i) {
            // What may leave now: the depository credit, less anything a lien
            // or an earmark (an extension reserve, say) still holds.
            uint256 h = depo.withdrawableNow(user, uint8(LibVaipakam.AssetType.ERC20), assets[i], 0);
            if (h == 0) continue;
            VM.prank(user);
            depo.withdrawFromVault(user, uint8(LibVaipakam.AssetType.ERC20), assets[i], 0, h, user);
            ++n;
        }
    }
}
