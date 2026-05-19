# Release Notes — 2026-05-20

Six threads in this batch — they form one coherent "harden the deploy
gate" arc that ran from a local-anvil deploy attempt surfacing an
EIP-170 size breach on `RiskFacet` (#66) to a full per-selector
ownership assertion baked into `DeployDiamond.run()` itself (#72), with
intermediate guardrails for facet-count drift (#69), selector coverage
(#71), the proactive `OfferFacet` split before its own size breach
(#67), and a pre-deploy gate that catches a committed-ABI file that
went missing (#75). The deploy pipeline now refuses to ship a Diamond
that would not register correctly on-chain — and every guardrail runs
in CI on the regular `forge test` cycle, not only at `--broadcast`
time. The next thread on this arc (#74) lifts these from "the script
asserts it" to "CI required-checks block a merge that would regress
them."

## Thread — RiskFacet split to clear the EIP-170 contract-size limit (PR #68)

A deploy attempt against a local anvil node surfaced a blocker: the
`RiskFacet` contract had grown 541 bytes past the 24,576-byte limit the
EVM enforces on any contract's deployed code. Past that limit a contract
simply cannot be deployed — so the protocol's diamond could not be stood
up on anvil, a testnet, or mainnet. The breach had gone unnoticed
because the test runner does not enforce the deploy-size rule the way a
real deployment does; only an actual broadcast deploy reveals it.

`RiskFacet` was carrying three loosely-related bodies of work — risk
maths, the regular health-factor liquidation path, and the newer
"internal match" liquidation path that settles two opposing loans
against each other. The internal-match path was self-contained, so it
was lifted out wholesale into a new `RiskMatchLiquidationFacet`. This is
a pure relocation — no behaviour changed; the same functions run the
same way, just hosted by a second facet of the same diamond. With that
weight removed, `RiskFacet` dropped to a comfortable margin under the
limit, and the new facet sits well within it too.

To stop this class of problem from recurring silently, the change also
adds a guardrail test that measures every facet's compiled size and
fails if any one is over the limit — so a future over-size facet is
caught in the normal test run instead of at deploy time.

A proactive follow-up — the `OfferFacet` contract is close to the same
limit though not yet over it — is tracked separately so it can get its
own focused review.

Closes #66.

## Thread — OfferFacet split into OfferCreateFacet / OfferAcceptFacet (PR #<n>)

`OfferFacet` had grown to 23,993 bytes of runtime code — only 583 bytes
under the 24,576-byte EIP-170 contract-size limit the EVM enforces. One
more feature on the offer surface would have breached the limit and made
the protocol's diamond undeployable — the same failure mode the
`RiskFacet` split (Issue #66) fixed reactively. This change addresses it
proactively, before the breach.

`OfferFacet` carried two self-contained bodies of work — offer
*creation* and offer *acceptance*. They were lifted into two facets of
the same diamond:

- **`OfferCreateFacet`** — creating lending and borrowing offers
  (including the Permit2 and cross-facet internal variants), and the
  per-user escrow lookup.
- **`OfferAcceptFacet`** — accepting offers, which initiates the loan,
  plus the rental-prepay and transaction-value helpers.

The cross-facet escrow-resolution wrapper that both halves rely on was
extracted into a small shared library (`LibUserEscrow`) so it lives in
one place rather than being duplicated.

This is a pure relocation — no logic changed. The same functions run the
same way; they are simply hosted by two facets instead of one. The offer
events and errors moved with their respective functions (their on-chain
signatures, and therefore their topic and selector hashes, are
unchanged, so indexers and consumers see no difference). After the
split, `OfferCreateFacet` is 10,839 bytes and `OfferAcceptFacet` is
15,982 bytes — both with a comfortable margin under the limit. The
diamond now cuts 36 facets.

Because the change is a mechanical split with no behavioural difference,
no functional-spec update is required.

Closes #67.

## Thread — Deploy verify exact-matches a recorded facet count (PR #70)

The post-deploy `verify` phase in the deploy shell scripts used to
sanity-check the diamond by asserting it carried *at least* 32 facets —
a hardcoded floor with a `>=` comparison. That check was both stale and
too loose: the diamond's facet set had since grown past 32 (the #66
`RiskFacet` split alone added one), so the literal was already wrong,
and a `>=` floor would silently pass a deploy that cut *too many* facets
or, after the floor drifted further out of date, one that cut too few.
A whole missing facet could slip through.

PR #70 makes the facet count a single source of truth. `DeployDiamond`
now records the authoritative count — the length of the cut list it
actually applied — into the per-chain `addresses.json` artifact, written
alongside the other deployment addresses after the broadcast completes
(never mid-deploy, so a revert in a later initialization step cannot
leave a facet count that disagrees with the recorded diamond and facet
addresses). The three deploy scripts — `deploy-chain.sh`,
`deploy-testnet.sh`, `deploy-mainnet.sh` — read that recorded value and
require the live `DiamondLoupe` count to match it *exactly*, failing the
verify step on any mismatch in either direction. No hardcoded facet
count remains in the shell scripts to drift.

A follow-up review also cleared two stale "32 facets" references that
the change had made wrong — explanatory comments in `DeployDiamond` and
the `verify`-row wording in the deployment runbook — so the deploy
tooling no longer states a count that contradicts the code.

This closes the gap left by the `.facetCount` check's predecessor: it
catches a missing whole *facet*. Catching a facet that is present but
missing some of its *selectors* is tracked separately (Issue #71).

Closes #69.

## Thread — Selector-coverage guardrail + a pre-deploy sanity gate (PR #<n>)

The Diamond routes each function call to a facet by selector, and that
selector→facet routing is hand-maintained — when a new external function
is added to a facet, a developer has to remember to add its selector to
the deploy script's cut list. If that step is missed, the function still
exists on the facet contract but the Diamond never routes it: every call
reverts with an opaque `FunctionDoesNotExist`, silently, until someone
hits it at runtime. The facet-count check added earlier (Issue #69)
catches a whole *facet* being left out; it cannot catch a facet that is
present but missing some of its *selectors*.

This change adds `SelectorCoverageTest`, a guardrail that closes that
gap. For every facet it reads the authoritative selector set straight
from the compiled artifact and asserts each one is actually cut into the
Diamond by the deploy script — failing the test run, and naming the
offending function, if any selector is unrouted. There is no second
hand-maintained list for it to drift against; the compiler's output is
the source of truth. The same test also checks that no two facet
functions collide on a 4-byte selector — a collision would make the
Diamond impossible to cut at all.

On its very first run the guardrail caught real, pre-existing drift on
`main`. The entire T-034 *Periodic Interest Payment* feature — the
permissionless settler entry point and its two companion views — had
been added to the repayment facet and wired into the test harness, but
never added to the production deploy script's cut list. Any real deploy
would therefore have shipped a Diamond on which that whole feature was
unreachable. A public pagination-limit constant on the dashboard facet
was unrouted for the same reason. Both have been wired into the deploy
cut list as part of this change, so the feature is now reachable on a
fresh deploy.

The deploy-time guardrails are now grouped under a `test/deploy/`
directory as a named "deploy-sanity" suite — this selector-coverage
check alongside the existing EIP-170 facet-size check (Issue #66) — and
both draw their facet list from one shared source so they cannot drift
onto different facet sets.

A new `predeploy-check.sh` script is the single pre-deploy gate. It runs
the build, the deploy-sanity suite, a lint pass over the deploy shell
scripts (syntax, optional shellcheck, a guard against stale LayerZero
deploy variables removed during the CCIP migration, and a check that
each script still orchestrates the Diamond deploy), and an
ABI-export-in-sync check that every committed per-facet ABI matches the
compiled contract. It is wired in as a preflight step inside all three
deploy scripts, so a deploy cannot proceed past a failing sanity check;
the mainnet script additionally runs the full regression suite, since a
mainnet deploy must not ship contracts whose tests are red. The script
is also runnable standalone for a dry pre-check.

A companion deploy-*integration* test — one that actually executes the
deploy and loupe-asserts the resulting Diamond, dynamically subsuming
the static checks — is tracked separately as Issue #72.

Closes #71.

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
