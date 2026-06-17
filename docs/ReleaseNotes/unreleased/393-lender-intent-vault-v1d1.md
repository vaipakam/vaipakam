## Thread — LenderIntentVault v1-d.1: standing-intent working capital (fund + exit)

A lender with a standing lending intent can now **fund it with working
capital** and **withdraw the un-lent remainder back to their wallet**. This
closes the gap that made the intent surface incomplete: until now there was no
clean way for a lender to put standing capital behind an intent, nor to take
un-lent capital back out.

**Funding follows the offer model.** Funding an intent pulls the lender's
capital from their wallet into their own vault and locks it under the intent —
exactly the way creating an offer pre-vaults and locks its principal. That
locked capital is the pool a solver's fills draw from. Because it is locked
(not loose vault balance), no other withdrawal path can touch it; it can only
leave by being lent out in a fill or by the lender withdrawing it.

**The exit mirrors cancelling an offer.** Withdrawing intent capital releases
the un-lent portion of that lock and returns it to the lender's wallet. A
lender can fund in stages, top up, withdraw part, or wind down entirely — and
the exit stays available even after the intent itself is cancelled, so capital
is never stranded.

**Why this is safe by construction.** A lender's funded capital and the
proceeds of a loan that has repaid live in two separate places: funded capital
sits in the locked intent pool, while repaid proceeds return as an ordinary
claim the lender collects with their loan position NFT. The withdrawal door
only ever touches the locked intent pool, so it can never reach — and never
double-spend — money that is already owed to the position-NFT holder as a
claim. This is the same protection the platform already applies to its other
vaulted-balance withdrawal door, achieved here structurally rather than with an
extra reservation.

**Solver fills now draw strictly from funded capital.** A fill can never lend
more than the lender has actually funded into the intent; an under-funded
intent simply can't be filled until more capital is added. The standing
exposure cap the lender set still applies on top.

Part of #393 (does not close the umbrella). The aggregator question raised
during design — whether the auto-matching layer should also be able to use
capital a lender committed via ordinary offer creation — is tracked separately
as a research item (#621). Next: v1-d.2, the zero-gap auto-roll that re-funds
the intent from a loan's proceeds without a manual round-trip.
