// src/libraries/LibCompliance.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ProfileFacet} from "../facets/ProfileFacet.sol";
import {NumeraireValueFacet} from "../facets/NumeraireValueFacet.sol";

/// @title LibCompliance
/// @notice Shared country-sanctions + KYC gating and numeraire-quoted
///         valuation helpers, used by facets that change loan counterparties
///         mid-life (PrecloseFacet, EarlyWithdrawalFacet).
/// @dev Calls execute against the diamond via `address diamond`, so cross-facet
///      routing goes through the EIP-2535 fallback just like direct facet code.
///      Values come from `NumeraireValueFacet` (#2419), which prices through
///      `OracleFacet.getAssetPrice`: numeraire-quoted truth (USD by
///      post-deploy default; whatever governance has rotated to otherwise),
///      see Numeraire generalization (b1).
library LibCompliance {
    function enforceCountryAndKyc(
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

    /// @notice Numeraire value, 1e18-scaled, of a principal and a collateral
    ///         amount, counting liquid legs only — the figure the KYC tiers
    ///         are compared against.
    /// @dev    #2419 — each leg goes through the one shared valuation rule
    ///         ({NumeraireValueFacet.getLiquidNumeraireValue}): an illiquid
    ///         leg is worth 0 (an asset with no price, a zero price or an
    ///         unreadable `decimals()` is not classified liquid), and a
    ///         liquid one is valued at full precision and rounded down.
    function calculateValueNumeraire(
        address diamond,
        address principalAsset,
        uint256 principalAmount,
        address collateralAsset,
        uint256 collateralAmount
    ) internal view returns (uint256 valueNumeraire) {
        valueNumeraire =
            NumeraireValueFacet(diamond).getLiquidNumeraireValue(principalAsset, principalAmount) +
            NumeraireValueFacet(diamond).getLiquidNumeraireValue(collateralAsset, collateralAmount);
    }
}
