// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {SanctionsRecords} from "../../script/lib/SanctionsRecords.sol";

/// @dev Answers every call with nothing.
contract RecordsSilentTimelock {
    fallback() external {}
}

/// @dev Answers every call with two words, the first one `list`.
contract RecordsWideTimelock {
    address internal immutable list;

    constructor(address list_) {
        list = list_;
    }

    fallback() external {
        address l = list;
        assembly {
            mstore(0, l)
            mstore(32, 1)
            return(0, 64)
        }
    }
}

/// @dev Exposes the library.
contract RecordsHarness {
    function serves(address timelock, address list) external view returns (bool) {
        return SanctionsRecords.serves(timelock, list);
    }
}

/**
 * @title  SanctionsRecordsTest
 * @notice #2443 — the one rule for a chain's recorded sanctions contracts: a
 *         timelock belongs to the list it serves, judged by a read that never
 *         stops the run on a malformed answer.
 */
contract SanctionsRecordsTest is Test {
    function test_ATimelockServesOnlyItsOwnList() public {
        RecordsHarness h = new RecordsHarness();
        address admin = makeAddr("admin");
        SanctionsList list = new SanctionsList(admin, address(0));
        SanctionsList other = new SanctionsList(admin, address(0));
        SanctionsDelistingTimelock tl = new SanctionsDelistingTimelock(admin, list);

        assertTrue(h.serves(address(tl), address(list)));
        assertFalse(h.serves(address(tl), address(other)), "another list");
        assertFalse(h.serves(address(tl), address(0)), "no list recorded");
        assertFalse(h.serves(makeAddr("no code"), address(list)), "no timelock there");
        assertFalse(h.serves(address(new RecordsSilentTimelock()), address(list)), "an empty answer");
        assertFalse(h.serves(address(new RecordsWideTimelock(address(list))), address(list)), "a malformed answer");
        assertFalse(h.serves(address(list), address(list)), "no such function");
    }
}
