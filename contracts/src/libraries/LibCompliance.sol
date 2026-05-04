// src/libraries/LibCompliance.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProfileFacet} from "../facets/ProfileFacet.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/// @title LibCompliance
/// @notice Shared country-sanctions + KYC gating and numeraire-quoted
///         valuation helpers, used by facets that change loan counterparties
///         mid-life (PrecloseFacet, EarlyWithdrawalFacet).
/// @dev Calls execute against the diamond via `address diamond`, so cross-facet
///      routing goes through the EIP-2535 fallback just like direct facet code.
///      Prices come from `OracleFacet.getAssetPrice` which returns
///      numeraire-quoted truth (USD by post-deploy default; whatever
///      governance has rotated to otherwise) — see Numeraire generalization (B1).
library LibCompliance {
    function enforceCountryAndKYC(
        address diamond,
        address newParty,
        address existingParty,
        address principalAsset,
        uint256 principalAmount,
        address collateralAsset,
        uint256 collateralAmount
    ) internal view {
        string memory newCountry = ProfileFacet(diamond).getUserCountry(newParty);
        string memory existingCountry = ProfileFacet(diamond).getUserCountry(existingParty);
        if (
            keccak256(abi.encodePacked(newCountry)) !=
            keccak256(abi.encodePacked(existingCountry))
        ) {
            if (!LibVaipakam.canTradeBetween(newCountry, existingCountry)) {
                revert IVaipakamErrors.CountriesNotCompatible();
            }
        }

        uint256 valueNumeraire = calculateValueNumeraire(
            diamond,
            principalAsset,
            principalAmount,
            collateralAsset,
            collateralAmount
        );
        if (
            !ProfileFacet(diamond).meetsKYCRequirement(newParty, valueNumeraire) ||
            !ProfileFacet(diamond).meetsKYCRequirement(existingParty, valueNumeraire)
        ) {
            revert IVaipakamErrors.KYCRequired();
        }
    }

    function calculateValueNumeraire(
        address diamond,
        address principalAsset,
        uint256 principalAmount,
        address collateralAsset,
        uint256 collateralAmount
    ) internal view returns (uint256 valueNumeraire) {
        if (
            OracleFacet(diamond).checkLiquidity(principalAsset) ==
            LibVaipakam.LiquidityStatus.Liquid
        ) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(diamond).getAssetPrice(principalAsset);
            uint8 tokenDecimals = IERC20Metadata(principalAsset).decimals();
            valueNumeraire +=
                (principalAmount * price * 1e18) /
                (10 ** feedDecimals) /
                (10 ** tokenDecimals);
        }
        if (
            OracleFacet(diamond).checkLiquidity(collateralAsset) ==
            LibVaipakam.LiquidityStatus.Liquid
        ) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(diamond).getAssetPrice(collateralAsset);
            uint8 tokenDecimals = IERC20Metadata(collateralAsset).decimals();
            valueNumeraire +=
                (collateralAmount * price * 1e18) /
                (10 ** feedDecimals) /
                (10 ** tokenDecimals);
        }
    }
}
