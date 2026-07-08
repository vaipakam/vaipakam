## Sanctioned-locked proceeds now release fail-closed (PR #<n>)

When a loan closes out — a repayment, a default, a health-factor or discounted
liquidation, an internal match, a swap-to-repay, a preclose, an early-withdrawal
sale, or a fallback distribution — and the party the payout is owed to is on the
sanctions oracle, the protocol does not revert the close-out (that would trap the
honest counterparty). Instead it parks the flagged party's share in their own
vault, frozen behind the claim gate, and lets the close-out complete. Until now
that claim-time freeze relied on the ordinary sanctions screen, which is
deliberately *fail-open*: if the sanctions oracle is unreachable, the screen lets
the caller through so an infrastructure blip can never brick honest activity.

That left a narrow but real hole: while the oracle was down, a party who had been
confirmed sanctioned at close-out could withdraw their frozen proceeds anyway,
because the fail-open screen waved them through. A related laundering path existed
too — transfer the frozen position to a fresh, clean wallet during the outage and
have that wallet claim.

This change closes both. At close-out, whenever the intended recipient (the
current holder of the position, resolved live) is affirmatively flagged, the
protocol records *that specific address* as the frozen claimant for that loan
side. At claim time, if a side carries such a marker, the release must pass a
second, *fail-closed* screen on the recorded address: an unreachable or unset
oracle now blocks the release instead of allowing it, and the recorded party
must be proven de-listed before the funds move — regardless of who holds the
position now, which defeats the transfer-and-launder route. Ordinary claims,
which were never frozen, carry no marker and keep the fail-open behaviour, so a
genuine oracle blip still can't freeze an honest claimant. The marker is set only
on an affirmative flag, so a close-out that happens *during* an outage (when the
flag can't be confirmed) records nothing and stays fail-open — we never freeze a
party we never confirmed as sanctioned. Once a marked release passes cleanly, the
marker is cleared so a later re-lock stays possible.

The freeze survives an oracle outage; a de-listing (oracle back up, address
cleared) releases the funds. No behaviour changes for any unflagged party.

Closes #1006.
