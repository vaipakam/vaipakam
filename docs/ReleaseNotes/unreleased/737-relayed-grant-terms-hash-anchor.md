## Thread — Relayed risk-access grants bind the unguessable terms anchor (PR #<n>)

Closes #737. Part of the #671 progressive-risk umbrella, and the sibling of #730:
where #730 re-anchored the acceptance acknowledgement to an unguessable, commit-
revealed risk-terms secret, this change closes the same root weakness on the
**relayed (gasless) self-sovereign grant** path.

A vault can authorise a risk-access change — a tier opt-up, an illiquid-pair
consent, a strict-mode toggle, or an explicit mid-tier acknowledgement — by signing
an EIP-712 message that a relayer later submits on its behalf. Previously each of
those signed grants was anchored to the **predictable numeric terms version**
(`current + 1`). Because that next version is guessable, a malicious interface could
induce a vault to pre-sign a grant for a terms version that does not exist yet, hold
it, and have a relayer submit it the instant governance enacted the next terms
change — silently re-establishing freshness against terms the user never actually
reviewed. On the illiquid-consent path that pre-signed grant could re-arm the
standing-consent branch of the accept gate and bypass the #730 acknowledgement
re-lock entirely.

Every relayed grant now binds the **unguessable `currentRiskTermsHash`** — the same
secret anchor the acceptance acknowledgement binds, published only at the atomic
commit-reveal activation of a terms change — instead of the version counter. A
relayed grant is honoured only if the anchor it names is the live one, so a grant
for a future terms epoch cannot be crafted at all (the future anchor is unknowable
until activation), and a grant signed against the previous epoch is refused after a
change just as before. A grant naming the zero anchor (the pre-first-reveal state,
where no real terms epoch exists yet and zero is trivially guessable) is also
refused: relayed grants carry no freshness meaning until a real anchor has been
revealed, which reinforces that the gate must not be enabled before that reveal.

The strict-mode toggle grant is included in the change even though it is not part of
the standing-consent bypass, because all four relayed grants share one signature-
consumption chokepoint; binding the anchor there closes the pre-sign vector for the
whole surface and avoids leaving one grant type still pre-signable.

This is security hardening with **no behaviour change for any live deployment**: the
progressive-risk gate is off by default and the platform is pre-live, so no relayer
path is in production. It is, however, a hard **pre-condition to enabling the gate**
on any network — especially a timelock-governed mainnet — and should land before
`riskAccessGateEnabled` is ever turned on. The four `*BySig` entry points keep their
names; their EIP-712 struct shape changes (a `bytes32 termsHash` field replaces the
`uint64 termsVersion`), so the relayer/ABI surface is re-exported alongside.
