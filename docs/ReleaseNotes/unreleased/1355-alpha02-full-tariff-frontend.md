## Thread — Full VPFI tariff opt-in surfaces in the connected app (PR #TBD)

The connected app now carries the user-facing half of the M2 Full
fee-entitlement tariff (#1347): each party can opt their own side into
Full at the moment their authorization is actually signed. On the
classic accept review and the desk's signed-order fill confirm, the
acceptor sees a live tariff quote for the prospective loan, an editable
authorization ceiling (seeded from the quote plus a small headroom, and
mandatory — the app refuses to sign a Full opt-in without one, mirroring
the contract), a warning when their vault's free VPFI is below the
quote, and an explicit choice between "reject the whole acceptance if
the tariff can't complete" and "open the loan without Full in that
case". A standing-offer creator arms their own opt-in after posting,
from the desk's Open Orders panel (the contract deliberately keeps this
off the create path); a signed-order maker cannot opt in at all until
the follow-up that threads it through the gasless order shape (#1369).

The copy holds the dual-fee honesty line throughout: paying the tariff
never replaces the loan's asset fees — it adds a deeper discount on the
payer's own side's fees, up to the overall cap — and the tariff is
non-refundable, priced on the loan's full term at open. Loan Details
shows the stamped per-party fee modes and absorbed tariffs once a party
actually paid Full, warns before an early close that none of the tariff
comes back, and notes on the lender's sale surfaces that the Full fee
mode travels with the position NFT to a buyer. Every one of these
surfaces is hidden while the on-chain kill-switch is off — the deployed
posture until the M2 joint cutover — because a Full authorization
presented while the feature is dark fails on chain.

The whole surface is exercised on the CI Anvil fork
(`e2e/tests/24-full-tariff.spec.ts`): the dark default renders no
opt-in control; with the feature admin-enabled, a strict Full opt-in
from an empty vault rejects the accept end-to-end (proving the signed
opt-in reaches the contract), and the same accept with downgrade
permission opens the loan with a stamped non-Full record. New copy ships
English-first and reaches the other locales at the next bundle refresh.
Closes #1355.
