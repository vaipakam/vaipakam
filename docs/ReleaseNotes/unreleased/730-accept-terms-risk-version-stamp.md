## Thread — Version-stamp the acceptance acknowledgement against the risk-terms version (PR #<n>)

Follow-up to #728 (closes #730). Hardens the unification between the #662
anti-phishing accept binding and the #671 progressive-risk illiquid-pair
consent.

When an acceptor takes an offer whose asset pair is illiquid, the acceptance
signature they already sign can stand in for a separately-recorded standing
consent for that pair — so they don't have to sign twice. Previously the
"freshness" of that stand-in was judged only by whether the acceptor's vault
risk-tier had been re-affirmed since the last governance change to the risk
terms. That left a gap: someone who signed a long-lived acceptance for an
illiquid offer **before** a risk-terms change, and then re-affirmed only their
tier afterward, could still submit the old acknowledgement as if it were fresh.

The acceptance message now carries the live risk-terms anchor it was signed
against, and the gate requires that anchor to be current for the acknowledgement
to stand in for a consent. Crucially the anchor is an **unguessable secret**
published with each terms change and unavailable before the change is enacted —
neither the predictable version counter nor the (public) terms-document hash — so
a malicious interface cannot induce a user to pre-sign an acknowledgement for the
*next* terms version and have it activate on the next change. To keep the anchor
secret even when governance is a transparent on-chain timelock, a terms change is
published via a **commit–reveal**: the governance decision (slow/timelocked)
records only a hiding commitment (the queued calldata exposes nothing), and a
separate fast off-timelock operational authority reveals-and-activates the secret
atomically. Each anchor is single-use for the protocol's lifetime, so
re-publishing terms can never revive a stale acknowledgement; the human-readable
terms document and its hash are published separately for review.
A governance terms change therefore re-locks a pre-change acknowledgement exactly
as it re-locks a standing consent: the stale acceptance is rejected, and the user
simply re-signs against the new terms to proceed. Liquid offers and deployments
where the progressive-risk gate is off are unaffected. The dapp's accept flow
stamps the live anchor automatically, so there is no extra step for users.

As part of the same change, the redundant on-chain digest-preview view for the
acceptance message was removed (the digest is a pure client-side computation the
wallet already performs when signing), recovering contract-size headroom that
the new field would otherwise have consumed.
