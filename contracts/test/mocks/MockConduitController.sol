// test/mocks/MockConduitController.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IConduitController} from "../../src/seaport/ISeaportOrderHash.sol";

/**
 * @title MockConduitController
 * @notice Minimal Seaport `ConduitController` stand-in for tests.
 *         Stores a (conduitKey → conduit address) mapping that
 *         tests configure explicitly via {register}; the diamond's
 *         `postPrepayListing` resolves the borrower-supplied
 *         `conduitKey` to its deployed address via this view to
 *         bind the (key, address) pair on-chain.
 */
contract MockConduitController is IConduitController {
    struct ConduitEntry {
        address conduit;
        bool exists;
    }

    mapping(bytes32 => ConduitEntry) private _conduits;

    function register(bytes32 conduitKey, address conduit) external {
        _conduits[conduitKey] = ConduitEntry({conduit: conduit, exists: true});
    }

    function getConduit(bytes32 conduitKey)
        external
        view
        override
        returns (address conduit, bool exists)
    {
        ConduitEntry memory entry = _conduits[conduitKey];
        return (entry.conduit, entry.exists);
    }
}
