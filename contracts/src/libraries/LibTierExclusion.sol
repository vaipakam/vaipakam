// src/libraries/LibTierExclusion.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibERC721} from "./LibERC721.sol";

/**
 * @title  LibTierExclusion
 * @author Vaipakam Developer Team
 * @notice #2342 — keeps VPFI that is owed to someone else out of the vault
 *         owner's fee-discount tier, for every close-out.
 *
 *         When a loan goes terminal, what each side is owed — the lender's
 *         proceeds, the borrower's residual collateral or surplus — is held in
 *         the STORED party's vault until the side's current position holder
 *         claims it. If the position NFT has changed hands, that VPFI sits in
 *         one wallet's tracked balance while belonging to another, and the
 *         tier is stamped from the tracked balance. So the vault owner would
 *         keep tier credit on VPFI that is not theirs, for as long as the
 *         holder does not claim — indefinitely, when the holder is sanctioned
 *         and cannot. The spec's rule is that fee-tier credit follows the
 *         current position holder (ProjectDetailsREADME: close-out position
 *         effects "must follow the current position-NFT holder"; frozen
 *         proceeds are "excluded from their VPFI fee-discount tier when the
 *         funds are economically owed to a transferred-away holder").
 *
 * @dev    ONE rule, derived rather than recorded path by path. For each side
 *         of a loan:
 *
 *           excluded = loan is terminal
 *                      AND the side's position NFT is held (not burned)
 *                      AND its holder is not the stored party
 *             ? the VPFI in that side's per-loan encumbrance records
 *             : nothing
 *
 *         charged to the stored party, whose vault holds the funds. The
 *         amount comes from `LibEncumbrance.vpfiReservedOnSide` — the ledger
 *         that already reserves owed VPFI against the stored party's spend
 *         paths — so this library never keeps a second account of what is
 *         owed. {sync} recomputes the rule and applies the difference to the
 *         per-owner `frozenVpfiOwedByVault` aggregate the tier stamp reads.
 *
 *         The inputs change at exactly three kinds of event, and each re-runs
 *         {sync}:
 *           - the terminal transition — `EncumbranceMutateFacet.terminalize*`,
 *             the single host every register-triggering close-out already
 *             routes through;
 *           - a position-NFT transfer or burn — `VaipakamNFTFacet`;
 *           - a change to a per-loan encumbrance record — every
 *             `LibEncumbrance` per-loan mutator, via its tier-exclusion
 *             notify.
 *         The stored party itself never changes on a terminal loan:
 *         consolidation, the only re-anchor, is a no-op once a loan is
 *         terminal (`LibConsolidation.consolidateToHolder`, step 1).
 *
 *         Scope: TERMINAL loans only — decided, not deferred (#2357). A
 *         live loan whose position changed hands leaves the stored party
 *         with tier credit on the live collateral until the next
 *         consolidation, and that is the intended behaviour:
 *           - the current holder can consolidate their own position at any
 *             time (`ConsolidationFacet.consolidate*ToHolder`), which moves
 *             the funds and with them the credit;
 *           - on a live loan the stored party is NOT fixed, so a charge keyed
 *             to it would go stale when consolidation or a sale re-points the
 *             funds — the reason the comment on
 *             `LibCloseoutFreeze._parkActiveLenderShare` gives for dropping
 *             an active-phase counter; on a terminal loan that staleness
 *             cannot arise, for the reason above;
 *           - the stored party cannot spend the funds meanwhile (the lien /
 *             active-held reservation), so only tier credit lingers.
 *         The residual is a sanctioned holder, who cannot consolidate; it is
 *         bounded by the loan closing, at which point this rule takes over.
 *         ProjectDetailsREADME states the decision and its reasons.
 *
 *         Sanctions are NOT an input. They explain why a holder may be unable
 *         to claim, but the funds are owed to a different wallet either way;
 *         a clean holder who bought the claim after the loan closed is owed
 *         them just as much. This also keeps the rule free of oracle reads,
 *         whose answer changes without any on-chain event.
 */
library LibTierExclusion {
    /// @notice #2342 — a loan side's VPFI fee-tier exclusion is now as stated:
    ///         `excludedVpfi` of `vaultOwner`'s vault is kept out of
    ///         `vaultOwner`'s fee-discount tier because it is owed to the
    ///         side's position holder. `vaultOwner == address(0)` means the
    ///         side no longer excludes anything (claimed, burned, bought back,
    ///         or never transferred). A non-zero `vaultOwner` with
    ///         `excludedVpfi == 0` means the rule applies to the side but
    ///         nothing it reserves is VPFI right now. Emitted only when the side's state
    ///         changes, so the latest event per `(loanId, lenderSide)` is the
    ///         current state.
    /// @custom:event-category state-change/vault-mutation
    event TierExclusionUpdated(
        uint256 indexed loanId,
        bool lenderSide,
        address indexed vaultOwner,
        uint256 excludedVpfi
    );

    /// @notice Recompute both sides' exclusion for `loanId` and apply the
    ///         difference to `frozenVpfiOwedByVault`.
    /// @return changed Vault owners whose excluded amount changed (zero
    ///         entries unused; an owner may repeat). The caller restamps them
    ///         so the change reaches the tier now rather than at the owner's
    ///         next vault mutation.
    function sync(uint256 loanId) internal returns (address[4] memory changed) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.LoanStatus st = loan.status;
        bool terminal = st == LibVaipakam.LoanStatus.Repaid ||
            st == LibVaipakam.LoanStatus.Defaulted ||
            st == LibVaipakam.LoanStatus.InternalMatched ||
            st == LibVaipakam.LoanStatus.Settled;
        (changed[0], changed[1]) = _syncSide(s, loan, loanId, true, terminal);
        (changed[2], changed[3]) = _syncSide(s, loan, loanId, false, terminal);
    }

    /// @dev One side of {sync}. Returns the vault owner whose charge was
    ///      reduced (`released`) and the one whose charge was raised
    ///      (`charged`), each zero when unchanged.
    function _syncSide(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        bool lenderSide,
        bool terminal
    ) private returns (address released, address raised) {
        address stored = lenderSide ? loan.lender : loan.borrower;

        // Fold a pre-#2342 swap-to-repay-FULL freeze record into the new
        // accounting. That freeze bumped the aggregate for `stored` and
        // recorded the amount per loan; the same VPFI is in the ledger read
        // below, so the old bump is removed here and re-counted there, once.
        uint256 legacy = lenderSide
            ? s.frozenVpfiOwedLenderLeg[loanId]
            : s.frozenVpfiOwedBorrowerSurplus[loanId];
        if (legacy != 0) {
            _decrease(s, stored, legacy);
            if (lenderSide) {
                s.frozenVpfiOwedLenderLeg[loanId] = 0;
            } else {
                s.frozenVpfiOwedBorrowerSurplus[loanId] = 0;
            }
            released = stored;
        }

        address charged;
        uint256 amount;
        if (terminal) {
            address holder = LibERC721._ownerOfRaw(
                lenderSide ? loan.lenderTokenId : loan.borrowerTokenId
            );
            if (holder != address(0) && holder != stored) {
                charged = stored;
                amount = LibEncumbrance.vpfiReservedOnSide(loanId, lenderSide);
            }
        }

        address prevCharged = lenderSide
            ? s.tierExclusionLenderVault[loanId]
            : s.tierExclusionBorrowerVault[loanId];
        uint256 prevAmount = lenderSide
            ? s.tierExclusionLenderVpfi[loanId]
            : s.tierExclusionBorrowerVpfi[loanId];
        if (prevCharged == charged && prevAmount == amount) {
            // The record stands; only a legacy fold (if any) moved the
            // aggregate, and it moved it onto this same record.
            if (legacy != 0) {
                emit TierExclusionUpdated(loanId, lenderSide, charged, amount);
            }
            return (released, address(0));
        }

        if (prevCharged != address(0) && prevAmount != 0) {
            _decrease(s, prevCharged, prevAmount);
            released = prevCharged;
        }
        if (charged != address(0) && amount != 0) {
            s.frozenVpfiOwedByVault[charged] += amount;
            raised = charged;
        }
        if (lenderSide) {
            s.tierExclusionLenderVault[loanId] = charged;
            s.tierExclusionLenderVpfi[loanId] = amount;
        } else {
            s.tierExclusionBorrowerVault[loanId] = charged;
            s.tierExclusionBorrowerVpfi[loanId] = amount;
        }
        emit TierExclusionUpdated(loanId, lenderSide, charged, amount);
    }

    /// @dev Floored decrement: the aggregate is a sum of per-loan records, so
    ///      it cannot legitimately go below a record; the floor keeps any
    ///      pre-existing drift from bricking a close-out.
    function _decrease(
        LibVaipakam.Storage storage s,
        address owner,
        uint256 by
    ) private {
        uint256 cur = s.frozenVpfiOwedByVault[owner];
        s.frozenVpfiOwedByVault[owner] = cur > by ? cur - by : 0;
    }
}
