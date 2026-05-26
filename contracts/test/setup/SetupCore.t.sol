// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {TestBase} from "./TestBase.t.sol";
import {HelperTest} from "../HelperTest.sol";

import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

// 8 universal facets — every test needs the diamond surface itself plus the
// access-control and admin gates that nearly all flows transit. Excluded
// deliberately: domain facets (Offer / Loan / Risk / Rewards / Metrics /
// Treasury / Config / Legal / etc.) — those live in family-specific mixins.
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";

import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";

/// @title SetupCore — Diamond + 8 always-needed facets.
/// @notice The narrowest base any clean-room test should inherit. Provides
///         a routed Diamond with: cut/loupe/ownership/access-control/admin
///         (the standard EIP-2535 + auth surface), plus Profile (sanctions
///         + KYC), Oracle (price + liquidity reads), and VaultFactory
///         (per-user proxy vaults — every loan touches one).
///
/// @dev Compile cost vs the old `SetupTest`:
///        - 8 facet TYPE imports instead of 39  → ~80 % fewer type
///          references in the inheriting test contract's IR.
///        - Single small `diamondCut(cuts[8])` instead of `diamondCut(cuts[38])`.
///        - No mock token / Zero-Ex / NFT deployment. Domain bases
///          (`SetupOffers`, `SetupLoans`, ...) bring those in when needed.
///        - No KYC / risk-param / oracle-price mocking. Same rationale.
///
///        Inheriting bases (SetupOffers / SetupLoans / SetupConfig / ...)
///        each call `super.setUp()` to run this Diamond bootstrap, then
///        deploy + cut their own facets via an additional `diamondCut` call.
///        The Diamond accepts cuts in sequence — no coordination needed.
abstract contract SetupCore is TestBase {
    // ─── Diamond + impl ──────────────────────────────────────────────────
    VaipakamDiamond internal diamond;
    VaipakamVaultImplementation internal vaultImpl;

    // ─── Core facets ─────────────────────────────────────────────────────
    DiamondCutFacet internal cutFacet;
    DiamondLoupeFacet internal diamondLoupeFacet;
    OwnershipFacet internal ownershipFacet;
    AccessControlFacet internal accessControlFacet;
    AdminFacet internal adminFacet;
    ProfileFacet internal profileFacet;
    OracleFacet internal oracleFacet;
    VaultFactoryFacet internal vaultFacet;

    // ─── Selector helper ─────────────────────────────────────────────────
    /// @dev Shared with the rest of the slim-base chain; kept as a contract
    ///      instance for parity with the old `SetupTest` during the staged
    ///      migration. A planned follow-up (Stage 0a) will convert
    ///      `HelperTest` into a stateless `internal pure` library so this
    ///      instance disappears.
    HelperTest internal helperTest;

    // ─── setUp ────────────────────────────────────────────────────────────
    function setUp() public virtual override {
        super.setUp(); // TestBase: owner / lender / borrower

        helperTest = new HelperTest();
        vaultImpl = new VaipakamVaultImplementation();

        // 1. Deploy the cut facet + diamond.
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        // 2. Deploy the 7 remaining core facets.
        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        accessControlFacet = new AccessControlFacet();
        adminFacet = new AdminFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        vaultFacet = new VaultFactoryFacet();

        // 3. Cut the 7 core facets in a single diamondCut.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDiamondLoupeFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOwnershipFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(profileFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getProfileFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(vaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultFactoryFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // 4. Initialize the AccessControl roles. `owner` (this contract)
        //    receives every privileged role — ADMIN_ROLE, GUARDIAN_ROLE,
        //    KEEPER_ROLE, etc. — so test pranks land cleanly.
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }
}
