// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRateReader} from "../../interfaces/IRateReader.sol";

/**
 * @title  Erc4626RateReader
 * @author Vaipakam Developer Team
 * @notice The token-rate reader for a vault share that follows ERC-4626
 *         (#3683): the rate is what one whole share converts to through the
 *         vault's own `convertToAssets`. No settings, no owner.
 * @dev    The price guard never takes this rate as it stands: it caps a rise
 *         at the binding's daily bound and distrusts a large fall, so a share
 *         price pushed up in one transaction (a donation to the vault) moves
 *         the collateral value by one day's bound at most.
 */
contract Erc4626RateReader is IRateReader {
    error NotTheUnderlying(address token, address underlying, address asset);

    /// @inheritdoc IRateReader
    function rate(address token, address underlying) external view returns (uint256 rate1e18) {
        address asset = IERC4626(token).asset();
        if (asset != underlying) revert NotTheUnderlying(token, underlying, asset);
        uint256 oneShare = 10 ** uint256(IERC20Metadata(token).decimals());
        uint256 assets = IERC4626(token).convertToAssets(oneShare);
        uint256 oneAsset = 10 ** uint256(IERC20Metadata(asset).decimals());
        rate1e18 = Math.mulDiv(assets, 1e18, oneAsset);
    }
}
