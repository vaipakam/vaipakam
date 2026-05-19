## Thread — Pre-deploy check now catches a *missing* committed ABI (PR #<n>)

The pre-deploy sanity gate already verified that every committed
per-facet ABI matched the compiled contract — but it only looked at the
ABI files that were *present*. If a required ABI file was missing
entirely — a facet added without committing its ABI, or an ABI file
deleted — the check would loop over the remaining files, find them all
in sync, and pass. The deploy would then proceed, leaving consumers
without bindings for a selector that is live on the diamond. (Surfaced
by Codex's re-review of the selector-coverage guardrail work.)

The pre-deploy check now cross-references the ABI directory against the
authoritative list of facets the export script is configured to emit.
If any expected ABI file is absent, the check reports it: a hard failure
for the in-monorepo frontend ABIs, an advisory warning for the
separately-deployed keeper-bot ABIs (consistent with how stale-ABI drift
is already treated for each).

Two related selector-guardrail gaps from the same review — verifying a
selector is routed to the *correct* facet, not merely routed somewhere,
and deriving the coverage check from the real deploy rather than a
hand-maintained mirror — are deferred to the deploy-integration test
(Issue #72), which loupe-asserts the actually-built diamond and closes
both authoritatively.

Closes #75.
