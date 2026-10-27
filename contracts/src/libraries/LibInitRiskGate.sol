// src/libraries/LibInitRiskGate.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibInitRiskGate
 * @author Vaipakam Developer Team
 * @notice The ONE rule for whether a new loan carries the initiation risk
 *         gate (the init-LTV cap and the health-factor floor): only when both
 *         of its legs are Liquid (#2956).
 * @dev    A pair with an illiquid leg has no price to measure an LTV against;
 *         it is admitted on both parties' explicit consent to the illiquid
 *         terms instead. That consent is mandatory on every loan (an offer
 *         without it is refused at create, and a loan without both parties'
 *         consent is refused at initiation), so it is not a term of this rule.
 *         A rental is never both-liquid (its lent leg is an NFT and it has no
 *         collateral leg, #2949), so it never carries the gate either.
 *
 *         Every path that admits a loan, and every preview that predicts one,
 *         reads this rule: the binding accept ({LoanFacet}), the refinance
 *         re-check ({RefinanceFacet}), the create-time offer bounds
 *         ({LibOfferBounds}), and the range-match and intent-slice previews
 *         ({LibOfferMatch}). A path that judged the pair by any other rule
 *         could refuse what the accept admits, or admit what it refuses.
 */
library LibInitRiskGate {
    /// @notice Whether a loan on a pair with these leg liquidities carries
    ///         the initiation risk gate.
    /// @param  lendLiq The lent leg's liquidity, as the admitting path reads it.
    /// @param  collLiq The collateral leg's liquidity, as the admitting path
    ///         reads it (Illiquid for a rental, which has no collateral leg).
    /// @return True only when both legs are Liquid.
    function applies(
        LibVaipakam.LiquidityStatus lendLiq,
        LibVaipakam.LiquidityStatus collLiq
    ) internal pure returns (bool) {
        return lendLiq == LibVaipakam.LiquidityStatus.Liquid
            && collLiq == LibVaipakam.LiquidityStatus.Liquid;
    }
}
