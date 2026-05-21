## Thread — CI: fold Build docs into ci.yml; one forge cold compile per PR (PR #<n>)

Closes #169. Eliminates the parallel cold-forge-build problem on
contracts-touching PRs: today's `ci.yml` does ONE cold `forge build`
inside `contracts-fast`, but the separate `contracts-docs.yml` workflow
triggered on the same `pull_request` event and ran ANOTHER cold compile
(via `forge doc --build`) in parallel — two ~22 min compiles racing for
the same `actions/cache` key. GitHub Actions doesn't support
cross-workflow `needs:` dependencies, so the only fix was to fold the
docs build into the same workflow.

### What changes

**`ci.yml` gets a new `build-docs` job** downstream of `contracts-fast`
(`needs: [detect-changes, contracts-fast]`, gated on `contracts ==
'true' && contracts-fast.result == 'success'`). It restores the same
`actions/cache` artifacts `contracts-fast` populated, then runs `forge
doc --build` against warm contracts — no recompile, just the NatSpec →
mdbook rendering. Observed runs land at ~5-8 min vs the ~22 min cold-
compile job it replaces.

**`contracts-docs.yml` narrows to push-to-main + workflow_dispatch
only.** The PR trigger is gone; the file now owns ONLY the Pages-deploy
concern. The PR-preview artifact upload (`contracts-docs-pr-<N>`) moved
to `ci.yml`'s `build-docs` job — reviewers still download + inspect the
rendered docs the same way, just from a different workflow's artifact.

### The "one forge build per PR" chokepoint, explained

After this fold, the entire contracts CI graph runs from a single cold
compile, then a three-branch parallel-warm fan-out where every job
consumes the same warm `out/` cache (no recompilation):

```text
detect-changes (always, ~5 s)
   ├─→ workspaces (TS typecheck, ~1 m, no forge)        ← parallel-OK
   └─→ analyze-jstypescript (CodeQL, ~1.5 m, no forge)  ← parallel-OK
        ↓
   contracts-fast (THE forge build + deploy-sanity, ~20 m cold)
   needs: [detect-changes, workspaces, analyze-jstypescript]
   if: contracts changed
        ↓
   ┌──────────┬──────────┬──────────────────────────┐
   ↓          ↓          ↓
build-docs  slither    contracts-full   ← parallel branches; all three
(~5-8 m,   (~5 m,     (~30 s,             restore the same `actions/cache`
warm        warm       warm cache)        key populated by contracts-fast
cache)      cache)         ↓               and skip the compile entirely.
                       gas-snapshot
                       (~3 m,
                        warm cache)
                       needs: contracts-full
                       (serial sub-branch — gas check runs only on a
                        tests-pass state)
```

**Forge build runs exactly once per PR** — in `contracts-fast`. Every
other forge-USE invocation in the fan-out (`forge doc --build`,
slither's AST walk, `forge test`, `forge snapshot --check`) hits warm
artifacts and skips the compile. Peak parallel forge-USE: three jobs
at T=0 after contracts-fast, but the compiler is invoked **zero**
times in any of them (the cache restore is a strict pre-condition).

**Wall-clock**: `~20 m` (contracts-fast cold compile) + `~5-8 m`
(longest pole in the fan-out — build-docs). `contracts-full` + `gas-snapshot`
together finish at ~3.5 m, well before build-docs, so they don't
extend the critical path.

`contracts-fast` populates `actions/cache` (path: `contracts/out` +
`contracts/cache`) with the compiled state. Every downstream forge-USE
job (`contracts-full`, `slither`, `build-docs`, `gas-snapshot`) restores
the same cache key at checkout. When forge is invoked downstream
(`forge test`, `forge doc --build`, `forge snapshot`, `slither`), it
sees the source hash matches the cached compile and skips the build
entirely — only the test execution / static analysis / mdbook rendering
runs. That's why `contracts-full` on PR #167 finished in 28 seconds
post-warm-cache.

The fold guarantees: ONE cold compile per PR, period. No racing
parallel forge invocations. Path-gated subsets (docs-only / TS-only /
contracts-only) cascade-skip via `needs:` chains, so a PR that doesn't
touch contracts costs zero forge compute.

### Compute savings

A contracts-touching PR previously paid for two parallel cold compiles
(`contracts-fast` ~23 min + `contracts-docs.yml`'s build ~22 min, both
running simultaneously). After this fold, the PR pays for one
(`contracts-fast` ~20 min) plus a warm-cache `forge doc --build` (~5-8
min downstream). **~50% reduction in cold-forge-compile minutes per
contracts-touching PR**, with wall-clock effectively unchanged
(~28-30 min total either way — the cold compile dominated already).

### Bonus optimisation — createOffer SSTORE-skip on single-value offers

PR #167's gas-snapshot job flagged five tests regressing 5.4-8.3%
(`testCreateOfferGetUserEscrowFails` +5.6%, etc.). Root cause: the
new `collateralAmountMax` storage slot SSTORE adds ~22.1 K cold-write
gas per `createOffer` (= 5.6% of 395 K, matching the observed slope).

The fix lands in this PR as a one-line conditional inside
`OfferCreateFacet._writeOfferCollateralFields`:

```solidity
// Only SSTORE when the offer is actually ranged. Single-value /
// legacy offers leave collateralAmountMax at storage default `0`.
// Every read site already has the `0 ⇒ collateralAmount` fallback
// (per Codex round-1 on #164) — so skipping the SSTORE is
// semantically identical to writing collateralAmount.
if (effCollateralAmountMax != params.collateralAmount) {
    offer.collateralAmountMax = effCollateralAmountMax;
}
```

Plus a paired update to:
- `_emitOfferCreatedDetails` — applies the same `0 ⇒ collateralAmount`
  collapse before emitting `OfferCreatedDetails`, so indexers see the
  LOGICAL upper bound (not the storage default). Without this the
  SSTORE-skip would leak through the event payload.
- `_createOfferSetup`'s borrower-side `MaxLendingAboveCeiling` check —
  computes the bound from `params.collateralAmountMax` directly
  (with the auto-collapse) rather than reading `offer.collateralAmountMax`,
  since storage may now be `0` post-skip.

Result: pre-#164 gas costs preserved bit-for-bit on every legacy
single-value `createOffer`. Only ranged-collateral offers pay the
22.1 K SSTORE — and on those, it's intrinsic to the new feature, not
overhead.

### Required-status-checks update

The `Protect main` ruleset's required-status-checks list needs the new
job name added + the old standalone removed:

- ADD `Build docs` (new ci.yml job)
- REMOVE `Contracts docs / Build docs` (the standalone workflow no
  longer runs on PRs; only on push-to-main, where required-checks
  don't apply anyway)

Update via the GitHub UI under Settings → Rules → `Protect main`. The
PR body / merge step will note when this happens.
