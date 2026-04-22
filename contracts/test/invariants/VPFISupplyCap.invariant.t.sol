// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title VPFISupplyCapInvariant
 * @notice VPFI's 230 M hard cap is the single most important guarantee in
 *         Phase 1 tokenomics: every mirror token that can exist across the
 *         LayerZero peer mesh is backed by VPFI locked on the canonical
 *         chain. If the canonical `totalSupply()` ever drifts above
 *         `TOTAL_SUPPLY_CAP`, the global accounting of the mesh is broken
 *         and any mirror chain can be minted into insolvency.
 *
 *         ERC20CappedUpgradeable enforces the cap on `_update`, so the
 *         assertion here is a regression guard: if a future Diamond-side
 *         change introduced a path that bypassed `mint(...)` — a direct
 *         `_mint` in a new facet, storage aliasing, a compromised `setMinter`
 *         rotation — we would see total supply climb past the cap. The fuzz
 *         loop tries hard to trip it: it sprays mint requests across three
 *         recipients with amounts drawn from a wide range, deliberately
 *         including values that would punch through the cap on their own.
 *
 *         This suite does NOT reuse `InvariantBase` — that base omits
 *         TreasuryFacet and VPFITokenFacet and doesn't wire the token
 *         proxy. We stand up a minimal diamond with only the facets this
 *         invariant needs.
 */
contract VPFISupplyCapInvariant is Test {
    VaipakamDiamond public diamond;
    VPFIToken public token;
    VPFIHandler public handler;

    address internal constant TOKEN_OWNER = address(0xA11CE);
    address internal constant INITIAL_RECIPIENT = address(0xCAFE);

    function setUp() public {
        address owner = address(this);

        // ── Minimal diamond ──────────────────────────────────────────────
        DiamondCutFacet cut = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cut));

        AccessControlFacet ac = new AccessControlFacet();
        AdminFacet admin = new AdminFacet();
        VPFITokenFacet vpfiFacet = new VPFITokenFacet();
        TreasuryFacet treasury = new TreasuryFacet();
        HelperTest helper = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(ac),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(admin),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getVPFITokenFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(treasury),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getTreasuryFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).setTreasury(address(diamond));

        // ── VPFI token proxy ────────────────────────────────────────────
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (TOKEN_OWNER, INITIAL_RECIPIENT, TOKEN_OWNER)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = VPFIToken(address(proxy));

        // Register the token + mark this diamond as canonical + rotate the
        // minter to the diamond so TreasuryFacet.mintVPFI has authority.
        VPFITokenFacet(address(diamond)).setVPFIToken(address(token));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        vm.prank(TOKEN_OWNER);
        token.setMinter(address(diamond));

        // Grant the handler ADMIN_ROLE so mintVPFI (ADMIN_ROLE-gated) calls
        // land without pranks interfering with the invariant runner.
        handler = new VPFIHandler(address(diamond), address(token));
        AccessControlFacet(address(diamond)).grantRole(
            LibAccessControl.ADMIN_ROLE,
            address(handler)
        );

        targetContract(address(handler));
    }

    /// @notice The canonical-chain ledger never over-issues VPFI. Every
    ///         mint routes through TreasuryFacet.mintVPFI → VPFIToken.mint →
    ///         ERC20CappedUpgradeable._update, so supply must stay at or
    ///         below the 230 M hard cap regardless of how many mint calls
    ///         the fuzzer sprays.
    function invariant_TotalSupplyBelowCap() public view {
        uint256 cap = token.TOTAL_SUPPLY_CAP();
        uint256 supply = token.totalSupply();
        assertLe(supply, cap, "VPFI totalSupply exceeded hard cap");
    }

    /// @notice Sanity: the initial mint was 23 M and minted at setup. If any
    ///         codepath somehow *burned past* the initial balance (no burn
    ///         surface exists, but this guards against a regression), total
    ///         supply would drop below the floor we observed at setUp(),
    ///         signaling a storage or accounting bug.
    function invariant_TotalSupplyAtLeastInitial() public view {
        assertGe(
            token.totalSupply(),
            token.INITIAL_MINT(),
            "VPFI totalSupply dropped below initial mint"
        );
    }
}

/**
 * @dev Dedicated handler for the VPFI cap invariant. Exposes a single
 *      `mintVPFI` action that bounds `amount` to a wide range (including
 *      values far larger than the remaining headroom) so the fuzzer has a
 *      realistic shot at tripping the cap if a bypass ever exists.
 */
contract VPFIHandler is Test {
    address public diamond;
    VPFIToken public token;

    address[3] public recipients;

    uint256 public mintSuccesses;
    uint256 public mintCapRejections;

    constructor(address _diamond, address _token) {
        diamond = _diamond;
        token = VPFIToken(_token);
        recipients[0] = makeAddr("recipient0");
        recipients[1] = makeAddr("recipient1");
        recipients[2] = makeAddr("recipient2");
    }

    /// @notice Request a mint into one of three recipients with a bounded
    ///         amount. The upper bound is deliberately larger than the cap
    ///         headroom so the fuzz sequence will routinely ask for values
    ///         the token must reject; the invariant then asserts that those
    ///         rejections actually happened (supply stayed in range).
    function mintVPFI(uint256 recipientSeed, uint256 amount) external {
        address to = recipients[recipientSeed % 3];

        // Range chosen so we get a mix of small mints (comfortably under
        // headroom), mid-sized mints that chew through headroom, and the
        // occasional over-cap request that the token must reject.
        amount = bound(amount, 1 ether, 50_000_000 ether);

        try TreasuryFacet(diamond).mintVPFI(to, amount) {
            mintSuccesses++;
        } catch {
            mintCapRejections++;
        }
    }
}
