// src/libraries/LibCloseoutFreeze.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title  LibCloseoutFreeze
 * @author Vaipakam Developer Team
 * @notice #954 (Codex #981/#986) — the shared Tier-2 close-out freeze logic for
 *         the swap-to-repay-FULL family (`SwapToRepayFacet.swapToRepayFull` and
 *         the Fusion intent settlement `LibSwapToRepayIntentSettlement`). Both
 *         terminals MUST complete regardless of either party's sanctions status
 *         (so the honest counterparty is made whole) while a flagged party's
 *         proceeds are FROZEN behind the claim-side sanctions gate rather than
 *         the tx reverting.
 *
 * @dev    Factoring the lender-leg freeze and the borrower-surplus freeze-or-pay
 *         into ONE place keeps the two terminals in lockstep, so neither can
 *         drift on the encumber-all-ERC20 (§1.1/§2.1) or the frozen-VPFI
 *         tier-exclusion (§2.2) rules. `internal` functions — they inline into
 *         each calling facet (no delegatecall), so the shared logic is a single
 *         source of truth without a runtime hop. `address(this)` inside these
 *         helpers is the Diamond (internal-lib calls run in the caller's
 *         context), so `IERC721(address(this)).ownerOf(...)` reads the position
 *         NFT held on the Diamond.
 *
 *         See docs/DesignsAndPlans/SanctionsCloseoutSweepAndSaleVehicleFixes.md.
 */
library LibCloseoutFreeze {
    using SafeERC20 for IERC20;

    /**
     * @notice Deposit a full swap-to-repay's lender proceeds into the STORED
     *         `loan.lender`'s vault behind the receive-side sanctions exemption,
     *         write the lender claim row, reserve the proceeds against the
     *         stored lender's spend paths, and (VPFI only) exclude a
     *         transferred-and-sanctioned holder's proceeds from the stored
     *         lender's fee tier.
     *
     * @dev    §1.1 — a lender flagged AFTER init must not brick this
     *         must-complete close-out; `depositLocked` resolves their EXISTING
     *         vault behind the pinned exemption (never mints for a flagged
     *         wallet). The proceeds stay claimable via `claimAsLender` once the
     *         lender/holder delists.
     *
     *         §1.1 encumber-all — reserve for EVERY ERC20, not just VPFI:
     *         `freeBalance` (which the signed-offer materialisation path
     *         consults) subtracts `s.encumbered` for any asset, so a
     *         transferred-away stored lender could otherwise spend non-VPFI
     *         proceeds as offer/intent capital before the current holder claims.
     *
     *         §2.2 tier-exclude — when the proceeds are VPFI and owed to a
     *         TRANSFERRED, sanctioned holder (`ownerOf(lenderTokenId) !=
     *         loan.lender`), bump `frozenVpfiOwedByVault[loan.lender]` so the
     *         VPFI (which sits in loan.lender's tracked balance) is kept out of
     *         loan.lender's tier — it belongs to the delistable holder. Record
     *         the exact bumped amount per loan for an exact release. A flagged
     *         SELF-holder keeps the VPFI in-tier (their own money).
     */
    function freezeLenderProceeds(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        uint256 lenderDue
    ) internal {
        LibSanctionedLock.depositLocked(
            s, loan.lender, loanId, loan.principalAsset, lenderDue
        );
        // #998 S10 (#1006) — freeze the lender payout fail-closed if the CURRENT
        // position holder (the intended claimant) is flagged, so the confirmed
        // freeze can't lift during an oracle outage.
        LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, true);
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        LibEncumbrance.encumberLenderProceeds(
            loanId, loan.lender, loan.principalAsset, lenderDue
        );
        if (lenderDue > 0 && loan.principalAsset == s.vpfiToken) {
            address holder = IERC721(address(this)).ownerOf(loan.lenderTokenId);
            // Codex #1122-rework r4 P2 — tier-exclude via the SAME registry-aware
            // freeze decision as the marker above (not the bare fail-open
            // `isSanctionedAddress`): a holder frozen only because they are in the
            // confirmed-flagged registry during an outage must still have their VPFI
            // excluded from `loan.lender`'s fee-tier/staking credit, since it is
            // owed to the frozen claimant. `mustFreezeParty` self-heals the registry
            // on a clean read here too.
            if (holder != loan.lender && LibSanctionedLock.mustFreezeParty(s, holder)) {
                s.frozenVpfiOwedByVault[loan.lender] += lenderDue;
                s.frozenVpfiOwedLenderLeg[loanId] = lenderDue;
            }
        }
    }

    /**
     * @notice Route a full swap-to-repay's borrower principal SURPLUS to the
     *         current borrower-position holder — paying a clean holder directly,
     *         or FREEZING a sanctioned holder's surplus into the stored
     *         `loan.borrower`'s vault behind the claim gate.
     *
     * @dev    Clean holder → direct EOA transfer (a vault deposit would be
     *         unclaimable: `claimAsBorrower` releases only the collateral asset
     *         recorded in `borrowerClaims`, and `vaultWithdrawERC20` is
     *         diamond-internal).
     *
     *         Sanctioned holder → `depositLocked` into `loan.borrower`'s
     *         always-existing vault (the holder may be a fresh transferee with
     *         no vault, and the receive exemption refuses to mint for a flagged
     *         wallet), plus a `borrowerSurplusClaims` row so the holder can
     *         withdraw it via `claimAsBorrower` once delisted.
     *
     *         §2.1 encumber-all — reserve for EVERY ERC20 against the stored
     *         borrower's signed-offer spend path. §2.2 tier-exclude — bump
     *         `frozenVpfiOwedByVault[loan.borrower]` (and record the per-loan
     *         amount) only for a VPFI surplus owed to a TRANSFERRED holder; a
     *         flagged self-holder's surplus stays in their tier.
     */
    function freezeOrPayBorrowerSurplus(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address currentHolder,
        uint256 surplus
    ) internal {
        if (surplus == 0) return;
        // Codex #1122-rework r1 P1 — FAIL-CLOSED freeze decision. The bare fail-open
        // `isSanctionedAddress` would take the direct-transfer branch for a
        // previously-confirmed-flagged `currentHolder` during an oracle outage,
        // paying the surplus straight to their EOA and bypassing the claim-side
        // fail-closed gate entirely. `mustFreezeParty` stays frozen on a prior
        // confirmation while the oracle is down.
        if (!LibSanctionedLock.mustFreezeParty(s, currentHolder)) {
            IERC20(loan.principalAsset).safeTransfer(currentHolder, surplus);
            return;
        }
        LibSanctionedLock.depositLocked(
            s, loan.borrower, loanId, loan.principalAsset, surplus
        );
        // #998 S10 (#1006) — the surplus is frozen precisely because
        // `currentHolder` is flagged (we are past the clean-holder early return),
        // so record that address as the frozen claimant for a fail-closed release.
        LibSanctionedLock.recordFrozenClaimant(s, loanId, false, currentHolder);
        s.borrowerSurplusClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: surplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        LibEncumbrance.encumberBorrowerProceeds(
            loanId, loan.borrower, loan.principalAsset, surplus
        );
        if (loan.principalAsset == s.vpfiToken && currentHolder != loan.borrower) {
            s.frozenVpfiOwedByVault[loan.borrower] += surplus;
            s.frozenVpfiOwedBorrowerSurplus[loanId] = surplus;
        }
    }

    /**
     * @notice Release the per-loan lender-leg frozen-VPFI tier exclusion when
     *         the lender claim is paid, decrementing the owner aggregate by
     *         EXACTLY what this loan bumped (§2.2). Idempotent no-op for loans
     *         that never bumped (the common clean / non-VPFI close).
     * @dev    Floored decrement guards the aggregate against any accounting
     *         drift — it can never underflow.
     */
    function releaseLenderFrozenVpfi(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address lender
    ) internal {
        uint256 bumped = s.frozenVpfiOwedLenderLeg[loanId];
        if (bumped == 0) return;
        uint256 cur = s.frozenVpfiOwedByVault[lender];
        s.frozenVpfiOwedByVault[lender] = cur > bumped ? cur - bumped : 0;
        s.frozenVpfiOwedLenderLeg[loanId] = 0;
    }

    /**
     * @notice Release the per-loan borrower-surplus frozen-VPFI tier exclusion
     *         when the surplus claim is paid (§2.2). Idempotent no-op for loans
     *         that never bumped.
     */
    function releaseBorrowerFrozenVpfi(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address borrower
    ) internal {
        uint256 bumped = s.frozenVpfiOwedBorrowerSurplus[loanId];
        if (bumped == 0) return;
        uint256 cur = s.frozenVpfiOwedByVault[borrower];
        s.frozenVpfiOwedByVault[borrower] = cur > bumped ? cur - bumped : 0;
        s.frozenVpfiOwedBorrowerSurplus[loanId] = 0;
    }
}
