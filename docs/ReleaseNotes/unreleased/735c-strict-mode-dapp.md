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

While strict mode is on, accepting a mid-tier (liquid-but-not-blue-chip) pair
needs a fresh, deliberate per-pair acknowledgement that the ordinary acceptance
signature does not cover. The accept review now detects that block and offers a
one-click "record acknowledgement" action that rebuilds the exact risk-access pair
— including the NFT-rental prepayment token, which is now threaded through the
offer cache so a rental's lend leg keys off the right asset — and records it. The
acknowledgement is intentionally not atomic sign-and-use: on a deployment with an
opt-up cooldown it becomes effective only after that cooldown elapses, so the copy
never promises an immediate unblock; the user re-opens the offer to accept once
it's active. The block may also be the offer creator's requirement (the preview
reports the first failing party), which the acceptor's acknowledgement cannot
clear — that surfaces as a persisting block on re-open rather than a false success.

No contract change — every setter and view this uses already shipped with #728, so
there is no ABI or diamond-cut churn. This closes the last open item under the
#735 umbrella (the strict-mode toggle was the deferred piece called out in the
Risk Access page since #728 PR-2d).
