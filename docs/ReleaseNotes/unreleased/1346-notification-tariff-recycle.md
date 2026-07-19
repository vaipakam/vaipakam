## Thread — Notification tariff joins the recycle loop (Layer 0) (PR #<n>)

The per-loan-side notification fee — billed in VPFI when the off-chain
watcher fires the first paid-tier notification for a loan side — is now
the first live non-forfeit absorption channel of the VPFI recycling
loop. Two changes land together (recycling completion plan milestone M1,
governor design §4.1 "Layer 0"):

**Flat native-VPFI tariff.** The fee is now a flat quantity denominated
directly in VPFI, not a numeraire (USD-style) figure converted through
the ETH/numeraire oracle and the fixed VPFI-per-ETH peg. The stored
value IS the VPFI amount billed. The launch-era "convert a fiat price
into VPFI at a fixed peg" path is retired here (the conversion class the
tokenomics spec forbids at launch), replaced by a governance-tunable
flat tariff. The default is 0.5 VPFI, chosen to preserve the ≈0.5-VPFI
bill the old conversion produced at typical prices, so users see no
change in what they pay. Because the tariff is now a VPFI quantity with
no currency linkage, it is also removed from the atomic numeraire
rotation setter — a numeraire change (e.g. USD→EUR) would otherwise
overwrite the VPFI amount with a fiat-denominated value. The tariff is
tuned only through its own setter.

**Custody re-route into the recycle bucket.** Previously the tariff
moved straight from the user's vault to the treasury and left the
recycling loop entirely. It now moves into protocol (Diamond) custody
and credits the recycle bucket under the `NotificationFee` source —
extending the interaction-reward program's runway rather than being
skimmed to treasury. The same vault debit now also runs the mandatory
discount-tier restamp that every other VPFI-outflow path runs, closing a
long-standing gap where billing this fee left a stale fee-discount stamp
on VPFI that had already left the user's vault.

Everything ships dark alongside the rest of the recycling stack — the
credit is real bookkeeping, but no interaction-reward emissions are
running yet, so nothing is economically live until the activation
ceremonies (plan milestone M7). Closes #1346.
