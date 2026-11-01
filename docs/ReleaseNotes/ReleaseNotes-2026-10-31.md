# Release Notes — 2026-10-31

A borrower's refinance now pays the old lender through a single-use permit signed for that one request, instead of a standing token approval to the protocol. The permit is spent once when a lender accepts, and an unused one simply expires with the request, so nothing is left approved. The change reaches the testnets only with the all-waves fresh deploy.

## Refinance payoff by single-use permit (PR #3075)

A refinance now pays off the old loan with an exact-amount, single-use Permit2
signature instead of a standing token approval to the protocol. When the
borrower posts a refinance request, the app asks them to sign a permit for that
loan through that request, sized to the most the wallet's share of the payoff
can reach before the request stops being fillable, and attaches it to the
request. (The wallet's share is the payoff less the new loan's principal net of
its initiation fee, which pays the old lender inside the protocol; see the
netted-refinance note, #3042.) When a lender accepts, or a matcher completes
the refinance, the protocol pulls the exact share at that moment through the
permit, once, and the permit is spent.

Nothing is left approved afterwards. The wallet's own token approval goes to
Permit2, which cannot move anything without a matching signature, and the
protocol holds no allowance over the borrower's wallet at any point. An unused
permit simply expires with the request, so cancelling a request or letting it
lapse leaves nothing to revoke. Any lender or matcher can still complete the
refinance until the permit expires, so automatic matching keeps working without
a new wallet prompt.

The contract refuses a refinance by name when the permit is missing, signed by
someone other than the current borrower-position holder, smaller than the
wallet's share, or expired; that undoes the whole acceptance. A new view
reports the payoff and the wallet's share now and at any moment the caller
names, plus the stored permit and whether it has been spent,
so the app can say exactly what the permit covers and whether it still pays
every acceptance the request allows.

The permit entry points and the view live on a new facet,
RefinancePayoffFacet, refreshed together with RefinanceFacet. The single-loan
flow, "Refinance all" (one signature per request, attached in one transaction)
and the pending-request card all use it. Local Anvil bootstrap now installs
Permit2 so refinances work there, and the positive-flow scripts and fork
scenario attach the permit before refinancing.

Until the all-waves fresh deploy, the app keeps the earlier approval route on a
deployment whose contract does not offer the permit yet. That is a disclosed
temporary bridge; #3074 removes it after the deploy.

Closes #1558. Design: `docs/DesignsAndPlans/RefinancePayoffPermitDesign.md`.

> Caveat: on a deployment that predates this change the app still sets a payoff approval to the protocol, as before, until #3074 removes that route.

_Committed 2026-10-31 23:52 UTC (b22f6f647)._
<!-- assembled-fragment: 1558-refinance-payoff-permit.md sha256=99c1377d6ab6f5c712a776f9c7f93bbc021bb69c7953430eed7a8940d96385fb -->
