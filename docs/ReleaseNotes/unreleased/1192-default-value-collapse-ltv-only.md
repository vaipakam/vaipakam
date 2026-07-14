## Thread — Time-based default no longer hands the lender the whole collateral just because Health Factor dipped below 1 (PR #1192)

When a liquid-collateral loan defaulted at maturity, the protocol decided
between two settlement routes: sell the collateral on a DEX and split the
proceeds (lender capped at what they are owed, borrower keeps the surplus), or
hand the lender the borrower's *entire* collateral in kind with no swap and no
surplus returned. The choice hinged on a "value-collapsed" signal that fired
whenever either the loan's LTV exceeded the 110% volatility cap **or** its
Health Factor fell below 1. The second condition was too broad: a Health Factor
below 1 does not mean the collateral is worth less than the debt. For a loan
whose collateral still sat between the debt and roughly 1.25× the debt (the band
where pricing is live and LTV is still under 110%), the borrower had recoverable
value above the lender's entitlement — but the whole-collateral-in-kind branch
took all of it and gave the lender the surplus for free.

This change restricts the whole-collateral-in-kind branch to a genuine LTV > 110%
collapse (and the existing illiquid-with-consent case). A defaulted liquid loan
that is merely Health-Factor-underwater but still covered now routes through the
ordinary swap/split waterfall: it must attempt at least one enabled swap route,
the lender is capped at the amount owed, and the borrower keeps the recoverable
surplus. If that swap cannot execute safely (abnormal market, slippage over the
configured max, liquidity gone), settlement falls through to the same
oracle-aware fallback the platform already uses — which itself gives the lender
the full collateral only when fair-value pricing is unavailable or the collateral
is genuinely insufficient, and otherwise awards the lender their capped
entitlement plus the fallback premium and leaves the borrower the remainder. The
LTV > 110% "extreme crash" branch is unchanged, because at that point the
collateral is below the debt and the lender is entitled to all of it anyway.

This aligns the time-based default path with the intended settlement behaviour
(no automatic full-collateral-to-lender unless the fair-value split cannot be
computed or the collateral is insufficient; the lender ceiling is the amount due
plus interest plus the 3% premium; at least one route must be attempted). No new
functions or selectors were added — the routing reuses the existing on-chain LTV
view — so there is no ABI change. Closes #1192 (Pass-2 conformance umbrella #1196).
