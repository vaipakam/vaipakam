// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// Fixture for contracts/script/refactor-reports.mjs (#3914). Each function is
// one case a report must list, or one it must not. Never deployed.

interface IExt {
    function f() external;
}

library LibErr {
    error Bad();
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
    uint256 internal readByModifierArg;
    IExt internal ext;

    // ─── silent-functions ────────────────────────────────────────────────
    function emitsThroughLibrary() external {
        readByEntry = 1;
        LibLoud.did();
    }

    modifier atMost(uint256 limit) {
        _;
    }

    function readsInModifierArg() external atMost(readByModifierArg) {
        readByModifierArg = 4;
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

    function compoundSwallows() external {
        (bool ok, bytes memory ret) = address(ext).call("");
        if (!ok || ret.length < 32) return;
        emit Skipped();
    }

    function compoundChecked() external {
        (bool ok, bytes memory ret) = address(ext).call("");
        if (!(ok && ret.length >= 32)) revert Failed();
    }

    function successReturnsThenReverts() external {
        (bool ok, ) = address(ext).call("");
        if (ok) return;
        revert Failed();
    }

    function successReturnsThenSwallows() external {
        (bool ok, ) = address(ext).call("");
        if (ok) return;
        neverRead = 9;
    }

    // ─── ambiguous-errors ────────────────────────────────────────────────
    function twoSites(uint256 a) external {
        if (a == 1) revert Bad();
        if (a == 2) revert Bad();
        emit Skipped();
    }

    function twoDeclarations(uint256 a) external {
        if (a == 1) revert Bad();
        if (a == 2) revert LibErr.Bad();
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

// ─── reach: dispatch lineage and modifier arguments ────────────────────────
abstract contract DispatchBase {
    function hook() internal virtual;

    function common() internal {
        hook();
    }
}

contract LeftFacet is DispatchBase {
    error LeftHook();

    function hook() internal pure override {
        revert LeftHook();
    }

    function left() external {
        common();
    }
}

contract RightFacet is DispatchBase {
    error RightHook();

    function hook() internal pure override {
        revert RightHook();
    }

    function right() external {
        common();
    }
}

library LibArg {
    error Prepared();

    function prepare() internal pure returns (uint256) {
        revert Prepared();
    }
}

contract EntryFacet {
    modifier guard(uint256 x) {
        _;
    }

    function go() external {
        LeftFacet(address(this)).left();
        RightFacet(address(this)).right();
    }

    function guarded() external guard(LibArg.prepare()) {}
}

// A standalone contract: its self-calls land in its own code, never in a facet.
contract Standalone {
    event Pinged();

    function run() external {
        this.ping();
    }

    function ping() public {
        emit Pinged();
    }

    function shadow() external {
        this.loud();
    }

    function loud() public {}
}
