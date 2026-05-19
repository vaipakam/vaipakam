## Thread — Deploy-integration test + per-selector ownership assertion (PR #<n>)

The deploy-sanity suite already enforced two static guardrails — every
facet under EIP-170 (Issue #66) and every facet selector cut into the
Diamond by `DeployDiamond.s.sol` (Issue #71). Together they catch a
facet that is too large to deploy, a selector that's compiled but never
cut, and a 4-byte selector collision. What neither caught: a selector
that *is* cut but routed to the *wrong* facet — for example if a later
cut silently overwrote an earlier facet's selector slot. And neither
exercises the actual end-to-end `DeployDiamond.run()` codepath in CI;
both reason against the script's hand-maintained selector lists, not
against the diamond the script would build.

This change closes both gaps.

`DeployDiamond.run()` now contains a per-selector ownership assertion
that runs right after both halves of the diamondCut complete. It walks
the `cuts[]` array — the source of truth for what was just dispatched
— and for every selector in every cut requires that
`loupe.facetAddress(sel) == cut.facetAddress`. A mis-routed selector
reverts the entire broadcast before any post-cut initialization runs,
so no partial-state deploy is ever persisted. The assertion is cheap
(read-only loupe lookups against the just-built diamond) and exercises
the exact bijection the deploy is intended to produce.

A new integration test in the deploy-sanity suite invokes
`DeployDiamond.run()` end-to-end inside `forge test`, then loupe-walks
the resulting diamond for nine independent assertions:

- The deploy completes both with `admin == deployer` (the anvil / CI
  single-EOA path) and with `admin != deployer` (the testnet / mainnet
  handover path).
- The loupe's facet count matches the cuts-array length the script
  enforced internally.
- Every registered facet address is non-zero and has deployed bytecode.
- Every selector the live diamond's `facets()` walk reports resolves
  back to the same facet address via per-selector `facetAddress(sel)`
  — the "derive coverage from the real deploy, not a hand-maintained
  mirror" check.
- The diamond is unpaused, the treasury wired, the escrow
  implementation initialized, and (under handover) ownership and every
  role transferred to the admin while the deployer holds nothing.

Two small implementation enablers:

- `DeployDiamond` factored its env-var-reading entry into a separate
  `runWith(admin, treasury, deployerKey)` so the test passes args
  directly and avoids the parallel-test race on `vm.setEnv` (Foundry's
  default-on multi-threaded runner writes to process-wide env, so two
  tests calling `run()` concurrently with different admins would
  otherwise clobber each other mid-broadcast). Production
  `forge script` invocations still use `run()` and are unaffected.
- An opt-in `DEPLOY_SKIP_ARTIFACTS` env gate suppresses the post-deploy
  `addresses.json` writes when set. The integration test sets it so a
  `forge test` run does not clobber the committed
  `deployments/anvil/addresses.json`. Production deploys never set the
  flag and write artifacts as before.

This work also folds in the two `SelectorCoverageTest` follow-ups
flagged during Codex's re-review of Issue #75 (verifying selector
*ownership* not merely *presence*, and deriving the check from the
real deploy rather than the script's hand-maintained mirror) — both
are now authoritatively covered by the integration test against the
built diamond, no separate guardrail needed.

Closes #72.
