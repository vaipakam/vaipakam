// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SetupTest} from "../SetupTest.t.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {BackstopFacet} from "../../src/facets/BackstopFacet.sol";
import {IntentConfigFacet} from "../../src/facets/IntentConfigFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";
import {MockLopFill} from "../mocks/MockLopFill.sol";
import {CustodyHandler, CustodyWiring, CUSTODY_INTENT_CANCEL_GRACE} from "./CustodyHandler.sol";

/**
 * @title  CustodyInvariantBase
 * @notice The Diamond the #2141 custody-attribution suite runs on: SetupTest's FULL production cut
 *         (not InvariantBase's hand-picked twenty facets -- the fallback, backstop, internal-match and
 *         intent paths reach facets that cut does not route), configured in the mainnet topology.
 *
 * @dev    What this adds to `setupHelper()`, and why each one:
 *           - an EXTERNAL treasury (`setTreasury(treasuryEOA)`), because on Diamond-as-treasury every
 *             fee would rest in the Diamond and the attribution identity would need a treasury term
 *             that hides a misrouted slice (mutation 4 of the brief);
 *           - VPFI as a liquid collateral, since VPFI resting in the Diamond is what #1566 is about
 *             (it commingles with the reward pool) -- the canonical token, priced at 1 USD;
 *           - two swap venues, one that always reverts and one that pays, so each liquidation,
 *             default or retry chooses its outcome per call;
 *           - the internal-match kill-switch ON (the explicit match is a fallback consumer);
 *           - a provisioned, seeded backstop for Role-B absorbs (seeded while the Diamond is still
 *             the treasury, which `seedBackstopAbsorb` requires; the treasury balance is consumed to
 *             zero by the seeding, so V0b's zero baseline holds);
 *           - the intent surface with the LOP pinned to {MockLopFill};
 *           - a scriptable sanctions oracle; and five onboarded actors (two lenders, three borrowers).
 *         SetupTest's global HF and LTV mocks stay in place; the handler overrides them per loan.
 */
abstract contract CustodyInvariantBase is SetupTest {
    uint256 internal constant VPFI_HANDLER_STASH = 15_000_000 ether;
    uint256 internal constant ABSORB_SEED_PER_PAIR = 5_000_000 ether;
    uint256 internal constant ABSORB_CAP_PER_PAIR = 1e30;
    uint256 internal constant VENUE_FLOAT = 1e30;

    address internal usdc;
    address internal weth;
    address internal vpfi;
    address internal treasuryEOA;
    address internal backstopVault;
    MockSwapAdapter internal failingAdapter;
    MockSwapAdapter internal workingAdapter;
    uint256 internal failingAdapterIdx;
    uint256 internal workingAdapterIdx;
    MockLopFill internal lopFill;
    MockSanctionsList internal sanctionsList;
    address[2] internal custodyLenders;
    uint256[2] internal custodyLenderPks;
    address[3] internal custodyBorrowers;
    uint256[3] internal custodyBorrowerPks;

    /// @dev Builds the whole harness. The order matters in one place: the backstop is seeded BEFORE
    ///      the treasury moves off the Diamond.
    function _deployCustodyHarness() internal {
        setupHelper();
        usdc = mockERC20;
        weth = mockCollateralERC20;
        treasuryEOA = makeAddr("custodyTreasury");
        _deployCustodyVpfi();
        _deployCustodyVenues();
        _deployCustodyIntentRig();
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        _deployCustodyBackstop();
        AdminFacet(address(diamond)).setTreasury(treasuryEOA);
        sanctionsList = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctionsList));
        _onboardCustodyActors();
    }

    /// @dev The handler, wired to this harness, granted KEEPER_ROLE (the backstop absorb is
    ///      keeper-executed) and handed the VPFI it funds VPFI-collateral borrowers from.
    function _deployCustodyHandler() internal returns (CustodyHandler h) {
        CustodyWiring memory w;
        w.diamond = address(diamond);
        w.usdc = usdc;
        w.weth = weth;
        w.vpfi = vpfi;
        w.lop = address(lopFill);
        w.sanctions = address(sanctionsList);
        w.failingAdapterIdx = failingAdapterIdx;
        w.workingAdapterIdx = workingAdapterIdx;
        w.lenders = custodyLenders;
        w.lenderPks = custodyLenderPks;
        w.borrowers = custodyBorrowers;
        w.borrowerPks = custodyBorrowerPks;
        h = new CustodyHandler(w);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.KEEPER_ROLE, address(h));
        assertTrue(IERC20(vpfi).transfer(address(h), VPFI_HANDLER_STASH), "VPFI stash to the handler");
    }

    /// @dev Every vault owner whose tracked balance V3a checks against its encumbrance.
    function _custodyOwners() internal view returns (address[] memory owners) {
        owners = new address[](6);
        owners[0] = custodyLenders[0];
        owners[1] = custodyLenders[1];
        owners[2] = custodyBorrowers[0];
        owners[3] = custodyBorrowers[1];
        owners[4] = custodyBorrowers[2];
        owners[5] = backstopVault;
    }

    function _custodyTokens() internal view returns (address[3] memory) {
        return [usdc, weth, vpfi];
    }

    function _deployCustodyVpfi() private {
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = address(proxy);
        VPFITokenFacet(address(diamond)).setVPFIToken(vpfi);
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        mockOracleLiquidity(vpfi, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(vpfi, 1e8, 8);
        RiskFacet(address(diamond)).updateRiskParams(vpfi, 8000, 300, 1000);
    }

    function _deployCustodyVenues() private {
        uint256 registered = AdminFacet(address(diamond)).getSwapAdapters().length;
        failingAdapter = new MockSwapAdapter("custody-failing-venue");
        failingAdapter.setShouldRevert(true);
        workingAdapter = new MockSwapAdapter("custody-working-venue");
        AdminFacet(address(diamond)).addSwapAdapter(address(failingAdapter));
        AdminFacet(address(diamond)).addSwapAdapter(address(workingAdapter));
        failingAdapterIdx = registered;
        workingAdapterIdx = registered + 1;
        ERC20Mock(usdc).mint(address(workingAdapter), VENUE_FLOAT);
        ERC20Mock(weth).mint(address(workingAdapter), VENUE_FLOAT);
    }

    function _deployCustodyIntentRig() private {
        lopFill = new MockLopFill(address(0));
        IntentConfigFacet ic = IntentConfigFacet(address(diamond));
        ic.setIntentSwapToRepayEnabled(true);
        ic.setIntentAllowedPrincipalToken(usdc, true);
        ic.setIntentAllowedCollateralToken(weth, true);
        ic.setIntentAllowedCollateralToken(vpfi, true);
        ic.setIntentMinCommitHF(1.2e18);
        ic.setIntentMinOutputBufferBps(200);
        ic.setIntentAuctionSecondsBounds(60, 600);
        ic.setIntentCancelGraceSeconds(CUSTODY_INTENT_CANCEL_GRACE);
        ic.setFusionLimitOrderProtocol(address(lopFill));
    }

    function _deployCustodyBackstop() private {
        BackstopFacet b = BackstopFacet(address(diamond));
        b.initializeBackstopVaultImplementation();
        backstopVault = b.provisionBackstopVault();
        b.setBackstopEnabled(true);
        b.setBackstopAbsorbEnabled(true);
        b.setBackstopAbsorbCap(usdc, weth, ABSORB_CAP_PER_PAIR);
        b.setBackstopAbsorbCap(usdc, vpfi, ABSORB_CAP_PER_PAIR);
        ERC20Mock(usdc).mint(address(diamond), 2 * ABSORB_SEED_PER_PAIR);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(usdc, 2 * ABSORB_SEED_PER_PAIR);
        b.seedBackstopAbsorb(usdc, weth, ABSORB_SEED_PER_PAIR);
        b.seedBackstopAbsorb(usdc, vpfi, ABSORB_SEED_PER_PAIR);
    }

    function _onboardCustodyActors() private {
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        for (uint256 i; i < 2; ++i) {
            (custodyLenders[i], custodyLenderPks[i]) = makeAddrAndKey(string.concat("custodyLender", vm.toString(i)));
            _onboardCustodyActor(custodyLenders[i]);
        }
        for (uint256 i; i < 3; ++i) {
            (custodyBorrowers[i], custodyBorrowerPks[i]) =
                makeAddrAndKey(string.concat("custodyBorrower", vm.toString(i)));
            _onboardCustodyActor(custodyBorrowers[i]);
        }
    }

    function _onboardCustodyActor(address user) private {
        vm.prank(user);
        ProfileFacet(address(diamond)).setUserCountry("US");
        ProfileFacet(address(diamond)).updateKYCTier(user, LibVaipakam.KYCTier.Tier2);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
        address[3] memory tokens = _custodyTokens();
        vm.startPrank(user);
        for (uint256 j; j < 3; ++j) {
            IERC20(tokens[j]).approve(address(diamond), type(uint256).max);
            IERC20(tokens[j]).approve(vault, type(uint256).max);
        }
        vm.stopPrank();
    }
}
