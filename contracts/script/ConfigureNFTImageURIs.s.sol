// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureNFTImageURIs
 * @notice Post-deploy URL rotation for the position-NFT artwork +
 *         the OpenSea `external_url` deep-link base. Uses the
 *         status-keyed image scheme on `VaipakamNFTFacet`:
 *         per-side defaults + granular per-`LoanPositionStatus`
 *         overrides + a single base URL for marketplace deep-links.
 *
 *         Idempotent — safe to re-run after a designer ships a new
 *         art pass. Each setter emits an event so indexers can
 *         invalidate any cached `tokenURI` reads.
 *
 * @dev Admin-only on the Diamond (ADMIN_ROLE). Eventually governed
 *      by the Timelock once `ADMIN_ROLE` is rotated to a governance
 *      contract.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY : holds ADMIN_ROLE on the Diamond.
 *
 *      Per-side defaults (always set when populated):
 *        - NFT_DEFAULT_IMAGE_LENDER       (string URI)
 *        - NFT_DEFAULT_IMAGE_BORROWER     (string URI)
 *
 *      Granular per-status overrides (each optional; setter only
 *      fires when the env var is non-empty so unset values stay at
 *      their current on-chain values):
 *        - NFT_IMAGE_LENDER_ACTIVE / _CLOSED / _REPAID / _DEFAULTED
 *          / _LIQUIDATED / _FALLBACK_PENDING / _OFFER_CREATED
 *        - NFT_IMAGE_BORROWER_*  (same suffixes)
 *
 *      External URL base (for OpenSea deep-links):
 *        - NFT_EXTERNAL_URL_BASE  (string; e.g. "https://vaipakam.com")
 *
 *      Reads the Diamond address from `deployments/<chain>/addresses.json`
 *      via `Deployments.readDiamond()` (with `<CHAIN>_DIAMOND_ADDRESS`
 *      env fallback per the standard convention).
 */
contract ConfigureNFTImageURIs is Script {
    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        require(
            diamond != address(0),
            "ConfigureNFTImageURIs: diamond address not found"
        );

        console.log("=== Configure NFT Image URIs ===");
        console.log("Chain id:    ", block.chainid);
        console.log("Diamond:     ", diamond);
        console.log("Admin:       ", vm.addr(adminKey));

        VaipakamNFTFacet nft = VaipakamNFTFacet(diamond);

        vm.startBroadcast(adminKey);

        // Per-side defaults
        string memory lenderDefault =
            vm.envOr("NFT_DEFAULT_IMAGE_LENDER", string(""));
        string memory borrowerDefault =
            vm.envOr("NFT_DEFAULT_IMAGE_BORROWER", string(""));
        if (bytes(lenderDefault).length > 0) {
            nft.setDefaultImage(true, lenderDefault);
            console.log("  default lender image set");
        }
        if (bytes(borrowerDefault).length > 0) {
            nft.setDefaultImage(false, borrowerDefault);
            console.log("  default borrower image set");
        }

        // Granular per-status overrides — order mirrors the
        // `LoanPositionStatus` enum in `LibVaipakam`. Empty env
        // values skip the setter so a partial rotation doesn't
        // overwrite unrelated states.
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.OfferCreated, true,
            vm.envOr("NFT_IMAGE_LENDER_OFFER_CREATED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.OfferCreated, false,
            vm.envOr("NFT_IMAGE_BORROWER_OFFER_CREATED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanInitiated, true,
            vm.envOr("NFT_IMAGE_LENDER_ACTIVE", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanInitiated, false,
            vm.envOr("NFT_IMAGE_BORROWER_ACTIVE", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanRepaid, true,
            vm.envOr("NFT_IMAGE_LENDER_REPAID", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanRepaid, false,
            vm.envOr("NFT_IMAGE_BORROWER_REPAID", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanDefaulted, true,
            vm.envOr("NFT_IMAGE_LENDER_DEFAULTED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanDefaulted, false,
            vm.envOr("NFT_IMAGE_BORROWER_DEFAULTED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanLiquidated, true,
            vm.envOr("NFT_IMAGE_LENDER_LIQUIDATED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanLiquidated, false,
            vm.envOr("NFT_IMAGE_BORROWER_LIQUIDATED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanClosed, true,
            vm.envOr("NFT_IMAGE_LENDER_CLOSED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanClosed, false,
            vm.envOr("NFT_IMAGE_BORROWER_CLOSED", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanFallbackPending, true,
            vm.envOr("NFT_IMAGE_LENDER_FALLBACK_PENDING", string("")));
        _maybeSet(nft, LibVaipakam.LoanPositionStatus.LoanFallbackPending, false,
            vm.envOr("NFT_IMAGE_BORROWER_FALLBACK_PENDING", string("")));

        // OpenSea external_url base (deep-link from marketplace to dApp).
        string memory externalBase =
            vm.envOr("NFT_EXTERNAL_URL_BASE", string(""));
        if (bytes(externalBase).length > 0) {
            nft.setExternalUrlBase(externalBase);
            console.log("  external_url base set");
        }

        // Collection-level image (optional override; falls back to the
        // lender default in `contractURI` when unset).
        string memory contractImage =
            vm.envOr("NFT_CONTRACT_IMAGE", string(""));
        if (bytes(contractImage).length > 0) {
            nft.setContractImageURI(contractImage);
            console.log("  contract image set");
        }

        vm.stopBroadcast();
        console.log("Done.");
    }

    function _maybeSet(
        VaipakamNFTFacet nft,
        LibVaipakam.LoanPositionStatus status,
        bool isLender,
        string memory uri
    ) internal {
        if (bytes(uri).length == 0) return;
        nft.setImageURIForStatus(status, isLender, uri);
        console.log(
            isLender ? "  L" : "  B",
            uint256(status),
            uri
        );
    }
}
