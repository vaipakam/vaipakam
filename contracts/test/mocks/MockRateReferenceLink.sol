// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateReference} from "../../src/interfaces/IRateReference.sol";

/// @title  MockRateReferenceLink
/// @notice Test stand-in for the rate reference, answering only the reads the
///         Diamond's rate-link host makes (`linkedRate`, `band`,
///         `newestSeries`) with set figures, so the Diamond's wiring is tested
///         apart from the reference's own arithmetic (`RateReferenceTest`).
/// @dev    The band follows the reference's default rule: outside when the
///         rate is above 1.5 times the term average or below half of it, and
///         at least 2 percentage points away.
contract MockRateReferenceLink {
    uint32 public series = 1;
    uint256 public linked1e18;
    uint8 public refusal;
    uint256 public termAverage1e18;

    function setLinked(uint256 rate1e18, uint8 refusal_) external {
        linked1e18 = rate1e18;
        refusal = refusal_;
    }

    function setTermAverage(uint256 rate1e18) external {
        termAverage1e18 = rate1e18;
    }

    function setSeries(uint32 id) external {
        series = id;
    }

    function newestSeries(address) external view returns (uint32) {
        return series;
    }

    function linkedRate(address, uint256, uint8) external view returns (uint256, uint8) {
        return refusal != 0 ? (0, refusal) : (linked1e18, 0);
    }

    function band(address, uint256, uint256 rateBps) external view returns (IRateReference.Band memory b) {
        if (termAverage1e18 == 0) return b;
        b.available = true;
        b.termAverage1e18 = termAverage1e18;
        uint256 r = rateBps * 1e14;
        uint256 avg = termAverage1e18;
        uint256 dist = r > avg ? r - avg : avg - r;
        b.distanceBps = dist / 1e14;
        bool far = dist >= 200e14;
        if (r * 2 > avg * 3 && far) {
            b.outside = true;
            b.above = true;
        } else if (r * 2 < avg && far) {
            b.outside = true;
        }
    }
}
