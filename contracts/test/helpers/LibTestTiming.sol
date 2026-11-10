// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibTiming} from "../../src/libraries/LibTiming.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LenderIntentFacet} from "../../src/facets/LenderIntentFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

/// @title  LibTestTiming
/// @notice #3443 — an offer can be filled only once its terms have stood the
///         minimum age (`LibTiming.minTermsAgeSec`, 5 s by default). A live
///         taker simply arrives later; a test that posts an offer and takes it
///         in the same call frame moves the chain to the moment the terms
///         become fillable first, the way `LibTestPositionNFT.waitOutCooldown`
///         does for a position's transfer cooldown.
library LibTestTiming {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Moves time (and the block) forward to the moment offer
    ///         `offerId`'s terms become fillable. Does nothing for terms that
    ///         are already old enough, carry no age, or on a Diamond that does
    ///         not route the offer read.
    function waitOutTermsAge(address diamond, uint256 offerId) internal {
        uint64 setAt;
        try OfferCancelFacet(diamond).getOffer(offerId) returns (LibVaipakam.Offer memory o) {
            setAt = o.termsSetAt;
        } catch {
            return;
        }
        _waitUntil(_readyAt(diamond, setAt));
    }

    /// @notice The same, for both legs of a match.
    function waitOutTermsAge(address diamond, uint256 offerA, uint256 offerB) internal {
        waitOutTermsAge(diamond, offerA);
        waitOutTermsAge(diamond, offerB);
    }

    /// @notice The same, for `owner`'s lender intent on the pair.
    function waitOutIntentAge(
        address diamond,
        address owner,
        address lendingAsset,
        address collateralAsset
    ) internal {
        uint64 setAt;
        try LenderIntentFacet(diamond).getLenderIntent(owner, lendingAsset, collateralAsset)
            returns (LibVaipakam.LenderIntent memory i)
        {
            setAt = i.termsSetAt;
        } catch {
            return;
        }
        _waitUntil(_readyAt(diamond, setAt));
    }

    /// @notice Makes offer `offerId`'s terms fillable NOW without moving the
    ///         clock, by recording them as set {minTermsAgeSec} earlier — a
    ///         maker who posted ahead of the taker. For a test whose figures
    ///         depend on the exact fill moment (a handover sized to the loan's
    ///         remaining time, a health factor asserted to the wei), where
    ///         {waitOutTermsAge}'s few seconds would change the answer. Needs
    ///         the test Diamond to route `TestMutatorFacet.setOffer`.
    function backdateTerms(address diamond, uint256 offerId) internal {
        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        uint256 readyAt = _readyAt(diamond, o.termsSetAt);
        uint256 nowTs = VM.getBlockTimestamp();
        if (readyAt <= nowTs) return;
        uint256 age = readyAt - o.termsSetAt;
        // Near genesis there is no earlier second to record; 0 carries no age.
        o.termsSetAt = nowTs > age ? uint64(nowTs - age) : 0;
        TestMutatorFacet(diamond).setOffer(offerId, o);
    }

    function _readyAt(address diamond, uint64 setAt) private view returns (uint256) {
        if (setAt == 0) return 0;
        uint256 age = LibTiming.DEFAULT_MIN_TERMS_AGE_SEC;
        try ConfigFacet(diamond).getMinTermsAgeSec() returns (uint256 a) {
            age = a;
        } catch {}
        return uint256(setAt) + age;
    }

    function _waitUntil(uint256 readyAt) private {
        if (VM.getBlockTimestamp() >= readyAt) return;
        VM.warp(readyAt);
        VM.roll(VM.getBlockNumber() + 1);
    }
}
