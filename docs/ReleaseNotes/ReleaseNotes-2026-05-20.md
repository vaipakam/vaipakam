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

## Thread — CI required-check workflow (PR #84)

Until this change every pull request that landed on `main` had been
verified only locally — the `Protect main` branch ruleset required a
pull-request review (with one approver and thread resolution) but had
no `required_status_checks` rule, so no automated CI gate ran. The
`release-notes-drift.yml` workflow was the only check that touched
pull requests, and it is deliberately non-blocking. That left a real
gap: a contributor — or the assistant — could open a PR with a
broken `forge build`, a regressed test, or a typecheck failure and
the only thing standing between it and `main` was the reviewer's
local-run discipline.

A new `ci.yml` workflow closes that gap. Three parallel jobs, split
into a fast required-check tier and a slower informational tier:

- **`contracts-fast`** runs `bash contracts/script/predeploy-check.sh`
  (no `--full`) — `forge build`, the deploy-sanity suite (the 12
  tests under `test/deploy/` covering EIP-170 facet sizes, selector
  coverage and ownership, the deploy-integration test), the deploy
  shell-script lint, and the per-facet ABI-in-sync check. ~30-60s.
  Designed to be the required-status-check (the follow-up that
  wires it into the `Protect main` ruleset is tracked as `74.B`).
  Catches the regression classes that would block an actual
  `--broadcast` deploy.

- **`contracts-full`** runs the same script with `--full`, which
  swaps the deploy-sanity suite for the full
  `forge test --no-match-path "test/invariants/*"` regression
  (2,012 tests). Matches what `deploy-mainnet.sh --full` invokes at
  its preflight step. Runs in parallel with `contracts-fast`,
  surfaces a red on the PR if any non-deploy-sanity test regresses,
  but is **informational only** — not in the required-status-check
  rule. The rationale: paying 10-15 min on every PR for the full
  suite when the deploy-blocker classes are already covered by the
  fast check is over-blocking; the full suite still runs so we see
  any drift, but a docs-only PR isn't gated on it. The release/*
  branch / `v*` tag-gated `mainnet-gate.yml` workflow (tracked as
  `74.C`) re-runs `--full` as a hard gate before any cutover, which
  is the line where the full suite matters.

- **`workspaces`** runs `pnpm install --frozen-lockfile` and then one
  explicit `pnpm --filter @vaipakam/<name> typecheck` step per
  workspace — `apps/keeper`, `apps/indexer` (which also runs the
  `check-event-coverage.mjs` guardrail), `apps/agent`, `apps/defi`
  (via `tsc -b --noEmit`), and `apps/www`. Listed explicitly rather
  than `pnpm -r typecheck` so deleting a workspace's `typecheck`
  script errors with "command not found" rather than silently
  no-opping. The vitest test step (`pnpm -r test`) is deliberately
  NOT included — the first CI run on this PR surfaced pre-existing
  test-setup failures in `apps/defi` (PublicDashboard + LoanDetails
  tests need a `ChainProvider` wrap, Issue #85). Once #85 is fixed,
  `pnpm -r test` joins this workflow in a small follow-up PR.

All three jobs are independent and run in parallel, with concurrency
serialisation per branch so a fresh push cancels the older in-flight
run. Foundry's artifact tree and incremental compile cache are keyed
content-based on `foundry.toml` + `remappings.txt` + the pinned
submodule SHAs (snapshotted into `.submodule-state` by a pre-step)
+ the contracts source tree, structured so the restore-key prefix-
matches the primary key (the v4 design after four Codex iterations).
Warm builds across same-config commits drop from cold ~10 min to
~90 s.

This PR ships the workflow in non-blocking form. The `Protect main`
ruleset will be updated in a follow-up PR (`74.B`) to add a
`required_status_checks` rule referencing **`contracts-fast`** and
**`workspaces`** (NOT `contracts-full` — that one is deliberately
informational, see the rationale above). Staging the rollout this
way lets the workflow demonstrate green runs on real PRs before
becoming a hard gate. Required-signatures, and the equivalent
keeper-bot main protection, are also follow-ups in the same
hardening arc.

Closes #74.

## Thread — Pre-audit branch hardening: mainnet-gate workflow + signed commits + keeper-bot protection (PR #<n>)

This change closes out the `74.C` follow-up arc from PR #84 — the
items deferred when the contracts CI was split into `contracts-fast`
(required, deploy-sanity only) and `contracts-full` (informational,
runs the full regression on every PR but doesn't gate merges).

Three changes ship together:

**Mainnet-gate workflow.** A new `.github/workflows/mainnet-gate.yml`
runs `bash contracts/script/predeploy-check.sh --full` on every push
to a `release/**` branch and every `v*` tag push. This is the same
script the mainnet runbook invokes at preflight step `[1b]`, so a
release-track commit cannot ship a state the deploy script would
reject. The split between routine PR CI (fast, sanity-only) and the
mainnet gate (slow, full regression) gives us the right cost/coverage
trade-off — small PRs aren't blocked on a 10-15 min regression, but
no release-track commit slips through without it. The workflow also
captures audit-trail evidence on tag pushes: resolved compiler
version + every facet's runtime bytecode size against the EIP-170
ceiling, logged into the workflow run record.

**Required signed commits on `main`.** The `Protect main` ruleset now
includes a `required_signatures` rule. The current pattern — squash-
merging via `gh pr merge --squash` — produces a GitHub-signed merge
commit on `main`, so the rule passes for every PR merge automatically.
Direct pushes (which were already blocked by branch protection)
remain blocked. The rule is a defence-in-depth backstop against a
hypothetical future bypass.

**Keeper-bot now public + protected.** The reference keeper bot
(`vaipakam/vaipakam-keeper-bot`) is flipped from private to public,
and an equivalent `Protect main` ruleset is created on it: the same
six rules as the monorepo's main protection, with the keeper-bot's
two CI jobs (`Typecheck`, `ABI shape sanity`) wired as required
status checks. The repo was always intended to flip public at
mainnet cutover; doing it now lets the equivalent branch-protection
free-tier kick in (GitHub's free branch-protection requires a public
repo, no GitHub Pro upgrade needed).

Combined with `contracts-fast` and `workspaces` being added to the
required-status-checks rule (the `74.B` change that landed alongside
PR #84's merge), the `Protect main` ruleset on the monorepo now
enforces eight independent gates on every merge:

- no branch deletion
- no force-push / non-fast-forward
- linear history (squash / rebase only)
- pull-request required, with thread resolution
- `contracts-fast` must be SUCCESS
- `workspaces` must be SUCCESS
- signed commits
- (`contracts-full` runs in parallel but is informational — see PR #84
  for the rationale)

The `release/**` branch family doesn't yet have its own ruleset —
that lands when the first release branch is cut. A small follow-up
will add a ruleset scoped to `refs/heads/release/**` that requires
the `mainnet-gate-full` context, so a force-push or unsanctioned
merge to a release branch cannot bypass the full-regression gate.
Tracked as part of the mainnet rollout workflow rather than as a
new code change, since the ruleset can't reference a context that
hasn't run at least once.

**Path-filter + timeout fix.** First exercise of the required-status-
checks rule on a docs/workflow-only PR (this PR itself) surfaced two
problems: `contracts-fast` and `contracts-full` ran on a PR that
changed no `.sol` files, and `contracts-fast`'s 15-minute timeout
ceiling cancelled the cold-cache run at exactly 15 m 15 s — before
the deploy-sanity step could complete. Two amendments fold in here:

- **Path filter** — a new lightweight `detect-changes` job runs
  first on every PR (~30 s — checkout + `git diff` between PR head
  and base). It exports two outputs (`contracts`, `workspaces`)
  signalling whether the diff touches paths each downstream job
  cares about. `contracts-fast`, `contracts-full`, and `workspaces`
  each `if:`-guard on the matching output. When the guard is false
  (a pure docs / workflow-only PR), the job is reported as
  "skipped" — and branch protection treats skipped-due-to-`if` as
  a SUCCESS for required-status-checks. So a docs-only PR sees all
  three downstream jobs go skipped → ready-to-merge without ever
  burning ~25 min of forge build.

  NOT using `on.pull_request.paths:` at workflow level because
  that would skip the WHOLE workflow — the required-check status
  never gets posted, and branch protection then blocks the merge
  forever waiting for it. The job-level `if:` pattern is the
  officially-blessed solution for this.

- **Timeout bumps** — `contracts-fast` 15 → 45 min,
  `contracts-full` 30 → 45 min. Cold-cache cold-clone forge build
  is dominated by submodule clone (~2-3 min) + viaIR compile
  (5-15 min); the earlier 15-min ceiling auto-killed runs that
  hadn't even reached the test phase. Warm-cache runs finish in
  2-3 min and never touch the new ceiling.

- **Detector hardening (Codex round-2 review caught three more):**

  - Workspace detector regex now includes `pnpm-workspace.yaml`
    (P1) — that file declares the workspace member list, so a
    change there could add / drop a workspace the typecheck steps
    target. Previously a workspace-membership edit would silently
    skip CI.

  - Contracts detector regex now includes `.gitmodules` (P2) — a
    submodule URL or path edit invalidates the foundry cache key
    (the `.submodule-state` pre-step) and rebuilds the graph, so
    contracts CI must re-run.

  - `detect-changes` is now itself a required-status-check on the
    `Protect main` ruleset (P1, the most important catch). Without
    this, a transient failure inside the detector (checkout
    timeout, runner exhaustion, network blip) would auto-skip the
    downstream `contracts-fast` / `workspaces` jobs via the
    `needs:` constraint — and branch protection treats
    skipped-due-to-`needs-failed` as success-equivalent, letting
    an un-validated PR through the merge gate. Making detect-
    changes required closes that hole: detector failure now turns
    red on the PR directly and blocks merge.

Closes #74 (the rest of the arc; the CI workflow itself landed in
PR #84).
