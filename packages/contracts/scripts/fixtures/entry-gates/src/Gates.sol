// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// Fixture for check-entry-gates.mjs (#3944). Each GFacet entry is one case.

library LibGate {
    struct S {
        uint256 x;
        mapping(address => bool) flagged;
        bool paused;
        uint256[] list;
    }

    function s() internal pure returns (S storage st) {
        assembly {
            st.slot := 0
        }
    }

    function requireNotFlagged(address a) internal view {
        if (s().flagged[a]) revert();
    }

    function requireNotPaused() internal view {
        if (s().paused) revert();
    }
}

abstract contract Guarded {
    uint256 private _lock;

    modifier nonReentrant() {
        require(_lock == 0);
        _lock = 1;
        _;
        _lock = 0;
    }

    modifier whenNotPaused() {
        LibGate.requireNotPaused();
        _;
    }

    modifier onlySelf() {
        require(msg.sender == address(this));
        _;
    }
}

interface IOther {
    function poke() external;

    function pay() external payable;
}

contract HostFacet {
    function requireTerms(address) external view {}

    function mutate() external {}
}

contract GFacet is Guarded {
    IOther internal other;

    function good() external nonReentrant whenNotPaused {
        LibGate.requireNotFlagged(msg.sender);
        LibGate.s().x = 1;
    }

    function writesFirst() external nonReentrant {
        LibGate.s().x = 2;
        LibGate.requireNotFlagged(msg.sender);
    }

    function writesThroughPointer() external nonReentrant {
        LibGate.S storage st = LibGate.s();
        st.list.push(1);
        LibGate.requireNotFlagged(msg.sender);
    }

    function branchOnly(bool b) external nonReentrant {
        if (b) LibGate.requireNotFlagged(msg.sender);
        LibGate.s().x = 3;
    }

    function viaHelper() external nonReentrant {
        _screen();
        LibGate.s().x = 4;
    }

    function noGuard() external {
        LibGate.requireNotFlagged(msg.sender);
        LibGate.s().x = 5;
    }

    function viaHost() external nonReentrant {
        HostFacet(address(this)).requireTerms(msg.sender);
        LibGate.s().x = 6;
    }

    function externalFirst() external nonReentrant {
        other.poke();
        LibGate.requireNotFlagged(msg.sender);
    }

    function externalWithOptionsFirst() external payable nonReentrant {
        other.pay{value: msg.value, gas: 50_000}();
        LibGate.requireNotFlagged(msg.sender);
    }

    function selfMutateFirst() external nonReentrant {
        HostFacet(address(this)).mutate();
        LibGate.requireNotFlagged(msg.sender);
    }

    function internalOnly() external onlySelf {
        LibGate.s().x = 7;
    }

    function peek() external view returns (uint256) {
        return LibGate.s().x;
    }

    function _screen() internal view {
        LibGate.requireNotFlagged(msg.sender);
    }

    function viaHelperEarlyReturn(bool skip) external nonReentrant {
        _screenUnless(skip);
        LibGate.s().x = 8;
    }

    function modifierCallsOut() external pokesFirst {
        LibGate.requireNotFlagged(msg.sender);
        LibGate.s().x = 9;
    }

    function _screenUnless(bool skip) internal view {
        if (skip) return;
        LibGate.requireNotFlagged(msg.sender);
    }

    function viaModifiedHelper() external nonReentrant {
        _screenAfterPoke();
        LibGate.s().x = 10;
    }

    function _screenAfterPoke() internal pokesFirst {
        LibGate.requireNotFlagged(msg.sender);
    }

    function viaPostambleHelper() external nonReentrant {
        _emptyThenPoke();
        LibGate.requireNotFlagged(msg.sender);
        LibGate.s().x = 11;
    }

    function _emptyThenPoke() internal pokesAfter {}

    function viaMaybeHelper() external nonReentrant {
        _screenMaybe();
        LibGate.s().x = 12;
    }

    function _screenMaybe() internal view maybe {
        LibGate.requireNotFlagged(msg.sender);
    }

    function viaPointer() external nonReentrant {
        function() internal fp = _writeX;
        fp();
        LibGate.requireNotFlagged(msg.sender);
    }

    function _writeX() internal {
        LibGate.s().x = 14;
    }

    function deepWriteFirst() external nonReentrant {
        _d1();
        LibGate.requireNotFlagged(msg.sender);
    }

    function _d1() internal { _d2(); }
    function _d2() internal { _d3(); }
    function _d3() internal { _d4(); }
    function _d4() internal { _d5(); }
    function _d5() internal { _d6(); }
    function _d6() internal { _d7(); }
    function _d7() internal { _d8(); }
    function _d8() internal { _d9(); }
    function _d9() internal { _d10(); }
    function _d10() internal { LibGate.s().x = 13; }

    modifier pokesAfter() {
        _;
        other.poke();
    }

    modifier maybe() {
        if (LibGate.s().x == 0) _;
    }

    modifier pokesFirst() {
        other.poke();
        _;
    }
}
