## Thread — Per-party Full VPFI fee-entitlement tariff (M2 PR-5a/5b) (PR #<n>)

Builds the second, opt-in half of the VPFI fee package the spec supersession
(#1350) described: the **Full tariff**. Where the HoldOnly path (#1352) simply
reduces a consenting tier-holder's Loan-Initiation Fee, Full lets a party
additionally *absorb* a fee-native VPFI tariff `C*` from their own vault into
the recycle bucket at loan origination, in exchange for a larger own-side fee
discount. It is **per-party and double-absorbing**: the borrower and the lender
each opt in independently, and each opting-in party pays one `C*`, so a loan
where both sides opt in sends `2 × C*` to the bucket.

`C*` is priced from the **list** Loan-Initiation Fee, not a token price:
`C* = baseLif_list_numeraire × (durationDays / 365) × K`, with `K` a governable
VPFI-per-list-LIF-year policy constant (default 5). It is never a
`feeUSD / vpfiPrice` conversion, so it carries no peg or market-price surface.

**Authorization is party-scoped and unforgeable.** The offer *creator* authorizes
their own Full opt-in before acceptance (a new creator-only, pre-acceptance
setter that writes the authorization onto the offer — the same shape as the
per-offer keeper-enable, deliberately kept off the ~60 offer-construction sites);
the *acceptor* authorizes theirs inside the signed accept terms. The accept path
then maps creator/acceptor to borrower/lender by offer side, so a borrower or a
matcher can never drain the counterparty's vault. Every Full authorization must
carry a mandatory absolute `maxCStar` ceiling: if the quoted tariff exceeds it
the accept reverts, unless the party also permitted a silent downgrade to the
non-Full path. A matcher/keeper fill (which carries no acceptor-signed terms)
always resolves the acceptor side as non-Full.

The whole feature ships **dark** behind a single master switch. While the switch
is off **and no party opted into Full**, the accept path skips the tariff
entirely — nothing is charged, nothing is stamped — which also keeps the tariff
facet off the routing surface of the many minimal-cut test/integration diamonds
that never enable it. A Full opt-in presented **while the switch is off** still
routes through the resolver so it **fails closed** (the accept reverts) — or
downgrades to non-Full if the party's signed terms permitted it — rather than
silently proceeding (the kill-switch-first rule). When the switch is
turned on, every subsequent reward-eligible ERC-20 origination stamps its
per-loan fee-entitlement record (the resolved per-party modes, each party's
absorbed tariff, and the notional `C*` a later loan-side reward cap is defined
from) — the "cStar-from-genesis" posture, where stamping begins the moment the
tariff goes live. Rentals and lender-sale-vehicle accepts bear no tariff (they
pay no Loan-Initiation Fee). A confirmed borrower Full opt-in additionally bumps
the borrower's own-side Loan-Initiation-Fee discount by 10% (clamped at the
uniform 50% ceiling), resolved in lockstep with the tariff charge so the
discount is never granted without the tariff being taken.

The frontend accept-signing hooks (defi + alpha02) were extended to sign the new
accept-terms fields (defaulted to the non-Full path — the Full-tariff accept UI
and tariff-quote surface ship in PR-8, #1355). The lender-side Full discount at
**settlement** (the yield-fee `+10%`) and the loan-side reward cap that consumes
the stamped `C*` are separate later cards (PR-6 #1354 / PR-5c #1353). Closes #1347.
