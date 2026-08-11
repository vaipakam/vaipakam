// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title MockRetiredDeployment
 * @notice #1662 r5 test double — a RETIRED canonical Diamond, as seen by
 *         `importOutstandingCompensation` during a rotation.
 * @dev    The import no longer trusts operator-supplied figures: it reads
 *         the retiring deployment's own reservation record and its
 *         already-resolved amount, and carries only the UNRESOLVED
 *         remainder. This double is what the tests point that read at.
 *
 *         `supportsLoss` models the generation split deliberately: a
 *         deployment predating the recovery ceremony has no terminal-loss
 *         getter at all, and the import must treat that absence as a
 *         structural zero rather than as unknown — there is no loss state
 *         on such a deployment to miss.
 */
contract MockRetiredDeployment {
    LibVaipakam.RemitReservation private _res;
    uint256 private _recovered;
    uint256 private _loss;
    bool public supportsLoss = true;

    function setReservation(
        uint8 status,
        uint256 total,
        uint256 fresh,
        uint256 recycled
    ) external {
        _res.status = status;
        _res.total = total;
        _res.fresh = fresh;
        _res.recycled = recycled;
    }

    function setResolved(uint256 recovered, uint256 loss) external {
        _recovered = recovered;
        _loss = loss;
    }

    /// @notice Model a pre-ceremony generation: the selector is absent.
    function setSupportsLoss(bool on) external {
        supportsLoss = on;
    }

    function getRemitReservation(
        uint256
    ) external view returns (LibVaipakam.RemitReservation memory) {
        return _res;
    }

    function getRecoveredForReceipt(uint256) external view returns (uint256) {
        return _recovered;
    }

    function getCeremonyTerminalLoss(
        uint256
    ) external view returns (uint256) {
        require(supportsLoss, "no loss surface on this generation");
        return _loss;
    }
}
