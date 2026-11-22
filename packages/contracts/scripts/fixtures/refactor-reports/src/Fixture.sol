// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// Fixture for contracts/script/refactor-reports.mjs (#3914). Each function is
// one case a report must list, or one it must not. Never deployed.

interface IExt {
    function f() external;
}

library LibLoud {
    /// @custom:event-category state-change/loan-mutation
    event Did(uint256 x);

    function did() internal {
        emit Did(1);
    }
}

contract BFacet {
    /// @custom:event-category state-change/offer-mutation
    event Loud();

    function loud() external {
        emit Loud();
    }
}

contract AFacet {
    error Bad();
    error Failed();

    /// @custom:event-category informational/admin
    event Skipped();

    /// no tag here
    event Untagged();

    /// @custom:event-category state-change/not-a-leaf
    event Unknown();

    bytes4 internal constant LOUD_SELECTOR = bytes4(keccak256("loud()"));
    bytes4 internal constant LOUD_BY_MEMBER = BFacet.loud.selector;

    uint256 internal neverRead;
    uint256 internal readByEntry;
    uint256 internal readOnlyInView;
    uint256 public publicOnly;
    IExt internal ext;

    // ─── silent-functions ────────────────────────────────────────────────
    function emitsThroughLibrary() external {
        readByEntry = 1;
        LibLoud.did();
    }

    function silentWrite() external {
        neverRead = readByEntry;
        readOnlyInView = 2;
        publicOnly = 3;
    }

    function viaSelectorMember() external {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeWithSelector(BFacet.loud.selector));
        if (!ok) _bubble(ret);
    }

    function viaKeccakConstant() external {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeWithSelector(LOUD_SELECTOR));
        if (!ok) _bubble(ret);
    }

    function viaMemberConstant() external {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeWithSelector(LOUD_BY_MEMBER));
        if (!ok) _bubble(ret);
    }

    function viaSignature() external {
        (bool ok, bytes memory ret) = address(this).call(abi.encodeWithSignature("loud()"));
        if (!ok) _bubble(ret);
    }

    function viaUnnamed(bytes4 sel) external {
        (bool ok, bytes memory ret) = address(this).call(abi.encodePacked(sel, uint256(1)));
        if (!ok) _bubble(ret);
    }

    function viaParameterHelper() external {
        _forward(abi.encodeWithSelector(BFacet.loud.selector));
    }

    function readsInView() external view returns (uint256) {
        return readOnlyInView;
    }

    // ─── swallowed-failures ──────────────────────────────────────────────
    function catchSwallows() external {
        try ext.f() {} catch {}
        emit Skipped();
    }

    function catchReverts() external {
        try ext.f() {} catch {
            revert Failed();
        }
    }

    function catchEmits() external {
        try ext.f() {} catch {
            emit Skipped();
        }
    }

    function flagNeverRead() external {
        (bool ok, ) = address(ext).call("");
        emit Skipped();
    }

    function flagChecked() external {
        (bool ok, ) = address(ext).call("");
        if (!ok) revert Failed();
    }

    // ─── ambiguous-errors ────────────────────────────────────────────────
    function twoSites(uint256 a) external {
        if (a == 1) revert Bad();
        if (a == 2) revert Bad();
        emit Skipped();
    }

    function oneSite(uint256 a) external {
        if (a == 1) revert Bad();
        emit Skipped();
    }

    function textRevert() external pure {
        revert("no");
    }

    function _forward(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) _bubble(ret);
    }

    function _bubble(bytes memory ret) internal pure {
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
