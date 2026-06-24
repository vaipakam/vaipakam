## Thread — Progressive risk access: frontend wiring (PR #<n>)

Phase 2 of #671 (#728), PR-2e. The dapp now surfaces the self-sovereign
progressive-risk controls and warns a user before they sign an accept the
risk-access gate would reject.

A new **Risk Access** settings page lets a connected vault see and manage its
risk posture: its currently-effective tier (which reflects the on-chain
read-time re-lock — a raised tier still cooling down, or one made stale by a
risk-terms-version bump, shows as the safer effective tier until it settles or is
re-affirmed), choose its tier (Blue-chip only / Broad liquid / Illiquid-custom),
and toggle strict mode. The page makes the product posture explicit: every vault
starts at the safest tier and opts up to riskier tiers only by its own choice —
the same blue-chip-default, opt-in-with-consent model the contracts enforce. It
also shows whether the gate is actually being enforced on the current deployment
(the master switch).

The accept flow gains a **risk preflight**: when a user reviews an offer, the
dapp asks the read-only on-chain preview whether their wallet would be blocked by
the risk-access gate and, if so, shows why — tier too low, an illiquid pair that
needs a one-time per-pair consent, or (in strict mode) a mid-tier pair that needs
an explicit acknowledgement — instead of letting the transaction fail with an
opaque revert. The preview already accounts for the master switch, so the banner
is silent on deployments where the gate isn't enforced, and the on-chain gate at
loan initiation remains the real boundary; this is purely a UX guard.

Collecting the per-pair consent / acknowledgement inline at accept time (rather
than pointing the user to manage their risk access) is a noted follow-up — it
needs the offer's prepayment-token field threaded through the offer cache so the
exact pair identity can be reconstructed client-side. Part of #671 / #728 (does
not close them).
