## Dashboards now show loans that are pending a failed-liquidation cure (#940)

When a loan's liquidation cannot complete on-chain, it enters a **fallback-pending**
state. That state is not the end of the road: the borrower can still cure it —
by adding collateral or repaying in full — right up until the lender claims. It
is treated as an *active* loan everywhere in the protocol.

The connected app's dashboard, however, was leaving these loans out. The "Your
Loans" panel, the unified both-sides table, and the headline active-loan counts
all filtered on the strict "Active" status and silently dropped fallback-pending
loans. A borrower who relied on the dashboard could therefore not see a loan that
was counting down toward a permanent default they still had the power to prevent —
and miss the cure window.

The dashboard read views now use the same "active set" definition the rest of the
protocol uses (Active **or** fallback-pending), so a fallback-pending loan appears
in the loan lists and the counts like any other open loan. No behaviour of the
loan itself changed — only what the dashboard chooses to show.

Part of the 2026-07-05 spec-vs-code conformance review. Closes #940.
