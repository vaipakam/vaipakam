## Thread — Progressive risk access: acceptor-side gate + #662⇄#671 unification (PR #<n>)

Phase 2 of #671 (#728), PR-2a. The progressive-risk gate now also runs on the
party **accepting** an offer, not just the party that created it. When an offer
is accepted directly, the protocol checks the acceptor's vault tier against the
offer's pair (the riskier of the two legs governs) at loan initiation — so a
default-tier vault can't be steered into accepting an illiquid or mid-tier
position it never opted into. The creator was already gated when the offer was
posted (phase 1); this closes the other side.

Crucially, the acceptor does **not** have to sign a second consent. The
anti-phishing acceptance binding (#662) already makes the acceptor
cryptographically acknowledge every illiquid asset in the exact offer they're
taking, and the protocol verifies that acknowledgement at the same loan-init
point. That signed, per-acceptance acknowledgement is a stronger and more
specific consent than a standing per-pair record, so it now **satisfies** the
progressive-risk illiquid-consent requirement for the acceptor automatically.
The net effect: an acceptor who has opted their vault up to the right tier can
accept an illiquid pair with the single acceptance signature they already make —
no separate per-pair consent step. Only the vault tier still has to cover the
pair.

As with the rest of #671, the whole check is behind the off-by-default
`riskAccessGateEnabled` master switch, and the lender-sale-vehicle exit stays
exempt. The keeper-driven matching path is deliberately not gated here — it
re-asserts each paired offer against its own creator at the matcher, which lands
in a following PR. Part of #671 / #728 (does not close them).
