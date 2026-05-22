# Release Notes — 2026-05-20

Nine threads in this batch — they form one coherent "harden the
deploy gate" arc that ran from a local-anvil deploy attempt surfacing
an EIP-170 size breach on `RiskFacet` (#66) to a full required-check
CI gate on `main` (#74), with intermediate guardrails for facet-count
drift (#69), selector coverage (#71), the proactive `OfferFacet` split
before its own size breach (#67), a pre-deploy gate that catches a
committed-ABI file that went missing (#75), a per-selector ownership
assertion baked into `DeployDiamond.run()` itself with a CI integration
test (#72), and a CI-hygiene follow-up that serializes the two
contracts jobs so the cold-cache forge build is paid for only once per
PR. The deploy pipeline now refuses to ship a Diamond that would not
register correctly on-chain, every guardrail runs in CI on the regular
`forge test` cycle (not only at `--broadcast` time), AND CI is now a
required-status-check on the `Protect main` ruleset rather than a
manual-discipline promise. Combined with required-signed-commits and
the keeper-bot's equivalent protection (the rest of #74), the
`Protect main` ruleset on the monorepo now enforces eight independent
gates on every merge, with a tag-gated `mainnet-gate.yml` workflow
standing by to re-run the full 2,012-test regression as a hard gate
before any cutover.

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

---

**Second wave — same day, follow-on hygiene.** After the deploy-gate
arc shipped, a tail of ten threads followed the same day: CI build
serialisation (one cold forge compile per PR), the closing wave of
Slither / Code-Scanning HIGH-severity sweeps (#109 + #148 phases 2
+ 4), the `vaipakam-archive` D1 topology doc (#149), workspace
transitive-dep security pins + the ws-1.1.4 follow-up on the
lz-watcher (#135 × 3), the Dependabot scope-narrow inside
`contracts/lib/*` (#153), the consolidated operator handbook
`docs/internal/ProjectProcedures.md`, the deletion of the dead
`alpha/` archive, and the drop of the aspirational `deploy-workers.yml`
+ 3 GitHub Environments that were never used. Same theme — close
the security backlog cleanly so the canonical-limit-order work that
starts tomorrow opens onto a clean repo.

## Thread — Serialize contracts CI jobs to halve cold-cache build cost (PR #<n>)

The CI workflow that landed in #84 + #86 ran `contracts-fast` and
`contracts-full` in parallel. Both jobs invoked `predeploy-check.sh`,
which itself runs a cold `forge build` before testing — so a typical
fresh PR paid for the same compile twice on two parallel runners.
Compute is free on public repos, so this didn't cost a dollar, but
the duplicate work was visible as wasted CI minutes and would matter
materially if Vaipakam ever moved to a self-hosted runner (one
machine, sequential builds, full cost on each duplicate).

This change serializes the two jobs: `contracts-full` now
`needs: contracts-fast`. The cache mechanics that make this efficient:

- `actions/cache` saves the cache at job END (post-action hook fires
  when the job finishes — `out/` + `cache/` get persisted under the
  content-based key contracts-fast just populated).
- A subsequent job in the SAME workflow run that hits `actions/cache`
  with the same key restores from that just-saved entry.
- contracts-full now restores contracts-fast's freshly-built
  artifacts, so its own `forge build` step hits warm and skips
  re-compile entirely.

Critical-path latency to merge-ready is UNCHANGED: contracts-fast is
the required-status-check gate either way. The only observable
difference is that contracts-full's wall-clock visibility on the PR
arrives ~5-10 min later than before — it's informational only, not
gating, so a slight delay there doesn't slow merges.

A bonus property of the serial design: if contracts-fast fails, the
`if: needs.contracts-fast.result == 'success'` guard skips
contracts-full entirely. Fail-fast — no point burning compute on a
full regression when the build itself is broken.

The `contracts-full` timeout drops from 45 → 30 min in this change.
With warm-cache restore the cold-build minutes are no longer in this
job's budget; 30 min leaves comfortable headroom for the full
regression itself (~5-15 min observed) plus runner variability.

Closes #74 (the optional CI-hygiene optimisation; the required-check
gate landed earlier in this arc).

## Thread — Slither HIGH-severity sweep (PR #<n>)

Closed every open HIGH-severity Code Scanning finding from the
informational Slither workflow. None of the 16 alerts was a real bug —
each was confirmed a false positive given Vaipakam's intentional
architecture — and the audit-prep deliverable was specifically to
document that classification inline so a human auditor can re-verify
the reasoning at the call site in seconds rather than re-deriving it
from scratch.

The sweep took two forms. First, a new `contracts/slither.config.json`
sets a `filter_paths` regex covering every vendored library the project
ships unmodified (`openzeppelin-contracts-upgradeable`, the two
Chainlink trees, `chainlink-local`, `diamond-3-hardhat`, `forge-std`),
plus `exclude_dependencies: true`. This closes the three findings whose
analysis surface was code we don't author: OpenZeppelin's
`TimelockController` constructor, `Math.mulDiv`, and `Base64._encode`.
Re-analyzing audited library bytecode would have us "fix" code that the
library's own audit already cleared. The Slither workflow was updated
to pass the config via `slither-config: contracts/slither.config.json`.

The remaining thirteen findings sit in Vaipakam-authored code and were
each suppressed with a `// slither-disable-next-line <detector>` line
**carrying a one-paragraph rationale comment** explaining why the
flagged pattern is intentional and what would break if it were
"fixed." The suppressions cluster into five buckets: the
`safeTransferFrom(payer, ...)` pull pattern used by every keeper-relay
path (the canonical Aave/Compound/Permit2 shape; the upstream
`IERC20.approve(diamond, ≥amount)` is the consent gate); native-ETH
forwards to admin-set state-variable recipients (`messenger`,
`treasury`, both rotated only via owner-only setters that, per the
mainnet-deploy gates, end up multisig→timelock-controlled); the
`broadcastGlobal` fan-out loop's per-iteration `sendMessage` (bounded
by a cumulative `spent` counter and `msg.value` pre-check, so the
`msg-value-loop` heuristic is over-conservative); the
`retryStuckDelivery` owner-only `nonReentrant` path that writes state
after an external call (the textbook safe pattern Slither's
single-modifier dataflow cannot see); and the `_buildDescription` /
`_buildAttributes` token-URI builders whose `abi.encodePacked` output
is human-readable JSON for marketplace display (never hashed, never
used as a key, so the encode-packed-collision detector doesn't apply).
Closes #109.

## Thread — ops/lz-watcher ws security pin (follow-up to #135)

Closed the last open Dependabot alert from the issue #135 audit-prep
sweep — `ws < 8.20.1` (GHSA-58qx-3vcg-4xpx, uninitialized-memory
disclosure) — by adding an `overrides` clause to
`ops/lz-watcher/package.json` pinning `ws` to `^8.20.1`.

The same advisory was fixed for the pnpm workspace in PR #137 via
`pnpm.overrides`, but `ops/lz-watcher` is intentionally outside that
workspace (the workspace yaml notes it's "a Cloudflare Worker but
deliberately separate for trust-boundary reasons" — internal ops
Telegram surface, distinct from the public-facing keeper Worker).
That separation means the pnpm-tree fix didn't reach it, so this
follow-up applies the equivalent fix in lz-watcher's own npm tree.

After `npm install` resolves the override, both vulnerable ws paths
(viem → ws 8.18.3 and miniflare → ws 8.18.0) consolidate to a single
ws@8.20.1; `npm audit` reports 0 vulnerabilities. `tsc --noEmit`
typechecks clean.

With this PR merged and the Dependabot rescan of the alpha
deletions in #143 settled, the open-alert count for the repo drops
to **zero** — the audit-prep deliverable for issue #135 is fully
closed.

## Thread — Delete the dead alpha/ archive (PR #<n>)

Removed the `alpha/` archive — the v1 React/Vite frontend and the
first-generation Cloudflare-Worker HF watcher that pre-dated the
Stage 3 source-tree refactor — whose `package-lock.json` files had
been the source of seven open Dependabot security alerts. The
deletion had been scheduled in `pnpm-workspace.yaml`'s archive
block ("Scheduled for full removal once the new architecture has
been live for a few weeks without a fallback being needed (single
`rm -rf alpha/` commit)"); this PR is that commit.

The live successors are `apps/defi` (in place of `alpha/frontend`)
and `apps/keeper`/`apps/indexer`/`apps/agent` (the Stage-3 Worker
split that subsumed `alpha/hf-watcher`). The Cloudflare Workers
that the archive sources last built — `vaipakam-alpha` and
`vaipakam-hf-watcher` — are operator-managed and have to be
undeployed via the Cloudflare dashboard separately; that's a runtime
action, not a repo change. If a fallback is ever needed,
`git checkout <this-commit>~ -- alpha` restores the tree byte-for-
byte from history.

The `pnpm-workspace.yaml` comment block that documented the archive
was replaced with a one-paragraph pointer to this commit so the
workspace layout doc stays self-describing.

Closes 7 Dependabot alerts (6 on `alpha/frontend/package-lock.json`,
1 on `alpha/hf-watcher/package-lock.json`).

What this PR does **NOT** touch:

- `ops/lz-watcher/` stays — it is **active production tooling**, a
  5-minute-cron Cloudflare Worker that watches the LayerZero V2 surface
  for DVN-count drift, OFT mint/burn imbalance, and oversized VPFI flow
  (alerts to the internal ops Telegram channel). Its single Dependabot
  alert (`ws < 8.20.1`) is the same advisory the workspace overrides in
  PR #137 closed for the pnpm tree — it will be addressed in a separate
  pass that extends the override or the Dependabot scope to that Worker.
- `ops/{subgraph,tenderly}/` stay — both are operationally live.

Closes part of #135 (Phase 4 of 4 — alpha only; the lz-watcher alert
is the one remaining open after this lands, tracked as a follow-up).

## Thread — Workspace transitive-dependency security pins (PR #<n>)

Closed 17 open Dependabot HIGH/MEDIUM CVE alerts on the root
`pnpm-lock.yaml` by adding three `pnpm.overrides` entries to the
workspace root `package.json`. Each pin is the minimum patched
version the upstream advisories require; the override route was
needed because every flagged package is a *transitive* dependency
that no direct upgrade in `apps/*` or `packages/*` would reach.

The three pins. **`axios ^1.15.2`** closes 15 of the 17 alerts —
the package is pulled in three different ways (the Push Protocol
SDK in `apps/agent` + `apps/keeper`, and the Coinbase CDP SDK via
the wagmi → connectkit chain in `apps/defi`) and the same set of
nine CVE advisories (CRLF injection, prototype-pollution gadgets,
NO_PROXY bypasses, etc.) applies in all paths. **`ws@^8.0.0 →
^8.20.1`** closes a single uninitialized-memory-disclosure
advisory (GHSA-58qx-3vcg-4xpx) in the ethers → `ws` path; the
selector form keeps the legacy `ws@7.x` paths used by other code
untouched. **`brace-expansion@^5.0.0 → ^5.0.6`** closes a
ReDoS-style range-DoS advisory in the v5 line; the v1 path
(`brace-expansion@1.1.14` pulled by `eslint → minimatch`) is
outside the vulnerable range and stays put — again by selector
scoping.

The fix is structural, not bytecode-affecting: nothing in
`contracts/` was touched, and all six TypeScript workspaces
(`@vaipakam/defi`, `agent`, `keeper`, `indexer`, `ui`, `www`)
typecheck clean against the resolved lockfile. The remaining 349
Dependabot alerts on the repo split into two non-fixable
populations that Phase 3 of issue #135 handles separately:
343 alerts in vendored Solidity submodules under
`contracts/lib/*` (the JS/Go tooling embedded in those repos is
never compiled or run as part of the Vaipakam build, so the
advisories don't reach Vaipakam-deployed code) and 6 alerts in
the deprecated `alpha/frontend/` (its sunset is tracked
separately).

Closes part of #135 (Phase 2 — root workspace).

## Thread — Close the 6 surviving HIGH-severity Code Scanning alerts (PR #<n>)

Closed the six HIGH-severity Code Scanning alerts that were still open
after PR #136's Slither sweep — two Slither HIGHs and four CodeQL HIGHs.
This is Phase 2 of issue #148 (Code Scanning queue triage).

### Slither (2 HIGHs)

Both alerts were `msg-value-loop` on `VaipakamRewardMessenger.broadcastGlobal`.
PR #136 had placed a `// slither-disable-next-line` directive on the
inner `sendMessage{value: fee}` statement, which silenced the
per-statement match but not the function-level one Slither also raises
when `msg.value` is read inside any for-loop. Replaced the next-line
directive with a `// slither-disable-start msg-value-loop` /
`// slither-disable-end msg-value-loop` block wrapping the whole
function, keeping the existing rationale comment in place so the
audit trail is preserved at the call site. The pattern is intentional
(bounded fan-out, cumulative `spent` counter + `msg.value` pre-check),
and the per-statement suppression for `arbitrary-send-eth` /
`msg-value-loop` stays inside the loop body for redundancy.

### CodeQL (4 HIGHs)

All four flagged vendored OpenZeppelin Certora verification tooling
under `contracts/lib/openzeppelin-contracts-upgradeable/certora/` —
exactly the same false-positive class the Slither
`filter_paths` already excluded. Added a CodeQL equivalent: a new
`.github/codeql/codeql-config.yml` with `paths-ignore: contracts/lib/**`,
wired into `.github/workflows/codeql.yml` via the `config-file` input
on the `init` step. After this lands the four CodeQL alerts auto-close
on the next CodeQL run.

After this PR merges, the Code Scanning HIGH-severity count drops from
6 to 0; the remaining triage work (Phases 3-5 — 187 Slither MEDIUMs,
215 Slither LOWs, 154 uncategorised Slither informational findings,
6 CodeQL MEDIUMs) continues under #148.

## Thread — Close the 3 highest-value Slither alerts in-source + bulk-dismiss ~110 lower-risk findings (PR #<n>)

Continuation of issue #148's Code Scanning queue triage. Phase 2 (PR
#150) closed the 6 surviving HIGH-severity alerts. Phase 3 (a bulk
gh-api pass) dismissed 381 alerts across 6 rule classes. Phase 4 —
this PR — handles the remaining 164 by tier.

The three highest-value findings are security-relevant signals the
rule-class shape couldn't blanket-dismiss; they get **in-source**
`// slither-disable-start/end` directives so the audit trail lives at
the call site, not in the GitHub Code Scanning UI alone.

- `pyth-unchecked-publishtime` + `pyth-unchecked-confidence` on
  `OracleFacet._validatePythCrossCheck`. Slither's detector matches
  `getPriceUnsafe(` and walks only the next ~5 statements looking for
  `.publishTime` / `.conf` reads. Our checks sit ~20 lines lower
  because we snapshot the Pyth Price struct first (defensive copy
  out of the try/catch frame). Both gates are load-bearing — the
  publishTime gate is the staleness check (`block.timestamp >
  snap.publishTime + maxStale`), the confidence gate enforces
  `confBps > confMax`. Both are tested in OracleCrossCheckTest. The
  paired `slither-disable-start/end` block wraps the function with a
  rationale comment so the next reviewer sees the intent at the
  call site.

- `chainlink-feed-registry` on `OracleFacet._registryFeed`.
  Slither's detector warns the Feed Registry is only deployed on
  Ethereum Mainnet — true, and handled by design: the
  `LibVaipakam.Storage.chainlnkRegistry` slot is `address(0)` on
  every non-mainnet chain (see the storage-slot comment at
  `LibVaipakam.sol:1629`). Every caller of `_registryFeed` first
  guards with `if (registry != address(0))`, so on L2s the registry
  branch is never reached. The single-line suppression with the
  rationale block above it documents that this is an optional
  fast-path, not a requirement.

Beyond those three, the bulk pass dismisses every alert in seven
lower-risk rule classes — divide-before-multiply (17),
unused-return (30), unused-state (21), incorrect-equality (17),
reentrancy-events (17), reentrancy-benign (5),
missing-inheritance (5), redundant-statements (7) — each with a
rule-class rationale comment so an auditor can re-verify any of
them in seconds. Spot-checked three per class against the actual
source before classifying; none of the sampled sites exhibit the
underlying bug pattern Slither's heuristic was originally written
for.

What this PR explicitly does NOT touch (deferred to a follow-up
per-site review pass under #148 Phase 5): `missing-zero-check`
(21), `write-after-write` (2), `dead-code` (5), `assembly` (14).
Those rule classes need real reads of the affected functions, not
blanket dismissal — `missing-zero-check` in particular has been the
source of real DeFi bugs in other projects and we'd rather over-
verify than over-dismiss.

After this PR lands the Code Scanning queue drops from 164 open
Slither alerts to roughly 42, all in the four deferred classes
above. Refs #148.

## Thread — Document the shared `vaipakam-archive` D1 topology (PR #<n>)

Closed issue #149 by making the existing D1 topology explicit in the
per-Worker READMEs, the staging-state doc, and `CLAUDE.md`. The
investigation that gated this card found that the "missing migrations"
gap the card originally flagged does not actually exist:

The three plain Workers (`apps/indexer`, `apps/keeper`, `apps/agent`)
all bind to a **single shared D1 database** — `vaipakam-archive`,
database_id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`, the staging
database the Cloudflare staging deploy uses (see
`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md` §3 for the
staging-vs-primary split). Every table any of the three Workers
reads or writes — keeper writes
`user_thresholds`/`notify_state`/`telegram_links`/`liquidity_confidence`/`oracle_snapshot_state`
and reads `loans`/`offers`; agent writes
`user_thresholds`/`notify_state`/`telegram_links`/`loans`/`diag_errors`/`diag_legal_holds`/`diag_legal_hold_audit`
— is already covered by the existing `apps/indexer/migrations/`
directory. The schema is fully tracked; the gap was purely
documentation.

This PR records the topology in three places. Each per-Worker README
gets a new "D1 — shared `vaipakam-archive`" subsection explaining the
binding, the tables that Worker touches, and the rule that schema
changes land in `apps/indexer/migrations/` even when they're for
tables the indexer itself doesn't write. The `CLAUDE.md`
"Cloudflare D1 schema discipline" section codifies the
"every schema change is a migration file under `apps/indexer/`" rule
so the convention survives contributor turnover. The staging-state doc
replaces its stale "migrations not yet applied — will run from
`apps/agent/`" note with the current reality (single shared D1,
indexer-owned migrations).

`ops/lz-watcher`'s separate `vaipakam-lz-alerts-db` D1 is also called
out — that one stays separate by design (trust-boundary isolation for
internal ops alerts).

## Thread — Suppress Dependabot scans inside vendored `contracts/lib/*` (PR #<n>)

Closed a Dependabot policy gap that `CLAUDE.md` already documented but
the config didn't actually enforce. Within a single day five
Dependabot PRs (#138 / #139 / #140 / #141 / #142) landed against
`contracts/lib/diamond-3-hardhat/` — exactly the vendored Solidity
submodule path the existing "Dependabot — off-chain only" header
comment named as *not covered, on purpose*.

The root cause is a documented Dependabot quirk: the `directory:`
field on a `npm` updates block scopes **version-update** PRs only.
Vulnerability-driven **security-update** PRs walk every
`package-lock.json` / `pnpm-lock.yaml` in the repo regardless of that
config. So a root-only `directory: "/"` block silences version-update
PRs against the vendored trees, but the moment a CVE surfaces in any
transitive dep buried in those subtrees, Dependabot raises a PR
against the vendored manifest anyway.

The fix this PR lands is a single `package-ecosystem: "npm"` block
with `directories: ["/contracts/lib/**"]`,
`ignore: [{ dependency-name: "*" }]`, and
`open-pull-requests-limit: 0`. The glob form catches every manifest
under the wildcard recursively — across the 13 nested
`package.json` files that exist today under `contracts/lib/`
(diamond-3-hardhat, forge-std, the openzeppelin-contracts-upgradeable
tree including its own nested `lib/openzeppelin-contracts/` and
`scripts/solhint-custom/` submodules, the chainlink-ccip
`chains/evm/` JS tooling, and the chainlink-evm
`/` + `contracts/` pair) — without us having to enumerate each
path and stay current as submodules bump. The `ignore` + zero-PR
limit pair disables BOTH the version-update and the
security-update scanners for every matched manifest. The header
comment now explains the security-vs-version scanner distinction
inline so the next contributor doesn't trip on the same trap.

After this lands the five offending Dependabot PRs (#138–#142) are
closed individually with a pointer to issue #153. Closes #153.

## Thread — `docs/internal/ProjectProcedures.md` — consolidated operator handbook (PR #<n>)

Adds a single human-readable operator handbook at
`docs/internal/ProjectProcedures.md` that captures every git / PR / CI
/ project-board / release-notes convention currently in force. The
content has accumulated across `CLAUDE.md`, agent memories, and ad-hoc
session conversations; this file is the canonical reference for it.

The new doc and `CLAUDE.md` are deliberately complementary, not
redundant:

- `CLAUDE.md` is **AI-instruction-shaped** — "do this when working".
  Lives at the repo root so the agent picks it up automatically.
- `docs/internal/ProjectProcedures.md` is **reference-shaped** — "this
  is how we work here". Sectioned for top-to-bottom reading or
  spot-lookup. Includes runnable checklists for "opening a PR",
  "picking up a card", "post-merge sweep", and the eight `Protect
  main` gates.

Twelve sections: repository topology, git procedures, PR workflow,
post-merge sweep, project board (`@vaipakam-labs`) discipline,
release notes + FunctionalSpecs, CI + branch protection, issues +
labels, tooling reference, pre-audit hardening current-state summary,
living-doc rules, and project-specific conventions worth knowing
(the "weird from outside but deliberate" rules + the gotchas).

The doc explicitly distinguishes what lives in the repo (procedures
that need to survive across machines / contributors / time) from
what lives only in agent memory (tool-side conventions like the
polling-launch hygiene or the graphify Solidity patch re-application
flow). Without that boundary, a future contributor sees ambient
discipline that isn't actually written down.

No code change. Pure docs.

## Thread — Drop aspirational deploy-workers.yml + 3 GitHub Environments (PR #<n>)

Removed `.github/workflows/deploy-workers.yml` and the three unused
GitHub Environments (`mainnet`, `testnet`, `dev`). The workflow was
designed to run `wrangler deploy` from CI on every push to `main`, but
it never had the Cloudflare credentials it needed (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` — neither set at the repo level nor inside any
environment). The result was that every PR touching `apps/defi/` or
`ops/hf-watcher/` quietly failed the deploy job, and every other PR
"succeeded" only because the path-filter short-circuited the job
before it could attempt the broken deploy.

The real deploy path is `wrangler` on the operator's local machine —
authenticated by an interactive `wrangler login` whose credentials
live in the operator's browser session, never in a shared service.
Adding a long-lived Cloudflare API token to GitHub purely to enable
CI deploys we don't actually use would have introduced security debt
(a leaked PAT is a deploy-to-our-domain attack vector) without
delivering any operational benefit.

What this changes:

- `.github/workflows/deploy-workers.yml` deleted.
- The 5 `apps/*/README.md` files that documented `pnpm deploy` as
  "via `.github/workflows/deploy-workers.yml`" now say
  *"wrangler deploy; uses `wrangler login` on the operator's machine"* —
  matching how deploys actually happen today.
- `docs/internal/CloudflareStagingState.md` drops the
  `deploy-workers.yml matrix` row from its "Pending — author action"
  list, since that item no longer corresponds to planned work.
- The three GitHub Environments (`mainnet` / `testnet` / `dev`) are
  deleted via the API. Nothing referenced them, and the
  `required_reviewers` rule on `mainnet` was guarding a workflow that
  no longer exists.

If CI-driven deploys are ever needed, the cleaner path is to author a
fresh workflow then with OIDC-based short-lived authentication (the
shape supported by major cloud providers; Cloudflare's OIDC story
should mature over the next year), rather than carrying a long-lived
Cloudflare PAT in the repo.
