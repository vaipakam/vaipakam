// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";

/**
 * @title DeployAdminGuardTest
 * @notice #947: `DeployDiamond` Step 6 hands every role and the Diamond's
 *         ownership to the admin and then renounces everything from the
 *         deployer, so a bad admin address bricks the new Diamond. The admin
 *         is now checked before anything is deployed.
 */
contract DeployAdminGuardTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    uint256 internal constant ADMIN_KEY = 2;
    address internal constant TREASURY = address(0xBEEF);

    DeployDiamond internal script;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        script = new DeployDiamond();
    }

    function test_RefusesZeroAdmin() public {
        vm.expectRevert(bytes("DeployDiamond: admin is the zero address - every role and the ownership would be lost"));
        script.runWith(address(0), TREASURY, DEPLOYER_KEY);
        assertEq(script.diamond(), address(0), "nothing was deployed");
    }

    function test_Production_RefusesAdminEqualToDeployer() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("DeployDiamond: on a production chain the admin must not be the deployer key"));
        script.runWith(vm.addr(DEPLOYER_KEY), TREASURY, DEPLOYER_KEY);
    }

    /// @dev The single-key topology local and CI rigs use stays available
    ///      off production.
    function test_Local_AllowsAdminEqualToDeployer() public {
        script.runWith(vm.addr(DEPLOYER_KEY), TREASURY, DEPLOYER_KEY);
        assertTrue(script.diamond() != address(0));
    }

    function test_AdminMustBeTheSuppliedKeysAddress() public {
        script.requireAdminIsKey(vm.addr(ADMIN_KEY), ADMIN_KEY);
        script.requireAdminIsKey(address(0x1234), 0); // no key supplied: nothing to compare
        vm.expectRevert(
            bytes(
                "DeployDiamond: ADMIN_ADDRESS is not the address of ADMIN_PRIVATE_KEY - fix the typo before every role is handed to it"
            )
        );
        script.requireAdminIsKey(address(0x1234), ADMIN_KEY);
    }
}
