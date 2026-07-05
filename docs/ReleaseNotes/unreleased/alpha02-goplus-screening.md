## Thread — independent token-security screening (honeypot / pump-and-dump defense)

Deals carrying tokens from outside the curated list are now screened
through an independent contract-security service (GoPlus) before they
can be accepted. The accept side is deliberately the primary defense:
a malicious actor creates their offer directly against the contracts —
never through our website — so the only screen that can protect the
person accepting is on the accept review itself. Both legs of a loan
deal and the rental prepayment token are checked; a token flagged as
a honeypot, sell-restricted, owner-blacklistable-and-pausable, or
carrying punitive taxes (on buys, sells, or plain transfers) blocks
acceptance with the reasons in plain words — because a token like
that can be impossible to sell or transfer no matter what the deal
terms say, which is exactly the harm the unpriced-asset consent
warnings cannot catch. "Couldn't verify" is never treated as clean:
a token whose contract source is unverified, or whose critical
honeypot check the screen could not evaluate, is blocked outright
(those are precisely the least-checkable tokens); secondary trade
checks or taxes the screen could not evaluate are disclosed as
warnings rather than assumed clear, and an outage of the
screening service holds acceptance back with a working retry — the
check re-probes on its own and the review offers a "Check again"
button. Softer owner-power findings become warnings the user
knowingly proceeds past — and consent is re-collected whenever the
disclosed warning text changes, not just when a verdict first
appears. The verdict is re-checked at signing time so a flag landing
after review still aborts before any signature; a warning that was
never shown on the review screen aborts the signing too, and the
review then displays it so consent can be given against what is
actually known.

Pasting an unknown token address when building an offer surfaces the
same verdict immediately at entry. Curated tokens are pre-vetted and
exempt; test networks — which the security service does not index —
show an honest "not covered here" notice instead of blocking, so
faucet-token testing keeps working. The screening service's public
endpoint needs no account or key, and verdicts are cached so browsing
stays inside its rate limits. Risk badges on the offer-book and
guided-match cards follow as the final slice of this work.
