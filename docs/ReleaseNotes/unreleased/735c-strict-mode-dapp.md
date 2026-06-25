## Thread — Strict-mode toggle + in-flow mid-tier acknowledgement in the dapp (PR #<n>)

Follow-up to #728 (part of #735, part of #671). The reference dapp now exposes the
two pieces of the progressive-risk strict-mode workflow that were deliberately
held back until the recording path existed: the **strict-mode toggle** on the Risk
Access settings page, and **in-place recording of a mid-tier per-pair
acknowledgement** in the accept flow.

A vault can now opt into (or out of) strict mode directly. Enabling it is
risk-decreasing and immediate; disabling it is risk-increasing, so the page warns
when a recent disable is still inside its cooldown window — during which the
mid-tier acknowledgement requirement stays in force, exactly as the contract
enforces, so a vault can't drop strict mode and originate an un-acknowledged
mid-tier loan in the same breath.

While strict mode is on, a mid-tier (liquid-but-not-blue-chip) pair needs a fresh,
deliberate per-pair acknowledgement that the ordinary signature does not cover —
and the contract enforces this at BOTH offer creation and accept. Both flows now
detect that block and offer a one-click "record acknowledgement" action that
rebuilds the exact risk-access pair — including the NFT-rental prepayment token,
now threaded through the offer cache so a rental's lend leg keys off the right
asset — and records it. The create form blocks submit until the acknowledgement is
effective; the accept review offers the recorder when the connected wallet is
itself the blocked party. Both read the contract's own
`midTierStrictBlocked(wallet, pair)` predicate, so an accept block that is actually
the offer CREATOR's missing acknowledgement (the preview reports the first failing
party) is shown as the creator's requirement rather than inviting the acceptor to
spend gas on an acknowledgement that won't clear it.

The acknowledgement is intentionally not atomic sign-and-use: on a deployment with
an opt-up cooldown it becomes effective only after that whole window (which a
deployment may configure up to 30 days), so the copy never promises a quick
unblock; the user re-opens the offer (or waits out the create gate) once it's
active.

No contract change — every setter and view this uses already shipped with #728, so
there is no ABI or diamond-cut churn. This closes the last open item under the
#735 umbrella (the strict-mode toggle was the deferred piece called out in the
Risk Access page since #728 PR-2d).
