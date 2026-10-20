// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// Test fixture for packages/contracts/scripts/storage-layout-guard.test.mjs.
// Never compiled by forge (it lives outside contracts/). `regen.mjs` compiles
// it with solc and writes the AST the tests read. Each function below is one
// storage-pointer shape the guard must resolve, or must refuse.

library LibFixture {
    enum Status {
        Active,
        Repaid
    }

    type Amount is uint128;

    struct S {
        uint256 x;
        Status status;
        Amount amount;
    }

    struct Other {
        uint256 y;
    }

    // keccak256(abi.encode(uint256(keccak256("fixture.a")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant A_POS = 0x6c0fc4eb97ad2ad54835c8e61eb284ebc77eb0f99a7f7da4c40a90342f2e9000;
    // keccak256(abi.encode(uint256(keccak256("fixture.a")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant WRONG_POS = 0x6c0fc4eb97ad2ad54835c8e61eb284ebc77eb0f99a7f7da4c40a90342f2e9100;
    bytes32 internal constant B_POS = keccak256("fixture.b");
    bytes32 internal constant C_POS = keccak256(abi.encode(uint256(keccak256("fixture.c")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 internal constant D_POS = C_POS;

    function direct() internal pure returns (S storage s) {
        assembly {
            s.slot := A_POS
        }
    }

    function viaLocal() internal pure returns (S storage s) {
        bytes32 p = B_POS;
        assembly {
            s.slot := p
        }
    }

    function viaConstantAlias() internal pure returns (S storage s) {
        bytes32 p = D_POS;
        assembly {
            s.slot := p
        }
    }

    function otherView() internal pure returns (Other storage o) {
        assembly {
            o.slot := A_POS
        }
    }

    function fromParameter(bytes32 p) internal pure returns (S storage s) {
        assembly {
            s.slot := p
        }
    }

    function computed(uint256 k) internal pure returns (S storage s) {
        bytes32 p = keccak256(abi.encode(k));
        assembly {
            s.slot := p
        }
    }

    function reassigned() internal pure returns (S storage s) {
        bytes32 p = A_POS;
        p = B_POS;
        assembly {
            s.slot := p
        }
    }

    function deleted() internal pure returns (S storage s) {
        bytes32 p = A_POS;
        delete p;
        assembly {
            s.slot := p
        }
    }

    function tupleAssigned() internal pure returns (S storage s) {
        bytes32 p = A_POS;
        bytes32 q;
        (p, q) = (B_POS, A_POS);
        assembly {
            s.slot := p
        }
    }

    function yulAssigned() internal pure returns (S storage s) {
        bytes32 p = A_POS;
        assembly {
            p := 1
            s.slot := p
        }
    }

    function fromStorageParameter(Other storage o) internal pure returns (S storage s) {
        assembly {
            s.slot := o.slot
        }
    }

    function readOnly() internal pure returns (bytes32 slot) {
        S storage s = direct();
        assembly {
            slot := s.slot
        }
    }
}

abstract contract VirtualPosition {
    struct V {
        uint256 v;
    }

    bytes32 private constant V_POS = keccak256("fixture.v");

    function _vPosition() internal pure virtual returns (bytes32) {
        return V_POS;
    }

    function _v() internal pure returns (V storage $) {
        bytes32 slot = _vPosition();
        assembly {
            $.slot := slot
        }
    }
}
