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

Four further hardening passes tighten the boundaries of that unification:

- **The offer creator is re-checked at accept, not just at create.** An offer
  posted while the gate was off, or whose creator has since dropped their tier,
  revoked an illiquid-pair consent, or fallen stale after a terms-version bump,
  is now rejected when someone tries to accept it — the create-time snapshot can
  no longer go stale and let an under-qualified position originate.
- **Only a genuinely-acknowledged asset can stand in for a per-pair consent.**
  The acceptance acknowledgement substitutes for the standing illiquid consent
  *only* for the exact assets the anti-phishing check actually validated. An
  asset that counts as illiquid for a subtler reason — a normally-liquid token
  whose on-chain depth has collapsed, or a rental's illiquid prepayment token —
  falls back to requiring an explicit standing consent, so a hand-crafted
  acknowledgement can't wave one through.
- **The buyer of a loan-sale is gated too.** When a lender sells their position,
  the exiting seller stays exempt, but the incoming buyer is now checked against
  the underlying loan's assets — a default-tier buyer can't acquire an
  illiquid-backed lender position without opting into that risk.
- **The frontend can pre-flight the gate.** A read-only preview tells the app,
  before a wallet ever signs, whether a given party would be blocked and
  why (tier too low vs. illiquid pair needs consent), so the accept button can
  guide the user instead of letting the transaction fail on-chain.

One related gap is deliberately left for a small follow-up: binding the
acceptance acknowledgement itself to the live risk-terms version (so a very
old, long-lived acceptance signature can't be replayed after a terms bump). It
needs a versioned field added to the anti-phishing acceptance structure, which
is tracked separately; the existing freshness guard on the vault tier already
narrows the window in the meantime.

As with the rest of #671, the whole check is behind the off-by-default
`riskAccessGateEnabled` master switch, and the lender-sale-vehicle *seller* stays
exempt. The keeper-driven matching path is deliberately not gated here — it
re-asserts each paired offer against its own creator at the matcher, which lands
in a following PR. Part of #671 / #728 (does not close them).
