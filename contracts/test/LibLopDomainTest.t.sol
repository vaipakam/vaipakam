// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibLopDomain} from "../src/libraries/LibLopDomain.sol";

/// @dev A LOP stand-in whose ERC-5267 answer each cell sets field by field.
contract ScriptedDomainLop {
    bytes1 public fields = 0x0f;
    string public name_ = "1inch Aggregation Router";
    string public version_ = "6";
    uint256 public chainId;
    address public verifying;
    bytes32 public salt;
    uint256[] public extensions;

    constructor() {
        chainId = block.chainid;
        verifying = address(this);
    }

    function set(bytes1 f, uint256 c, address v, bytes32 s, bool withExtension) external {
        (fields, chainId, verifying, salt) = (f, c, v, s);
        if (withExtension) extensions.push(1);
    }

    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (fields, name_, version_, chainId, verifying, salt, extensions);
    }
}

/// @dev Answers every call with empty return data.
contract SilentFallback {
    fallback() external {}
}

/// @dev Calls the library from outside, so a revert is observable with expectRevert.
contract LibLopDomainCaller {
    function separator(address lop) external view returns (bytes32) {
        return LibLopDomain.separator(lop);
    }
}

/**
 * @title  LibLopDomainTest
 * @notice #2449 -- the Diamond reads a LOP's EIP-712 domain through ERC-5267 `eip712Domain()` and derives
 *         the separator only from the plain four-field domain naming this chain and the LOP itself. Each
 *         refusal rule gets a cell that straddles it: the accepted domain, then the same domain with one
 *         field changed. The fork cell I0g (SwapToRepayIntentFillTest) proves the derivation against the
 *         deployed router.
 */
contract LibLopDomainTest is Test {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    ScriptedDomainLop internal lop;
    LibLopDomainCaller internal caller;

    function setUp() public {
        lop = new ScriptedDomainLop();
        caller = new LibLopDomainCaller();
    }

    function test_theFourFieldOwnDomain_derivesTheEip712Separator() public view {
        assertEq(
            caller.separator(address(lop)),
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH, keccak256("1inch Aggregation Router"), keccak256("6"), block.chainid, address(lop)
                )
            ),
            "the EIP-712 separator over the declared fields"
        );
    }

    function test_aContractWithoutEip712Domain_isRefused() public {
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(caller)));
        caller.separator(address(caller));
    }

    function test_aContractAnsweringWithNoData_isRefused() public {
        SilentFallback silent = new SilentFallback();
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(silent)));
        caller.separator(address(silent));
    }

    function test_anAccountWithNoCode_isRefused() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, eoa));
        caller.separator(eoa);
    }

    function test_anotherFieldSet_isRefused() public {
        lop.set(0x1f, block.chainid, address(lop), bytes32(0), false);
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(lop)));
        caller.separator(address(lop));
    }

    function test_aSalt_isRefused() public {
        lop.set(0x0f, block.chainid, address(lop), bytes32(uint256(1)), false);
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(lop)));
        caller.separator(address(lop));
    }

    function test_extensions_areRefused() public {
        lop.set(0x0f, block.chainid, address(lop), bytes32(0), true);
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(lop)));
        caller.separator(address(lop));
    }

    function test_anotherChain_isRefused() public {
        lop.set(0x0f, block.chainid + 1, address(lop), bytes32(0), false);
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(lop)));
        caller.separator(address(lop));
    }

    function test_anotherVerifyingContract_isRefused() public {
        lop.set(0x0f, block.chainid, makeAddr("elsewhere"), bytes32(0), false);
        vm.expectRevert(abi.encodeWithSelector(LibLopDomain.LopDomainUnsupported.selector, address(lop)));
        caller.separator(address(lop));
    }
}
