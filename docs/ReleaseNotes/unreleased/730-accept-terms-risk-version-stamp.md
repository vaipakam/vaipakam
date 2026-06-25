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

The acceptance message now carries the risk-terms version it was signed against,
and the gate requires that version to be current for the acknowledgement to
stand in for a consent. A governance terms change therefore re-locks a
pre-change acknowledgement exactly as it re-locks a standing consent: the stale
acceptance is rejected, and the user simply re-signs against the new terms to
proceed. Liquid offers and deployments where the progressive-risk gate is off
are unaffected. The dapp's accept flow stamps the live version automatically, so
there is no extra step for users.

As part of the same change, the redundant on-chain digest-preview view for the
acceptance message was removed (the digest is a pure client-side computation the
wallet already performs when signing), recovering contract-size headroom that
the new field would otherwise have consumed.
