# Anti-phishing: offer acceptance is now bound to the exact terms (#662)

Accepting an offer used to commit your wallet to nothing more than an opaque
offer id and a single "I agree" checkbox. A malicious clone of the app could
therefore get you to sign a perfectly valid acceptance whose wallet prompt told
you nothing about what you were actually agreeing to — and, on the illiquid-asset
path where the usual loan-to-value safety check is intentionally skipped, drain
you with a worthless dummy token.

From now on, accepting an offer requires a typed, wallet-rendered confirmation of
the **actual economic terms**. Your wallet shows — and you sign — the real lend
and collateral assets, amounts, rate, duration, the specific position a sale or
offset accept will buy or close, and (when a leg has no price oracle) the exact
illiquid asset you are acknowledging. The contract then checks, before any value
moves, that what you signed matches the offer on-chain to the letter; if anything
differs it refuses the acceptance. A cloned front-end can no longer swap the
terms between what you see and what executes, and it can no longer hide a
worthless asset behind a blanket consent.

This is a one-time signing step that the app fills in for you from the offer you
are viewing — there is still just one thing to acknowledge, now backed by a
prompt that actually describes the deal. The keeper-driven matching path (which
pairs two already-authored offers, with no acceptor to phish) is unaffected.

This is the foundation the upcoming progressive risk-access tiers build on.
