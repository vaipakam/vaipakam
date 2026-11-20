// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IRateReference} from "../interfaces/IRateReference.sol";
import {IProtocolRegistryReader} from "../interfaces/IProtocolRegistryReader.sol";
import {RegistryKeys} from "../governance/RegistryKeys.sol";

/**
 * @title  LibRateReference
 * @author Vaipakam Developer Team
 * @notice How the Diamond finds the rate reference (#3337 part 1): through
 *         the protocol registry's `RATE_REFERENCE` pointer, never from a
 *         setting in Diamond storage. The Diamond holds no rate source, no
 *         index and no averaging rule; every figure is read from the
 *         reference, so the app, the indexer, an integrator and every fill
 *         read one answer.
 * @dev    A chain whose registry names no rate reference has none: every
 *         read here reports "no reference" rather than reverting, a
 *         market-linked limit is refused where it is written, and no rate is
 *         checked against a band. A pointer that is set but answers with a
 *         revert is NOT treated as absent: the read reverts, so a broken
 *         reference fails closed rather than silently switching the band
 *         check off.
 */
library LibRateReference {
    /// @notice The rate reference the registry names, or `ok = false` when
    ///         the Diamond has no registry or the registry names none.
    function tryReference() internal view returns (bool ok, IRateReference rr) {
        address r = LibVaipakam.storageSlot().protocolRegistry;
        if (r == address(0)) return (false, rr);
        address a = IProtocolRegistryReader(r).pointer(RegistryKeys.RATE_REFERENCE);
        if (a == address(0) || a.code.length == 0) return (false, rr);
        return (true, IRateReference(a));
    }
}
