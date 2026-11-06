## Security — risk-access changes can no longer be relayed or pre-signed (PR #<n>)

The risk-access facet used to accept five relayed, signed grants: a tier
change, a checked tier change, an illiquid-pair consent, a strict-mode toggle
and an explicit mid-tier acknowledgement. A user signed the grant and anyone
could submit it. They are removed, together with the view that reported their
replay nonces.

Why: nothing in the app, the keeper or the public keeper-bot used them, and a
signed grant was a standing risk. It carried no upper bound on how long it
stayed valid, and the user had no way to cancel one they had signed but nobody
had submitted. A user tricked by a fake site into signing one could have it
used later to loosen their own safeguards. With the relayed form gone, every
risk-access change is the vault owner's own direct transaction, and a request
to sign one is never genuine.

What stays the same: the direct setters, the conditional tier change, the
terms anchor, the cooldowns and the gate itself are unchanged. The storage slot
that held the replay nonces is kept, unused, so the layout stays append-only.

The removed selectors stay unrouted on a fresh deploy; the all-facets refresh
removes them from an existing testnet Diamond by itself.

Closes #3238
