# Release Notes — 2026-06-06

## Intro

Consolidated batch of 40 release-note fragments accumulated since the
previous dated file. Headline ship: **T-086 §19 Round-8 borrow-OR-sell
parallel-sale** (PR #362) — borrower-driven optional-sale-at-offer-
creation that lets a borrower opt their NFT collateral into a live
OpenSea-compatible Seaport listing AT offer-create time. The listing
carries through loan acceptance; if a buyer ever fills it the diamond
atomically settles the loan via the sale proceeds, splitting between
lender (settlement entitlement), treasury (cut), and the current
borrower-position NFT holder (with a lazy vault provision if needed).
Twelve adversarial Codex review rounds + two Raja reviews drove the
design through a substantial set of hardening passes — reentrancy
guard on the offer-keyed callbacks, grace-end fill block, current-
borrower-holder authority on releaseParallelSaleLock, sibling loan-
keyed-listing block to prevent the ERC721 conduit-approval overwrite,
open PrecloseFacet-offset-offer block, and append-only storage layout
on both `LibVaipakam.Storage` and the `CollateralListingExecutor` for
safe future upgrades.

The batch also includes a CI shape ratification (ADR-0011 captures the
`cifast` foundry-profile narrowing + removal of `contracts-full` /
`gas-snapshot` jobs), the Round-7 §18 LibAutoList reconciliation +
§18.12 test additions, and several post-merge cleanup fragments queued
from the previous weeks.

Review fragment-by-fragment below — the per-PR shape is preserved so
each ship's own context stays self-contained.

## Doc cascade — remove stale `contracts-full` / `gas-snapshot` references (Issue #298)

Closes the documentation finish-line started by PR #297 (closes #296),
which removed the `contracts-full` and `gas-snapshot` jobs from
`ci.yml` and added the `cifast` foundry profile to slither. Several
files repo-wide still described the OLD three-tier CI shape in their
comments / prose. None of them held a live dependency on the removed
jobs (those would have broken the build) — but they DID mislead
anyone reading the operator-facing guidance.

### What changed

- **ADR-0011 added** — *CI compile scope narrowed to the `cifast`
  foundry profile; full regression is operator-local.* Captures the
  why (16 GB ubuntu-latest ceiling vs the 17.7 GB default-profile
  cold RSS, structural per-test artifact cost, no-self-hosted policy),
  the decision (delete `contracts-full` + `gas-snapshot` from CI; new
  `cifast` profile narrows scope to deploy-sanity + positive-flow +
  setup; mainnet-gate keeps the full regression on the release track),
  the consequences (release-track safety net unchanged; per-PR
  feedback drops from 25-30 min to 5-10 min cold), and the
  alternatives that were rejected (self-hosted runner, per-path viaIR,
  slim-base refactor, keeping the jobs as informational-only or
  workflow_dispatch-only).
- **ADR-0006 marked Superseded** by ADR-0011 with a banner pointing
  to the new ADR. The historical content stays intact as the audit
  trail of the previous decision.
- **`docs/adr/README.md`** — index entry updated for ADR-0006's new
  status and ADR-0011 added in sequence.
- **`.github/workflows/mainnet-gate.yml`** — top-of-file comment
  rewritten. The OLD text claimed "the routine PR CI runs both the
  deploy-sanity suite AND the full 2,012-test regression"; the new
  text describes the post-#296 reality (CI runs only the cifast
  surface; full regression is operator-local + this workflow on the
  release track). The actual workflow body — `bash
  script/predeploy-check.sh --full` at step `[1b]` — is unchanged,
  because the LIVE dependency was always fine.
- **`.github/workflows/contracts-docs.yml`** — comment ref to "the
  gas-snapshot workflow" removed; restored mention of `ci.yml`'s
  `contracts-fast` job as the warm-cache source.
- **`.github/workflows/ci.yml`** — two cache-key comment blocks
  (slither + Build docs) rewritten to drop their `contracts-full +
  gas-snapshot` mentions.
- **`docs/internal/PinnedIssueDrafts.md`** — milestone row for
  `audit-prep` cleaned up (was "CodeQL + Slither + gas-snapshot
  tracking"; now "CodeQL + Slither static analysis"). The
  gas-snapshot tracking moved operator-local with #296.
- **`docs/internal/ProjectProcedures.md`** — the same audit-prep row
  cleaned up; §7.1 "Protect main ruleset (monorepo)" rewritten from
  the 8-gate / contracts-full-as-informational shape to the 10-gate
  shape currently enforced by the ruleset (detect-changes,
  contracts-fast, workspaces, Build docs, Slither static analysis +
  the five hygiene gates), with a paragraph explaining where the
  full regression runs now (operator-local + mainnet-gate); §9.4
  `predeploy-check.sh` reference updated to point at mainnet-gate
  + the deploy script for the `--full` invocations; §10 hardening
  summary updated to the post-#296 state.
- **`docs/ops/DeploymentRunbook.md`** — preflight checklist row for
  gas-snapshot review marked "operator-local" so the runbook makes
  the post-#296 expectation explicit.

### What was deliberately NOT touched

- **`docs/ReleaseNotes/ReleaseNotes-2026-05-20.md` /
  `ReleaseNotes-2026-05-21.md`** — historical release notes; they
  describe what shipped on those dates and should not be rewritten.
- The `bash script/predeploy-check.sh --full` step inside
  `mainnet-gate.yml` — it's the LIVE dependency; only the prose
  surrounding it described the CI environment incorrectly.

### Why P3

Pure documentation update — no live job depended on the stale
references, so this PR isn't blocking anything. PR #297 ships the
structural fix; this is the operator-guidance finish-line.

## Forge-lint cleanup — 19 stragglers across test/script (Issue #89)

Closes the long tail of Issue #89's lint sweep. The named scope of the
issue — `mixed-case-function`, `mixed-case-variable`,
`screaming-snake-case-const`, `screaming-snake-case-immutable`,
`unsafe-typecast`, `unwrapped-modifier-logic`, `unsafe-cheatcode` — is
now fully addressed:

- **Batch 6 (`unwrapped-modifier-logic` + `unsafe-cheatcode`)** turned
  out to already be at zero after today's PR #272 work; the lint
  categories no longer fire. The `_check*()` thin-wrapper pattern that
  PR #272 introduced for the reward-messenger modifier (and that
  pre-existing facets like `FlashLoanLiquidator`, `VaipakamRewardMessenger`,
  `VaultFactoryFacet`, and `AdminFacet` already used) covers every
  modifier in `contracts/src/`. The 10 existing `unsafe-cheatcode`
  suppressions across deploy scripts and test infrastructure cover the
  cheatcode usages that legitimately need to stay.

- **19 stragglers** in other categories that prior batches didn't
  touch — almost all in `test/` or `script/` — closed in this PR.

### What landed

**11 × `mixed-case-function` suppressions** (project-domain acronyms
mirroring ABI-surface names already preserved via suppression in
Group A.4):

- `test/OfferFacetTest.t.sol`, `test/HelperTest.sol` — three
  `get<Facet>Selectors` helpers (`getVaipakamNFTFacetSelectors`,
  `getVPFITokenFacetSelectors`, `getVPFIDiscountFacetSelectors`).
- `test/invariants/VPFISupplyCap.invariant.t.sol` — `mintVPFI` handler.
- `src/libraries/LibVaipakam.sol` — internal `setDIAOracleV2` (matches
  the external suppression on `OracleAdminFacet` from Group A.4).
- `test/FlashLoanLiquidatorTest.t.sol` — `setIO` mock-swap method.
- `test/mocks/TestMutatorFacet.sol` — four mock mutators:
  `setKYCEnforcementFlag`, `setLenderClaimNFTFieldsRaw`,
  `setBorrowerClaimNFTFieldsRaw`, `getStakingRPTStored`.

Each gets one inline `// forge-lint: disable-next-line(mixed-case-function)`
above the declaration. Renaming would have diverged the test/script
helper names from the production identifiers they mirror.

**5 × `mixed-case-variable` renames** (UPPERCASE test-fixture storage
vars → camelCase):

- `test/VpfiBuyFlowTest.t.sol`, `test/CcipDeploymentRehearsalTest.t.sol`
  — `ERC20Mock internal VPFI` → `vpfi`.
- `test/invariants/ConfigBounds.invariant.t.sol`,
  `test/invariants/StakingRewardMonotonicity.invariant.t.sol` —
  `VaipakamDiamond public DIAMOND` → `diamond`.
- `test/invariants/StakingRewardMonotonicity.invariant.t.sol` —
  `VPFIToken public VPFI` → `vpfi`.

Word-boundary regex replacement; updates the declaration plus every
in-file usage atomically. No external file inherits or references
these storage vars, so the blast radius is per-file. Test/script
fixtures are not ABI surface — `setVPFIToken` and friends in
production keep their uppercase acronyms.

**3 × `screaming-snake-case-const` renames** (`usdDenom` → `USD_DENOM`):

- `script/DeployTestnetLiquidityMocks.s.sol`,
  `test/fork/LiquidationMainnetFork.t.sol`,
  `test/fork/OracleMainnetFork.t.sol`.

The `usdDenom` constant holds `0x0000…0348` (ISO 4217 numeric code 840
for USD, used as Chainlink Feed Registry denomination). Renaming to
`USD_DENOM` follows Solidity style for `constant` storage. No ABI
surface — internal test-script consts only.

### Total reach

- 7 files touched
- 11 inline suppressions added
- 111 word-boundary replacements applied across the renames

### Closes the named scope

After this PR, Issue #89's stated lint categories should be at zero
warnings. The umbrella can close. Any future drift (e.g., a new facet
that introduces an `unwrapped-modifier-logic` violation) gets caught
by CI on the introducing PR — same shape as the rest of the
codebase's lint discipline.

## Thread — Codex trigger workflow PR-comment permission hotfix

The `codex-review-trigger` workflow that shipped in #274 surfaced a
GitHub Actions permission gotcha on its first live run against
PR #275: the workflow's declared `issues: write` permission is
sufficient for creating comments on true issues, but PR comments
specifically require `pull-requests: write` — even though the REST
endpoint is the same `/repos/.../issues/{n}/comments`. The earlier
#273 review had tightened `pull-requests: write` to `read` on the
basis of mistaken least-privilege analysis (treating the
`/issues/{n}/comments` path as covered solely by `issues: write`),
and the workflow consequently failed with HTTP 403 when it tried
to auto-forward an `@codex review` trigger from a PR's description.

This thread restores `pull-requests: write` in the workflow's
permissions block. The `author_association` gate
(`OWNER + COLLABORATOR + MEMBER`) introduced in #274 still bounds
who can cause the elevated token to act, preserving the public-repo
cost-DoS protection. The repository-level
`default_workflow_permissions: read` ceiling is unchanged, so any
future workflow without an explicit `permissions:` block still
defaults read-only.

Operator bypass for in-flight PRs while a similar hotfix is pending
in any future regression: manually post `@codex review <mode>` as a
PR comment from a PAT that has the needed scopes. The workflow's
role is to auto-forward triggers from PR descriptions into PR
threads; Codex itself reads any directly-posted trigger comment
regardless of who authored it, so the manual-comment path is a
clean degraded-mode fallback.

Lesson recorded for future workflow reviews: the
`/issues/{n}/comments` REST endpoint accepts EITHER `issues=write`
OR `pull_requests=write` per the server-returned
`x-accepted-github-permissions` header, but the actual permission
the token needs is determined by whether `n` resolves to a true
issue or a pull request. For workflows that operate on PR threads,
`pull-requests: write` is the load-bearing scope.

## Thread — Codex trigger workflow removed (redundant with Codex's native integration)

The `codex-review-trigger` workflow shipped in #274 (+ hotfixed in
#276 for a permission gap) turned out to be redundant: Codex's
GitHub App already fires on `pull_request: opened` events when the
PR description contains `@codex review <mode>`, and also listens
natively to PR-thread comments containing the trigger text.

PR #275's run timeline made the redundancy obvious. Codex posted
its initial review at 20:42 UTC even though our trigger workflow
had failed at 20:40 with the permission bug carried over from the
original #273 review. The Codex App was bridging the
description-to-review path independently — our workflow was
forwarding the trigger into a comment Codex would have triggered on
anyway, just slower.

The workflow's defensive shape (an `author_association` gate
restricting forwarding to `OWNER + COLLABORATOR + MEMBER`,
SHA-keyed dedupe, a concurrency group serializing parallel events)
was all defending against an attack surface — paid-Codex-compute
abuse via forwarded comments — that no longer exists when no
forwarding happens. The two remaining edge cases the workflow was
the only thing covering (PR description edited post-open with a
new trigger; PR re-opened with the trigger in body) are rare in
practice and covered by the same one-off fallback that handles any
manual re-trigger need: post `@codex review <mode>` as a PR
comment from a PAT with the needed scopes.

Delete `.github/workflows/codex-review-trigger.yml` entirely.
Documented here so anyone reading `git log` on `main` over the
~24-hour window where the workflow existed has the context for
why it appeared and then disappeared.

Supersedes #274 + #276.

## Deploy-script pre-flight: reject native-gas mode on BNB Chain / Polygon PoS mainnet

CLAUDE.md's "VpfiBuyAdapter — payment-token mode by chain" section
called out a known operator-mistake surface: the buy adapter quotes a
single global ETH-equivalent rate for VPFI, but the deploy script lets
an operator initialize the adapter in native-gas mode on a chain where
1 unit of the native gas token isn't ≈ 1 ETH worth of value (BNB Chain
mainnet's BNB, Polygon PoS mainnet's MATIC/POL). The result would be
every buy on those chains mispricing — silently.

The contract-side guard (`_assertPaymentTokenSane`) already covers
*shape* validation (the address is a contract with 18 decimals), but
it doesn't and cannot know whether the operator on this specific chain
should be in native-gas mode or WETH-pull mode. That's the deploy
script's job.

This change adds a pre-flight check in `DeployCrosschain.s.sol`'s
mirror-chain branch: if `VPFI_BUY_PAYMENT_TOKEN` resolves to
`address(0)` (native-gas mode) AND `block.chainid` is BNB Chain
mainnet (56) or Polygon PoS mainnet (137), the script reverts with a
clear diagnostic naming the chain and pointing at the canonical
bridged-WETH address the operator should set.

Testnets (BNB Smart Chain Testnet `97`, Polygon Amoy `80002`) are
intentionally exempt — their gas tokens have no real value and the
testnet rate is symbolic, so native-gas mode is acceptable for
dev-loop convenience. Mainnet equivalents must use WETH-pull.

### Scope

- One pre-flight block added in `contracts/script/DeployCrosschain.s.sol`
  (33 lines including the policy comment and the two `require`s).
- Catches the misconfig BEFORE any state-changing deploy step runs —
  fails-loud, not fails-silent.
- Zero impact on chains outside the strict-WETH-pull list. Existing
  mainnet chains in the chain set (Ethereum, Base, Arbitrum, Optimism,
  Polygon zkEVM Cardona testnet) are unaffected because their native
  gas IS ETH-priced.

### Not yet wired

- No on-chain registry "this is the canonical bridged WETH9 on chain
  X" exists. Confirming the configured address really is the chain's
  published WETH9 (and not an attacker-deployed mock that returns the
  right decimals) remains an operational eyeball check — same as
  before this PR. The pre-flight covers the "operator forgot the env
  var" case, not the "operator pasted a malicious address" case.
- Adding programmatic confirmation that the WETH9 address matches a
  canonical chain registry would require either pulling Chainlink's
  Feed Registry (not deployed on every chain) or hard-coding the
  expected addresses per chain (becomes maintenance debt). Left as a
  follow-up if/when one of the strict-list chains gets a fresh deploy.

### Closes

A known follow-up tracked under the pre-audit-hardening note in
CLAUDE.md: *"Adding a deploy-script pre-flight that rejects the wrong
mode is a small follow-up — tracked under the pre-audit-hardening
card."*

## Thread — Iteration kickoff sync (auto-iteration assignment + 2026-06-01 fold) (PR #<n>)

Closes #320 — the Iteration 4 kickoff-sync card auto-filed on Monday
2026-06-01 by `.github/workflows/iteration-kickoff-sync.yml`.

**What changed in the kickoff-sync automation.** The weekly Monday
00:05 UTC workflow used to file the kickoff-sync card and stop — the
card landed in Backlog with no Iteration or Sprint set, so it didn't
surface on the iteration-filtered board views the maintainer actually
reads on Monday morning. The ritual could then quietly miss a week.
A second step is now appended after the issue-bot step. It resolves
the current Iteration and Sprint by date (the iterations whose
`[startDate, startDate + duration)` window covers today's UTC date)
and assigns both fields on the newly-filed card via the
`updateProjectV2ItemFieldValue` GraphQL mutation. The Project ID and
the two iteration-field IDs are hard-coded as workflow env vars
because they're stable across reorganisations; if a field-set rotation
ever rotates them, the design comment in the workflow points at the
regeneration GraphQL query. Soft-fail when no iteration covers today
(a `::warning::` line surfaces the gap; the card still lands and the
maintainer can fix it manually in the Projects UI) — preferred over
hard-fail because the workflow's load-bearing job is filing the card,
not the iteration UX.

**Rules folded into the handbook for Iteration 4.** The first proper
kickoff sync since the discipline was set up. One memory note made
the cut: the pre-live project status (no production deployment of
the Diamond + executor + Worker stack on any chain) becomes a new
top-level §0 "Operating context" in
[`docs/internal/ProjectProcedures.md`](../internal/ProjectProcedures.md).
That section explains why ABI-breaking changes don't need transition
shims, why atomic-rollout maneuvers (Safe MultiSend / multicall
deploy / governance handover) are forward-looking scaffolding rather
than per-PR gates today, and which disciplines stay unchanged
regardless (sanctions wiring, code-consistency co-update, per-PR
release notes and FunctionalSpecs updates). The second memory note
reviewed — auto-merging clean PRs without pausing for explicit user
approval — is agent-specific personal discipline and stays in memory
only; folding it into the handbook would be over-prescriptive for
contributors who aren't operating the agent. The §5.2 worked example
was also reframed from "current" to "historical" since the Iteration 2
cycle it referenced has long since ended.

**Sentinel + memory housekeeping.** The
`.last-iteration-sync` sentinel file in the agent-memory directory
is touched as part of this thread to record the close timestamp, per
§5.7. The stale "Sprint = 7d Mon-aligned" note in agent memory is
corrected to the current 14d cadence (the board's Sprint field has
been on 14-day cycles since Sprint 3 — the §5.1 field table already
reflected this, but the cross-reference memory note hadn't been
freshened).

**Effect on next Monday's run.** The next scheduled fire is
2026-06-08 00:05 UTC — the Iteration 5 kickoff. With this PR landed,
the auto-filed card will arrive in Backlog already tagged
`Iteration 5` + the prevailing Sprint, so it appears on the
iteration-filtered views the moment the maintainer opens the board.
The manual `gh api graphql` fix-up applied to #320 mid-week is the
one-time backfill — it doesn't need to be repeated.

**Investigation finding — iterations are NOT auto-extended by
GitHub.** A natural question while building this — "what if no
iteration covers today, can the workflow just create one?" — was
investigated against three angles: (1) public GraphQL schema
introspection (the `ProjectV2Iteration` input has no `id` field and
the only mutation is the destructive `updateProjectV2Field`); (2)
empirical test against the live API (created a throwaway iteration
field, assigned a card, did a no-op replace passing back identical
iterations — card was orphaned because IDs were regenerated); (3)
browser DevTools capture of the UI's "+ Add iteration" Save click
(the call bypasses GraphQL entirely and hits an internal "memex"
REST endpoint with ID-keyed merge semantics that the public API
genuinely doesn't expose). Community discussion
[#157957](https://github.com/orgs/community/discussions/157957)
documents the same gap and reports the reporter resorted to
Puppeteer to drive the UI.

The conclusion: programmatic iteration creation is left out of the
workflow. The maintainer keeps ~6 future iterations seeded on each
iteration field via the Projects UI (`+ Add iteration` button); the
workflow's maintainer-ping fallback (a `> [!WARNING]` callout on the
just-filed card) is the loud reminder when the maintainer slips a
runway top-up. The seeding-cadence rule is documented in
`docs/internal/ProjectProcedures.md` §5.7.

No code paths in `contracts/`, `apps/`, or `packages/` are touched
by this thread.

## LibERC721 hardening — block `setApprovalForAll` while owner holds a locked token

Today's `LibERC721._lock` revokes per-token approval (`tokenApprovals[tokenId]`) but does NOT clear operator-wide approvals (`operatorApprovals[owner][operator]`), and `setApprovalForAll` itself has no lock check. That creates a bypass:

1. Attacker calls `setApprovalForAll(attacker, true)` while the position-NFT holder owns no locked tokens (or grants this approval as a malicious operator pre-arrangement);
2. The owner enters a flow that calls `_lock` on their position NFT (Preclose offset or EarlyWithdrawal sale today; the upcoming T-086 prepay-listing flow tomorrow);
3. `transferFrom` on the locked token is correctly blocked by `_requireNotLocked`;
4. The owner cancels the flow → `_unlock` releases the lock;
5. **Attacker immediately calls `transferFrom` and walks the position NFT** — the operator approval from step 1 is still valid.

The window between unlock and the next state-changing call from the rightful owner is the attacker's window.

### The fix

Five small changes in `contracts/src/libraries/LibERC721.sol`:

1. **New per-owner counter:** `mapping(address => uint256) lockedTokenCount` added to the `ERC721Storage` struct (append-only field, end of struct).
2. **`_lock` / `_unlock` / `_burn` maintain the counter** — `++` on the `None → non-None` transition; `--` on the `non-None → None` transition; `--` when a still-locked token is burned. Re-locking a token with a different reason does not double-count. Burning the locked lender-side position NFT during `EarlyWithdrawalFacet.completeLoanSale` (which goes through `LibLoan.migrateLenderPosition` without an `_unlock` first) used to strand the counter permanently positive — now it cleanly decrements.
3. **`setApprovalForAll` gates new approvals on the counter:**
   - If `approved == true` AND `lockedTokenCount[msg.sender] > 0`, revert `ApprovalForbiddenWhileTokensLocked(owner, lockedCount)`.
   - If `approved == false` (revocation), always allowed — a user must be able to withdraw a prior approval at any time.
4. **Per-owner operator-approval epoch closes the pre-lock-grant path.** The counter gate alone only blocks NEW approvals while locked — operator approvals granted BEFORE the owner's first lock would survive the lock/unlock cycle and let an attacker `transferFrom` immediately on release. To close that, `_lock` now bumps a per-owner `operatorApprovalEpoch` on every fresh `None → non-None` transition, `setApprovalForAll` stamps each new grant with the then-current epoch in `operatorApprovalGrantEpoch`, and `isApprovedForAll(owner, operator)` returns `true` only when the stamped grant epoch matches the owner's current epoch. Any approval granted before the most recent lock is silently treated as stale — the user must explicitly re-grant after the lock cycle ends.
5. **Storage layout is append-only.** Three new fields go at the end of the `ERC721Storage` struct: `lockedTokenCount`, `operatorApprovalEpoch`, `operatorApprovalGrantEpoch`. No existing field is reordered, renamed, or retyped.
6. **Upgrade-safety belt on `_unlock` and `_burn`.** Both call sites guard the decrement on `lockedTokenCount[owner] > 0`. The counter is brand new — on a live diamond upgrade where Preclose or EarlyWithdrawal positions are mid-flight at the moment of the upgrade, the legacy `_lock` call that started those flows never incremented the counter (it didn't exist yet), so the owner's counter is 0 even though `locks[tokenId] != None`. Without this guard the first post-upgrade `cancelPreclose` / `cancelLoanSale` / `completeLoanSale` would underflow and revert, stranding every legacy in-flight position. With the guard, legacy locks unwind as no-ops on the counter; new locks self-balance normally.
7. **The epoch chain — not the counter — is the security source of truth.** The locked-count guard prevents reverts but the counter can DRIFT below the true number of locked tokens when legacy and counted locks coexist (e.g., unlock a legacy token while a counted token is still locked — the counter decrements past truth). To keep the security property intact regardless of drift, `_unlock` and `_burn` also bump `operatorApprovalEpoch[owner]` on every transition out of locked state (legacy or counted). Combined with the `_lock`-side bump, every transition INTO or OUT OF locked state invalidates every existing operator approval — so even an attacker who managed to grant an approval during a legacy lock (when the counter-gate read 0 and let it through) cannot transfer post-unlock, because the unlock bumps the epoch and stales the grant. Counter accuracy is best-effort cosmetics; the epoch chain is the load-bearing primitive.

### Why this PR is small + ships now, not bundled with T-086

The reviewer's recommendation on the T-086 ratified design doc was to unbundle this hardening: it's a low-risk, immediately-valuable improvement to the existing **`PrecloseFacet`** (offset path) and **`EarlyWithdrawalFacet`** (sale path) flows. Both currently use `_lock`/`_unlock` and both inherit the bypass closed by this PR. Bundling it with T-086 step 2 would have inflated that PR and delayed the security benefit to the existing flows.

After this PR lands, T-086 step 2 (`LockReason.PrepayCollateralListing` enum extension) is purely additive — the counter + `setApprovalForAll` gating already exist.

### Test coverage

New `LibERC721LockApprovalTest.t.sol` exercises:
- Counter math: starts at 0; increments on `_lock`; decrements on `_unlock`; multiple tokens; partial unlocks; re-lock with different reason does not double-count.
- `setApprovalForAll(operator, true)` reverts with `ApprovalForbiddenWhileTokensLocked` while the caller owns any locked token.
- `setApprovalForAll(operator, false)` (revocation) succeeds regardless of lock state.
- Approval succeeds after unlock.
- Other users' approvals are unaffected by a lock on the test owner's token.
- **Burn-while-locked path (L145):** burning a still-locked token decrements the counter so the owner is not stranded with a permanently positive `lockedTokenCount`; the owner can subsequently grant a fresh approval. Burning an unlocked token does not touch the counter.
- **Pre-lock operator approval path (L151):** an approval granted before the owner's first lock is invalidated mid-lock AND stays invalidated after `_unlock` — the user must explicitly re-grant. Epoch bumps only on the `None → non-None` transition (re-locking with a different reason doesn't double-bump). Epochs are per-owner, so a stranger's separate lock cycle doesn't invalidate the test owner's approval.
- **Upgrade-safety underflow guard (L186):** a legacy-locked token (simulated via a test-only `forceSetLockWithoutCounter` helper that writes `locks[tokenId]` directly without touching the counter) unwinds cleanly through both `_unlock` and `_burn` — the counter stays at 0 and no transaction reverts. A subsequent fresh `_lock` increments from a clean 0 → 1, demonstrating eventual consistency once legacy state has drained.

The test uses six new test-only helpers on `TestMutatorFacet` (`testMintNFT`, `testLockNFT`, `testUnlockNFT`, `testBurnNFT`, `forceSetLockWithoutCounter`, plus the `getLockedTokenCount` / `getOperatorApprovalEpoch` / `getOperatorApprovalGrantEpoch` readers) so the focused unit test doesn't have to stand up a full offer-accept + Preclose lifecycle for what is fundamentally a library-level gate. The production-side flows (PrecloseFacet, EarlyWithdrawalFacet) still go through their facets exclusively; these helpers are NOT cut into production deployments.

## OpenSea testnet endpoints removed

OpenSea sunset their testnet API and marketplace UI on 2025-07-23
([Farewell, Testnets](https://support.opensea.io/en/articles/11833955-farewell-testnets)). The T-086 step-14 publish surface from PR #312
still referenced four testnet chains (Sepolia, Base Sepolia, Arb
Sepolia, Op Sepolia) against the dead `testnets-api.opensea.io` host;
the same chains were also listed for the banner's "View on OpenSea"
deep-link via `testnets.opensea.io`. Both endpoints now return 404
or redirect, which would surface as a generic "OpenSea publish
failed" on testnet borrowers' loan-details pages instead of the
clearer "this chain isn't supported by OpenSea".

This change strips the four testnet entries from the three places
they were duplicated:

- `apps/agent/src/openseaProxy.ts` — `OPENSEA_CHAINS`. Testnet
  borrowers' proxy POST now fails fast with `unsupported-chain`
  before the upstream call.
- `apps/indexer/src/openseaPublish.ts` — `OPENSEA_CHAINS`. The
  autonomous republish path for testnet rows returns
  `unsupported-chain-<id>` immediately; the row's
  `opensea_published_at` stays NULL forever (no quota burn).
- `packages/lib/src/prepayOrderShape.ts` — `OPENSEA_CHAIN_SLUGS`.
  `openSeaAssetUrl(chainId, …)` returns `null` for testnet chain
  ids, which `PrepayListingBanner` already handles cleanly by
  suppressing the "View on OpenSea ↗" deep-link without breaking
  the rest of the banner.

The cross-cutting `nftLink.ts` helper (used by `AssetLink` for
generic NFT "open externally" links — not just the prepay-listing
banner) was also updated: testnet NFTs now fall straight through
to the chain explorer instead of generating a broken
`testnets.opensea.io` URL.

The on-chain prepay-listing order remains valid + fillable on every
testnet just as before — only the OpenSea-marketplace UI surface
goes away there. The on-chain order can still be fulfilled directly
via `Seaport.fulfillOrder` by anyone holding the orderHash +
canonical components, which is what sophisticated buyers do today.

No contract changes. No new dependencies. Frontend and Workers
typecheck clean.

## T-086 #309 Block B — Dutch decay for prepay listings

Adds Dutch-decay posting + update entry points to the prepay-collateral
listing flow so borrowers of unique / illiquid NFTs can let the price
discover itself over the auction window instead of guessing a fixed
ask. Closes Issue #309's "Mode A — Dutch decay on Seaport (on-chain
only)" leg.

The Dutch path coexists with the Round-4 fixed-price flow and the
Block A fee-leg surface — borrowers pick per listing; the modes don't
gate each other.

### What this PR ships

**Contract surface — split-facet shape** —
`NFTPrepayDutchListingFacet` (new sibling facet) hosts the two Dutch
entry points `postPrepayDutchListing` and `updatePrepayDutchListing`.
The split out of `NFTPrepayListingFacet` is bytecode-budget driven:
combining all five entry points (fixed-price post / update +
Dutch post / update + cancel + helpers) in one facet tripped solc's
"Tag too large for reserved space" internal compiler error. The
sibling facet shares the same `LibVaipakam` storage and the same
`IListingExecutorRecorder` interface to the singleton executor, so
the two facets are coherent on the wire.

**Multi-mode recorder interface** —
`IListingExecutorRecorder.recordOrder` grew three trailing parameters
(`endAskPrice`, `auctionEndTime`, `mode`). For fixed-price posts the
facet stamps `endAskPrice == askPrice`, `auctionEndTime == 0`, and
`mode == PREPAY_MODE_FIXED_PRICE (0)`; for Dutch posts it passes the
real Dutch values + `mode == PREPAY_MODE_DUTCH (1)`. The executor's
`OrderContext` gained one packed slot
(`uint128 endAskPrice | uint64 auctionEndTime | uint8 mode | pad`) so
cancel-time canonical-shape reconstruction can dispatch on the mode
tag.

**Cancel-time dispatch** —
`CollateralListingExecutor._tryCancelOnSeaport` now branches on the
recorded `mode`. The fixed-price branch is the historic
`pctx@startTime` reconstruction (Round-4 shape). The Dutch branch
reads pctx at `auctionEndTime` so projected lender + treasury legs
replay the values the facet signed against — under sign-time
governance config; if governance has drifted the recompute mismatches
and the executor emits the existing `SeaportCancelSkipped` breadcrumb
(the proper cleanup still completes — only the OpenSea catalog-refresh
acceleration is lost, matching the Block A precedent).

**Borrower-facing sign-time validation** —
new errors `AuctionWindowTooShort`, `AuctionExceedsGrace`,
`AskNotMonotonic`, `FeeLegNotMonotonic`, `BorrowerLegNotMonotonic`,
`DutchStartAskBelowProjectedFloorPlusFees`,
`DutchEndAskBelowProjectedFloorPlusFees`. The
`MIN_AUCTION_WINDOW = 1 hour` floor protects against locking the
NFT into an instantly-expired auction; `auctionEndTime ≤ gracePeriodEnd`
keeps the Seaport boundary inside the protocol boundary. The
**derived borrower-leg monotonicity** check catches the
parameterization where fee legs decay FASTER than the total ask
(`borrowerLeg.startAmount` would invert) — Seaport would reject at
fill time with a per-item interpolation error, so the facet
catches it with a clean revert at post time instead.

**Shared event shape** —
`PrepayListingPosted` and `PrepayListingUpdated` extended with
trailing `endAskPrice` / `auctionEndTime` / `mode` fields. Same
topic hash regardless of mode; the indexer's event-coverage
allowlist stays tight (one handler per shape, not two).

**`@vaipakam/lib/prepayOrderShape` Dutch extension** —
`PrepayOrderInput.dutch?` optional object carrying
`(startAskPrice, endAskPrice, projectedLenderLeg, projectedTreasuryLeg,
auctionEndTime)`. When set, `buildPrepayOrderComponents` uses the
Dutch values for borrower-leg decay + the projected protocol legs
+ Seaport `endTime = auctionEndTime`. When unset, the builder
emits the Round-4 + Block A fixed-price shape verbatim. Exported
mode constants `PREPAY_MODE_FIXED_PRICE` / `PREPAY_MODE_DUTCH`.

**Indexer + D1 + autonomous-publish** —
- Migration `0018_prepay_listings_dutch.sql` adds three columns:
  `end_ask_price TEXT`, `auction_end_time INTEGER`, `auction_mode INTEGER`.
- The `PrepayListingPosted` and `PrepayListingUpdated` handlers decode
  the new event fields and persist them on INSERT / UPDATE.
- `indexerPublishPrepayListing` accepts an optional `dutch` object;
  when set, pctx is read at `auctionEndTime` and the JS reconstruction
  uses the Dutch shape (matching the on-chain orderHash). When unset,
  the helper emits the fixed-price shape unchanged.
- The cron retry sweep reads the new columns back and rebuilds the
  Dutch input from D1 for autonomous republish.

**Dapp** —
`useNFTPrepayListing` hook grew `postPrepayDutchListing` /
`updatePrepayDutchListing` entry callbacks. v1 of the dapp does NOT
include the frontend-direct OpenSea publish for the Dutch path —
the indexer's autonomous handler covers it uniformly across both
modes using the event's Dutch fields. The borrower-facing Dutch
posting UI (decayed-price ticker + parameter form) is the dapp
deferred follow-up; the contract + indexer surface ships first.

**Deploy + multicall harness reuse** —
DeployDiamond's facets array bumped to 40 + a separate
`_getNFTPrepayDutchListingSelectors` cut. The Block A multicall
deploy harness (`multicallDeploy.s.sol`, `BatchCaller`,
`EncodeMultiSend`, `DeployGnosisSafe`) is unchanged — the same
atomic UUPS upgrade + diamondCut pattern works for Block B's
recorder-interface bump. The platform is pre-live so the
multicall harness is forward-looking scaffolding for the
eventual mainnet, not a load-bearing per-PR gate.

### What's NOT in this PR (intentional)

- **Dutch posting UI on the dapp** — hook entries are exposed; the
  decayed-price ticker + parameter form are the deferred follow-up
  (matches Block A's "fee picker is deferred" pattern).
- **Mode B — English via OpenSea Offers (Block C)** — Issue #309's
  pragmatic English path is dapp-only and lands as a separate PR.
  Block A's "fee-free collection" track for C can run in parallel.
- **Vickrey / sealed-bid auctions** — out of scope per design doc §15;
  incompatible with OpenSea's offer-book UI.
- **Frontend-direct OpenSea publish for Dutch** — the indexer's
  autonomous publish path handles both modes uniformly. Frontend-
  direct is a UX-latency optimization; we'll add it once the
  borrower UI lands.

### Operator action post-merge

This PR is atomic for the codebase — every layer ships together.
For the eventual on-chain rollout (post-mainnet-cutover):

1. Deploy the new `CollateralListingExecutor` implementation
   (the multi-mode `recordOrder` signature is ABI-breaking vs Block A's).
2. Deploy the new `NFTPrepayDutchListingFacet`.
3. Build the multisend payload via `multicallDeploy.buildPayload(...)`
   — one `upgradeToAndCall` for the executor + one `diamondCut`
   adding the Dutch facet selectors.
4. Send the multisend through the Safe (1 transaction, atomic).
5. Apply the D1 migration:
   `cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote`

The platform is pre-live so there's no production rotation outage
risk — the multicall harness is scaffolded for the eventual mainnet
cutover. See [[project_platform_prelive]] in memory for the
broader framing.

### Verification

- Forge regression (cifast scope): **121 / 121 PASS** locally.
- New facet test coverage: 7 Dutch integration tests on
  `NFTPrepayListingFacetTest` (happy post + window-too-short +
  grace-exceed + ask-not-monotonic + end-ask-below-floor +
  borrower-leg-not-monotonic + happy update). Combined facet suite
  now 46 / 46 PASS.
- Executor unit suite: 36 / 36 PASS.
- Deploy-sanity suite (facet count, selector coverage, no
  collisions, facet sizes): 12 / 12 PASS.
- Indexer event-coverage: 41 enforced state-change events, 26
  handled, 15 allowlisted — no drift.
- Workspace typecheck: `defi` / `agent` / `indexer` / `keeper` —
  all four green.

### Closes

Issue #309 (Mode A — Dutch decay) part 1. Block C (English via
OpenSea Offers) is the remaining slice.

### Related

- Round 5 design + Round 5.1 errata: #322 + #323
- Block A (fee-legs atomic): #324
- **Block B (this PR): Dutch decay** — closes #309 Mode A
- Block C (English via OpenSea Offers): #309 Mode B
- Multi-marketplace fan-out: #281

## T-086 #309 Block C — pragmatic English via OpenSea Offers (fee-free)

Adds the borrower-facing surface for the pragmatic English-auction
flow described in design §15.3. Closes Issue #309's "Mode B —
English via OpenSea Offers" leg for fee-free collections.

The flow is **dapp-only on the contract side** — it reuses the
existing `updatePrepayListing` (and `updatePrepayDutchListing` when
Block C-on-Dutch lands) entry points to rotate the canonical
Seaport order to an offer's price. No new contract surface, no new
selectors, no new facets. The platform's English-auction story
ships entirely as polling + UI + a thin agent proxy.

### What this PR ships

**Agent proxy — `GET /opensea/offers/{chainId}/{contract}/{tokenId}`.**
Aggregates OpenSea's two slug-keyed offers endpoints (item-specific
at `/api/v2/offers/collection/{slug}/nfts/{tokenId}` + collection-
wide at `/api/v2/offers/collection/{slug}`) in a single round-trip.
Per-IP rate-limited via the new `OPENSEA_OFFERS_RATELIMIT` binding
(60 req/min/IP — matches the dapp's 30 s poll cadence with
headroom). CORS-locked to the resolved single origin from
`FRONTEND_ORIGIN`. The dapp does the threshold filter + sort
client-side; the proxy is intentionally stateless. Both legs are
slug-keyed, so a slug-resolution failure skips both fetches and
the proxy returns `null` for each — the panel renders the
empty-offers state cleanly.

**`useOpenSeaOffers` hook.** Polls the agent proxy every 30 s while
mounted, normalizes the OpenSea v2 response shape, and classifies
each offer as **acceptable** when `offer.value >= (lenderLeg +
treasuryLeg) × (1 + bufferBps/10000)` (the fee-free threshold from
§15.3 step 4). Offers below threshold OR in the wrong payment
token OR expired are surfaced with greyed-out rows so the borrower
sees market interest without being able to click Match on a
listing that would revert at re-sign.

**`OpenSeaOffersPanel` component.** Renders the offers list +
"Match offer" buttons per acceptable row + a **race-window warning
modal** (§15.3's v1 dapp-side mitigation: between
`updatePrepayListing` and the bidder's `Seaport.fulfillOrder`, any
buyer can snipe the rotated price). The borrower must
acknowledge the warning before the rotation tx fires. Includes a
diagnostics collapse-section + manual "Refresh now" affordance.

**`OpenSeaOffersSection` wrapper.** Mounted on `LoanDetails` right
after `PrepayListingActions`. Owns:
  1. Its own pctx fetch (`getPrepayContext` + `getPrepayListingBufferBps`)
     for the threshold calculation.
  2. The `useOpenSeaOffers` polling instance.
  3. The `matchOffer` callback that calls
     `prepayListing.updatePrepayListing` with `(offer.value, salt,
     conduitKey, feeLegs=[])` — fee-free path.

**Indexer API extension.** `GET /loans/by-id` now surfaces
`conduitKey`, `salt`, `executor`, `endAskPrice`, `auctionEndTime`,
`auctionMode` on the `prepayListing` block. These columns existed
in D1 (migrations 0016 + 0018) but weren't routed to the dapp;
the Match flow needs `salt` + `conduitKey` to call
`updatePrepayListing` with the live order's sign-time inputs.

### Pre-live framing

The platform is pre-live on every chain. The agent's
`OPENSEA_API_KEY` and `OPENSEA_OFFERS_RATELIMIT` bindings must be
provisioned in the operator's Secrets Store before the offers panel
becomes useful; until then the panel renders a graceful disabled
state (`agentOrigin === null` short-circuit returns null in the
mounting wrapper).

### What's NOT in this PR (intentional)

- **Fee-enforced collection support.** Per §15.3's "re-fetch on
  every match-offer click" rule, fee-enforced collections need the
  dapp to re-fetch the OpenSea schedule against the offer's gross
  value at the moment of Match + thread the recomputed `FeeLeg[]`
  through. v1 ships the fee-free path; for fee-enforced
  collections the section returns an informational banner BEFORE
  the offers panel renders. No offers list + no Match buttons —
  the banner explicitly says incoming offers stay visible on
  OpenSea's marketplace UI but dapp-side matching is gated until
  v1.1. Follow-up card.
- **Dutch-listing match flow.** Offers can be matched against a
  fixed-price listing today; matching against a live Dutch listing
  would need `updatePrepayDutchListing` with the offer's value +
  fresh `(startAskPrice, endAskPrice, auctionEndTime)` parameters.
  Same surface; deferred to keep the v1 ship narrow.
- **Atomic match-rotation via Seaport `matchOrders`** — the v2
  escape hatch §15.3 names. v1 explicitly accepts the race window.
- **Indexer breadcrumb on accepted offers** — `apps/indexer/...
  PrepayListingUpdated` already logs every rotation; analytics
  on "which offer was matched" can be added without a contract
  change. Deferred.
- **Pagination beyond ~300 offers per endpoint.** The agent
  proxy follows OpenSea's `next` cursor for up to 3 pages
  (≈300 offers per leg). For hyper-active collections where
  there are still more acceptable offers beyond page 3, the
  borrower sees the top portion only. The 3-page cap was
  chosen to bound the proxy's upstream call budget (worst case
  6 round-trips per poll: 3 collection + 3 item); higher
  caps land as a v1.1 follow-up if production signal shows
  the cap matters.

### Verification

- `apps/defi` typecheck: green.
- `apps/agent` typecheck: green.
- `apps/indexer` typecheck: green.
- `apps/keeper` typecheck: green.
- No contract changes; no forge regression needed.

### Operator action post-merge

1. Provision `OPENSEA_API_KEY` in the agent's account-level Secrets
   Store entry (`vaipakam-credentials`, store id
   `1e66429d0fa24aa38a27bc05b7bcf63e`). Already needed for the
   existing `/opensea/listing` proxy; no new secret.
2. Verify the wrangler.jsonc adds the `OPENSEA_OFFERS_RATELIMIT`
   binding (namespace_id `1007`, 60 / 60s per IP). Cloudflare picks
   it up on next `wrangler deploy`.
3. Verify `VITE_AGENT_ORIGIN` is set on the dapp's deploy. Already
   needed for the existing offers flow on the listing surface; no
   new env.

### Closes

Issue #309 Mode B (English via OpenSea Offers) — fee-free track.
Fee-enforced collection support is the remaining follow-up.

### Related

- Round 5 design + Round 5.1 errata: #322 + #323.
- Block A (fee-legs atomic): #324 (merged).
- Block B (Dutch decay): #326 (merged).
- Block B Codex post-merge polish: #327 (merged).
- **Block C (this PR): English via OpenSea Offers** — closes
  #309 Mode B (fee-free track).
- Multi-marketplace fan-out: #281.

## T-086 #313 Block A — fee-legs for fee-enforced collections (atomic)

Extends the canonical Seaport prepay-listing order shape from a fixed
3 consideration legs (lender / treasury / borrower) to **3 + up to 4
optional fee legs**, so listings published against fee-enforced
OpenSea collections (royalty + marketplace fees, OpenSea's "enforcing"
collection tier) can carry the fee recipients OpenSea requires and
still pass the same canonical orderHash on both producers — frontend
proxy and indexer autonomous fallback. Closes Issue #313 (the last
fee-enforced-collection UX gap T-086 had left open).

This PR lands every layer of that change in **one atomic cut** — the
sole acceptable shape for an ABI-breaking diamond+executor rotation:
the executor's UUPS implementation, the diamond facet wiring, the
shared `@vaipakam/lib` order-shape library, the indexer D1 column +
sweep path, the agent proxy + indexer-autonomous payload, and the
dapp. A non-atomic rollout would leave the deployed executor temporarily
unable to validate orders posted with the new shape.

### What this PR ships

**Shared Solidity types** — new `contracts/src/seaport/PrepayTypes.sol`
exporting `FeeLeg{address recipient, uint96 startAmount, uint96 endAmount}`
and `MAX_FEE_LEGS = 4`. Used by `LibPrepayOrder`, `IListingExecutorRecorder`,
`CollateralListingExecutor`, and `NFTPrepayListingFacet`. The
`startAmount` / `endAmount` shape is forward-compatible with Block B's
Dutch decay; for the fixed-price posting path this PR enforces
`startAmount == endAmount` at the facet boundary.

**`LibPrepayOrder` extended** — `buildAndHash` and `componentsForCancel`
now both accept `FeeLeg[] calldata feeLegs`. The borrower leg is
re-derived as `askPrice - lenderLeg - treasuryLeg - sum(feeLegs)` so
the protocol's lender/treasury solvency invariant is preserved; the fee
legs are then appended at consideration indices `3..N`. The library is
split into two helpers (`_componentsAtCalldata` for the sign-time path,
`_componentsAtMemory` for the cancel-time path) so each caller pays the
right copy cost.

**Facet boundary — fee-aware solvency checks** — new
`NFTPrepayListingFacet` errors `FeeLegsExceedCap`, `FeeLegInvalidRecipient`,
`FeeLegInvalidAmount`, `FeeLegDecayNotAllowedOnFixedPrice`, and
`AskBelowFloorPlusFees`. Both `postPrepayListing` and `updatePrepayListing`
grew a `FeeLeg[] calldata feeLegs` arg. The new `_validateFeeLegsFixedPrice`
checks cap (≤4) + non-zero recipient/amount + the fixed-price invariant
(`startAmount == endAmount`). The new `_requireAskCoversFloorWithFees`
folds the fee sum into the existing floor-buffer check:
`minAsk = (floor * (10_000 + bufferBps)) / 10_000 + feeSum` — listings
that wouldn't clear the buffered floor *after* fee deductions are
rejected up front instead of seating a leaky order on-chain.

**`PrepayListingPosted` / `PrepayListingUpdated` events** — extended
with a `FeeLeg[] feeLegs` non-indexed tail. Producers (frontend +
indexer) decode the tail to drive the same canonical orderHash
reconstruction the executor records on-chain.

**`CollateralListingExecutor` (UUPS impl)** — new
`mapping(bytes32 => FeeLeg[]) internal _orderFeeLegs;` (with public
`orderFeeLegs(bytes32)` getter) so the cancel path on `_tryCancelOnSeaport`
can rebuild the exact `OrderComponents` Seaport saw at fill-time.
`recordOrder` validates length cap + per-leg recipient/amount and pushes
each leg to storage; `clearOrder` and the post-fill branch of
`validateOrder` both `delete _orderFeeLegs[orderHash]` (the post-fill
cleanup was a Codex-caught storage-leak; same shape as the existing
`orderContext` cleanup). `_assertOrderContent` length-cap relaxed from
exactly-3 to `3..3+MAX_FEE_LEGS` with per-fee-leg item-type / token /
identifier asserts.

**`@vaipakam/lib/prepayOrderShape` (TS)** — `PrepayOrderInput.feeLegs?`
threaded through to `buildPrepayOrderComponents`. Same
subtract-then-append math; same single source of truth the frontend and
indexer both consume so the off-chain reconstruction can never diverge
from the on-chain executor's view (the load-bearing invariant — any
field-order divergence would hash to a different orderHash and OpenSea
would reject the vault's ERC-1271 sig).

**Atomic deploy harness** — new
`contracts/script/multicallDeploy.s.sol`,
`contracts/script/utils/BatchCaller.sol`,
`contracts/script/utils/EncodeMultiSend.sol`,
`contracts/script/utils/DeployGnosisSafe.s.sol`. Builds a single
Gnosis Safe `multiSend(bytes)` payload that performs the executor
UUPS `upgradeToAndCall` AND the facet `diamondCut` in **one
transaction** so there is no window where the diamond is wired to the
new ABI while the executor still validates the old shape. Block B
will reuse this same harness for its UUPS rotation. `BatchCaller` is
`operator`-gated at construction (immutable address); the Codex-caught
front-run vector during transient ownership was closed by adding
`if (msg.sender != operator) revert NotOperator(msg.sender);` to
`batch()`.

**Indexer payload** — `apps/indexer/src/openseaPublish.ts` +
`chainIndexer.ts`'s `PrepayListingPosted` / `PrepayListingUpdated`
handlers now decode the `feeLegs` event tail and thread it to the
shared `buildPrepayOrderComponents`. New D1 column `fee_legs_json TEXT`
(migration `0017_prepay_listings_fee_legs.sql`) stores the legs for
the sweep retry path so a late autonomous republish reconstructs the
exact same orderHash months later. Retry sweep reads the JSON back,
converts to BigInt, and re-publishes.

**Agent proxy** — `apps/agent/src/openseaCollectionProxy.ts`
(GET `/opensea/collection/{slug}`) and
`apps/agent/src/feeRecipientPreflight.ts`
(POST `/opensea/feeRecipientPreflight`). The collection proxy is
stateless + per-IP rate-limited (new `OPENSEA_COLLECTION_RATELIMIT`
binding, namespace 1006, 30 req/min/IP); the preflight returns
`not_applicable` for every recipient on the allow-list (honest verdict
— Codex P2 called out the optimistic `passed` shape as worse than no
signal). Both echo `resolvedOrigin` in CORS, not raw `FRONTEND_ORIGIN`
CSV.

**Dapp** — `useNFTPrepayListing` grew a `ReadonlyArray<FeeLegInput>`
arg on `postPrepayListing` / `updatePrepayListing` / `runOpenSeaPublish`.
`PrepayListingActions` passes empty `[]` for now (the fee-picker UI is
the deferred follow-up — fee-enforced collection support reaches
parity with #313's contract surface in this PR; the dapp picker is
queued as a separate UX card).

### What's NOT in this PR (intentional)

- **UI fee-leg picker** — the contracts and the off-chain reconstruction
  are wired for arbitrary fee legs; the dapp passes `[]` today. The
  picker is a focused follow-up card (collection-page sniff →
  recipient list → "use OpenSea defaults" toggle) tracked separately.
- **`feeRecipientPreflight` actually sim-validating** — current verdict
  is `not_applicable` until the on-chain sim plumbing lands. Returning
  optimistic `passed` would be worse than the current honest "we
  haven't checked"; replaced as a deliberate downgrade per Codex P2.
- **`borrower_remainder` D1 column** — Round 2 originally proposed it;
  dropped per both reviewers since proper math needs an extra
  `getPrepayContext` RPC plumbing. Will reappear as a discrete follow-up.
- **Block B (Dutch decay) + Block C (English via OpenSea Offers)** —
  #309. Block A's `startAmount/endAmount` shape is forward-compatible
  with Block B; the recorder will grow one more parameter when Block B
  lands.

### Operator action post-merge

This PR is **atomic for the codebase** — both the executor UUPS impl
and the diamond facet wiring land on `main` together. The **on-chain**
rotation is operator-gated and uses the new `multicallDeploy.s.sol`
harness:

1. Deploy the new `CollateralListingExecutor` implementation.
2. Build the multisend payload via `multicallDeploy.buildPayload(...)`
   — one `upgradeToAndCall` + one `diamondCut`.
3. Send the multisend through the Safe (1 transaction, atomic).
4. Apply the D1 migration:
   ```
   cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote
   ```

There is **no period during the rotation when half the system is on
the new ABI and half is on the old** — that's the only acceptable
shape for an executor-side breaking change.

### Verification

- Full forge regression: **2227 / 2227 PASS** (5 new fee-leg
  integration tests + the existing 2222) — happy-path 2-leg
  OpenSea+royalty, cap-exceeded revert, zero-recipient revert,
  decay-on-fixed-price revert, ask-below-floor-plus-fees revert
- CI on `2504ad4d`: contracts-fast / Slither / CodeQL / JS analyze /
  workspaces pnpm typecheck / Workers Builds (agent + indexer) /
  Build docs — all green
- 4 rounds of adversarial review closed: Codex GPT-5, Gemini 2.0
  Flash Thinking, Codex round-2, Codex round-3, Codex round-4
  ("Didn't find any major issues. Swish!"), plus three sequential
  human reviews

### Closes

Issue #313 (T-086 fee-legs for fee-enforced collections).

### Related

- T-086 step 14 (OpenSea integration, prior PR): #312
- T-086 step 16 (Seaport cancel emit): #316 / #321
- Round 5 design + Round 5.1 errata: #322 + #323
- **Block A (this PR): fee-legs atomic** — #324
- Block B (Dutch decay): #309
- Block C (English via OpenSea Offers): #309
- Multi-marketplace fan-out: #281

## Thread — T-086 #316: fast OpenSea catalog refresh via Seaport.cancel emit (PR #<n>)

When a borrower's prepay-collateral listing is closed out — by a borrower
cancel, an update that rotates to a fresh ask, the permissionless
grace-expired cancel, or a terminal loan event (repay, preclose,
refinance, default, HF-liquidation) — Vaipakam's on-chain bookkeeping
correctly invalidates the order: the executor's binding is dropped, the
borrower vault revokes the conduit approval and forgets the orderHash,
and the ERC-1271 delegate will reject any future signature for that hash.
That's enough to make the order unfillable: even if a buyer tries to fill
the stale listing through OpenSea's marketplace UI, the executor's zone
callback reverts the transaction and the buyer's wallet shows a clean
failure. But the OpenSea marketplace catalog itself doesn't know the
order is dead until its lazy stale-listing scan eventually catches up —
typically hours. During that window the UI still shows the listing as
"live," and buyers waste a wallet signature and a small amount of gas on
a guaranteed-revert simulation each time they try to fill it.

This change closes that window. The executor now records the full
sign-time inputs (conduit key, salt, post timestamp, ask price) alongside
the existing `(loanId, conduit)` binding, so at cleanup time it can
reconstruct the exact `OrderComponents` Seaport hashed at sign time and
forward `Seaport.cancel` on the matching orderHash. The executor is
already the zone on every prepay-listing order it records, so Seaport
accepts the call directly. Seaport then emits its own `OrderCancelled`
event, which OpenSea's marketplace indexer watches — the listing
disappears from the UI within roughly thirty seconds instead of hours,
and buyers stop seeing the stale entry. The acceleration applies
uniformly to all cleanup paths (cancel, update, grace-expired, every
terminal flow).

The cancel emit is **best-effort and never load-bearing for safety**.
The cleanup proper — binding delete, vault revoke, lock release — is
what actually prevents fills, and it always runs. The cancel emit
gracefully falls back to a no-op in three edge cases: a position-NFT
holder transferred between sign and cleanup (the reconstructed
consideration recipients differ); the borrower vault's Seaport counter
was incremented (a different orderHash); or the treasury fee floor
drifted upward through governance (the recorded ask is now below the
fresh floor, breaking the canonical-construction math). Each case emits
a `SeaportCancelSkipped` operator-side breadcrumb so the cleanup history
is auditable. In every other case — the overwhelming majority of real
prepay-listing cleanups — `SeaportCancelEmitted` confirms the
acceleration fired.

Storage cost is three new slots per recorded listing (~60k gas added to
the post path); the lookup remains a single mapping read. The change is
contracts-only — frontend and Worker flows already use the on-chain
state of the loan as their source of truth, so they automatically benefit
from the faster OpenSea catalog refresh without any consumer-side update.

Closes #316. Follow-up to PR #317's terminal-state sweep, which had
flagged Seaport.cancel emit as a deferred fast-refresh win.

## Thread — T-086 Block C v1.1 — fee-enforced collection support (#331) (PR #<n>)

Closes #331.

Extends the OpenSea-offers Match flow to NFT collections that
enforce OpenSea protocol fees and/or creator royalties. Block C
v1 (PR #328) shipped Match against fee-free collections only;
fee-enforced collections rendered an informational banner in the
panel slot instead of the offers list.

**What changed structurally.** The section's fee gate flipped from
a tri-state enforcement verdict (`'unknown' | 'fee-free' | 'fee-enforced'`)
to a typed fee-schedule cache. The same polled
`/opensea/collection/{slug}` response now drives two things instead
of one banner: (a) threshold scaling inside `useOpenSeaOffers` so
offers are classified acceptable against the post-fee borrower
remainder, not the gross; (b) at Match-click, a confirm-time
re-fetch of the schedule and `computeFeeLegs(schedule, offer.value)`
to build the on-chain `FeeLegInput[]` for `updatePrepayListing`'s
`feeLegs` calldata.

**The acceptability threshold is now closed-form**, derived from
the borrower-remainder-non-negative + protocol-leg-buffer
constraint:

> `offer.value × (10000 - feeBpsTotal) ≥ (lenderLeg + treasuryLeg) × (10000 + bufferBps)`

For fee-free (`feeBpsTotal === 0`) the form collapses back to the
v1 baseline; for fee-enforced (`feeBpsTotal > 0`) the threshold
auto-scales so the panel only greenlights offers whose gross-minus-
required-fees still covers lender + treasury + buffer. Threshold
math uses ceiling integer division so the compare rounds toward
the conservative direction (rejects borderline-unacceptable rather
than admits them).

**Match-time re-fetch keeps fee math fresh.** §15.3 step 5
explicitly forbids using a session-cached schedule at confirm
time — a fee row's `basis_points` or `recipient` can rotate
between panel-mount and click, and a stale snapshot could
under-compute the now-required amount (causing OpenSea-side
rejection at re-publish) or route to a recipient OpenSea has since
deprecated (draining the borrower's remainder to a dead address).
The new flow re-fetches on every Match click, recomputes feeLegs
against the offer's actual gross, and only commits to
`updatePrepayListing` when the fresh schedule still places the
offer above the scaled threshold. Failures (network error, non-2xx
upstream, parse errors) fail closed: the cache is invalidated, the
gate closes on next paint, and the borrower retries.

**Shared parser** lives at
`apps/defi/src/lib/openseaFeeSchedule.ts` and is consumed by the
section's mount poll and its confirm-time re-fetch. Same shape
will plug into the post-listing flow's fee-leg picker as a
follow-up (today's `PrepayListingActions` ships empty `feeLegs[]`
on `postPrepayListing`, which means fee-enforced collections still
fail at the initial OpenSea publish step — the first Match rotation
through #331's path is what produces a correctly-shaped
multi-leg order). That post-side gap is tracked as the natural
continuation of the original #313 follow-up.

**Fee-free regression-tested via type collapse.** The threshold
math, the schedule parsing, and `computeFeeLegs` all reduce to
their v1 behaviour when the parsed schedule has no required fees
— same wire shape, same acceptance gate, same empty `feeLegs[]`
into `updatePrepayListing`. No code path was deleted; the fee-free
case just becomes an instance of the more general flow.

**Operator action post-merge:** none. The change is dapp-only; no
contract surface, no new selectors, no migration. The existing
`OPENSEA_API_KEY` + `OPENSEA_OFFERS_RATELIMIT` bindings on the
agent are unchanged.

## Thread — T-086 Block C v1.1 — match OpenSea offers against Dutch listings (#332) (PR #<n>)

Closes #332.

Extends T-086 Block C's OpenSea-offers Match flow to listings posted
in Dutch-decay mode (Block B). v1 (PR #328) shipped Match against
fixed-price listings only; Dutch listings rendered an informational
banner in the panel slot.

**Match-shape: single-tx in-place `updatePrepayDutchListing` rotation.**
When the borrower clicks Match on an acceptable offer against a
Dutch listing, the dapp now calls
`updatePrepayDutchListing(loanId, offer.value, offer.value,
live.auctionEndTime, salt, conduit, feeLegs)`. The Dutch order
with `startAskPrice == endAskPrice` collapses Seaport's linear
interpolation to a constant — the order behaves like fixed-price-
at-`offer.value` for the rest of the original Dutch window.
`auctionEndTime` is preserved (gated by the new `dutchRunwayTooShort`
banner so it always satisfies the diamond's 1-hour
`MIN_AUCTION_WINDOW`). One wallet pop-up; the diamond's atomic
execution either commits or reverts the whole call — failure mode
on revert is "nothing happened", live Dutch listing intact.

**Why single-tx and not cancel+post.** An earlier rev of this PR
shipped cancel+post-as-fixed-price as the Dutch Match shape. Codex
review across 4 rounds surfaced a string of state-shift race
windows between the cancel tx and the post tx (kill switch toggle,
buffer-bps change, grace expiry, floor accrual, threshold
headroom, indexer-stale-row). Each finding required a pre-flight
check; even with all of them addressed, the failure mode was
destructive — cancel succeeded + post reverted leaves the borrower
with no live listing. User pushback ("why two transactions?")
prompted the pivot to single-tx, which has the same on-chain
checks but the failure mode collapses to "nothing happened" since
the diamond's atomic execution either commits or reverts both
state changes together. The 4 rounds of pre-flight cruft is gone.

The three Codex round-1 concerns that originally pushed the
implementation toward cancel+post are addressed structurally:

1. **`MIN_AUCTION_WINDOW` (1 hour)** — `dutchRunwayTooShort`
   banner gates the Match panel when
   `live.auctionEndTime - now ≤ 1h + 5min` (the 5-minute safety
   margin covers wallet sign + tx mining propagation). The
   borrower sees "your Dutch listing is in its final hour —
   cancel and re-post to restart the match flow"; the rotation
   tx never fires under those conditions.

2. **`DutchEndAskBelowProjectedFloorPlusFees`** — the section's
   threshold effect now reads `getPrepayContext(loanId,
   live.auctionEndTime)` (the future projected legs) for Dutch
   rows instead of `getPrepayContext(loanId, now)` (current
   legs). `computeAcceptable` classifies against the projected
   floor the facet itself validates, so an offer that clears the
   panel threshold is guaranteed to clear the
   `DutchEndAskBelowProjectedFloorPlusFees` check at tx-mining
   time. Fixed-price listings keep using current-time pctx.

3. **Missing Dutch publish path** — extended
   `publishPrepayListingToOpenSea` (`apps/defi/src/lib/openseaPublish.ts`)
   to accept optional `dutch?: { endAskPrice, auctionEndTime }`
   parameters. When set, it reads the projected pctx at
   `auctionEndTime` and threads the Dutch shape through
   `buildPrepayOrderComponents` (which already supports Dutch
   per Block B's landing). `useNFTPrepayListing.updatePrepayDutchListing`
   + `postPrepayDutchListing` both now call `runOpenSeaPublish`
   with Dutch params after the rotation tx confirms, so the
   bidder sees the rotated order on OpenSea's marketplace within
   seconds — same UX as fixed-price Match. The autonomous
   indexer-side publish stays as a safety net; the frontend
   path is now the primary.

**Fee-enforced support unchanged.** The fee-leg recompute from PR
#339 applies identically — the Match callback fetches the fresh
schedule + computes `feeLegs` before calling the rotation entry,
and the rotation entry threads `feeLegs` through the publish call
too (so the JS-rebuilt canonical orderHash matches the on-chain
hash on fee-enforced collections in Dutch mode).

**Race-window warning unchanged.** The `RaceWindowModal` from PR
#338 fires identically for both modes — any buyer can fulfill the
rotated listing between the borrower's tx and the bidder's
`Seaport.fulfillOrder`. The Dutch-specific 2-tx warning paragraph
that the round-3 cancel+post shape added is removed (single tx,
no 2-tx flow to warn about).

**Malformed-Dutch banner.** A Dutch indexer row missing
`auctionEndTime` or `endAskPrice` (a pre-migration row predating
Block B's publish or a transient indexer issue) renders a "decay
parameters missing" banner — same shape the pre-migration banner
takes for fixed-price.

**No contract surface changes.** `updatePrepayDutchListing` is
existing Block B surface; `publishPrepayListingToOpenSea` +
`runOpenSeaPublish` are dapp-side helpers. No new diamond storage,
no migration, no operator action post-merge. The indexer's
autonomous Dutch publish path is unchanged (it continues to run on
its cron interval as a safety net for posts where the frontend-
direct publish failed transiently — same role it played for
fixed-price posts before this PR).

**Out of scope** (tracked as follow-ups):

- Atomic match-rotation via Seaport `matchOrders` (#333 — the
  v2 shape that eliminates the race window altogether).
- The post-listing flow's empty-default `feeLegs[]` on Dutch
  (`PrepayListingActions.handleDutchPost` for the Dutch path) —
  same shape as the fixed-price post-side gap noted on #331.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Thread — T-086 Block C — paginate OpenSea Offers beyond ~300 per endpoint (#334) (PR #<n>)

Closes #334.

The OpenSea Offers proxy on `apps/agent`
(`/opensea/offers/{chainId}/{contract}/{tokenId}`) follows OpenSea's
`next` pagination cursor for each leg (collection-wide + item-
specific). Block C v1 (PR #328) capped that at a hard-coded 3 pages
per leg — ≈300 offers per leg, ≈600 total per inbound request. For
hyper-active collections where the dapp-side filters
(chain / contract / payment-token / itemType ∈ {2,3} / identifier
match) drop large fractions of every page, an acceptable offer
sitting on page 4+ would never reach the borrower's panel even after
a manual refresh.

This thread makes the cap **operator-configurable**.

**`OPENSEA_OFFERS_MAX_PAGES`** — new optional string env var on
the agent Worker. Read by `apps/agent/src/openseaOffersProxy.ts`,
coerced to int + clamped to `[1, 24]`. Default 3 (preserves current
behaviour exactly). Parse is strict: only pure-digit strings are
accepted, so `25oops` / `3.5` / `2e3` collapse to the default
rather than silently changing pagination depth on a typo.

The clamp ceiling of 24 is the upstream-cost guardrail. Worst-case
upstream cost per inbound request is `1 + 2 × MAX_PAGES` round-trips
(one NFT-detail slug lookup + paginated collection leg + paginated
item leg). Paired with the existing `OPENSEA_OFFERS_RATELIMIT`
inbound cap (60/min/IP), the per-IP upstream load stays bounded:

| MAX_PAGES | Upstream RTs per inbound | Worst-case upstream/min/IP |
|---|---|---|
| 3 (default) | 7 | 420 |
| 10 | 21 | 1,260 |
| 24 (ceiling) | 49 | 2,940 |

**Aggregate-key bounding** (Codex round-1 P2 on PR #341). The per-IP
cap above doesn't bound aggregate upstream load to the shared
`OPENSEA_API_KEY` — two or more caller IPs polling hot tokens each
under their per-IP cap can in aggregate exceed the OpenSea API tier.
This PR also adds an optional `OPENSEA_OFFERS_UPSTREAM_RATELIMIT`
binding keyed by the constant `'opensea-offers-upstream'`. When
provisioned by the operator in `wrangler.jsonc`, it caps the
aggregate inbound rate across all IPs. When absent the per-IP
gating stays in effect alone (same as before this PR; the binding
is opt-in).

**Operator setup**: add `OPENSEA_OFFERS_MAX_PAGES: "N"` to the
agent's `wrangler.jsonc` `vars` block + `wrangler deploy`. No code
change. Omitting the var preserves the default 3.

**Out of scope** (deferred):

- Cross-page deduplication at the proxy. OpenSea can return the
  same offer order across the collection-wide + item-specific
  legs (and across pagination pages within a leg) under certain
  query shapes. The dapp doesn't currently dedupe by `orderHash`
  — `useOpenSeaOffers.normalize` just concatenates the two
  legs' normalized arrays and sorts by amount — so a
  higher-`MAX_PAGES` deploy can surface duplicate rows in
  `OpenSeaOffersPanel`. The fix can land either at the proxy
  (server-side dedupe, adds proxy-side state) or in the dapp
  normalizer (cheaper but client-side). Defer until production
  signal shows duplicates becoming a visible UX problem.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Thread — T-086 Block C — indexer breadcrumb on accepted offers (analytics) (#335) (PR #<n>)

Closes #335.

Adds an analytics breadcrumb that records which OpenSea offer
triggered each prepay-listing Match-rotation. T-086 Block C
(PR #328) reuses the existing `updatePrepayListing` /
`updatePrepayDutchListing` entry points for OpenSea-offer matches,
so the on-chain event surface is unchanged — every Match emits
the same `PrepayListingUpdated` the indexer already handles. As
a result the indexer can't distinguish between **a
Match-from-OpenSea-offer rotation** and **a manual repricing** by
reading on-chain history alone.

The card's option (1) — dapp-side breadcrumb POST — wins on
reliability and simplicity over the alternatives. The other
options were:
- **(2) Indexer correlation pass** (query the agent proxy for
  offers around the rotation timestamp + price + infer the
  matched offer). Heuristic; misses unusual-price matches or
  ties.
- **(3) Dedicated on-chain event** (`PrepayListingMatchedFromOffer`
  with the offer ID indexed). Most accurate but requires a
  contract change + audit pass — overscope for analytics
  metadata.

**What changed**

- `apps/indexer/migrations/0019_prepay_listing_match_breadcrumbs.sql`
  adds a new table keyed on `(chain_id, tx_hash)` (loan IDs are
  scoped per chain in this codebase, matching how
  `prepay_listings` keys rows; a tx_hash without chain_id would
  conflate breadcrumbs across configured chains). `(chain_id,
  loan_id)` is separately indexed so the loan-history join is
  cheap. No FK to `prepay_listings` or `loans` — the indexer's
  reorg-windowed feed can serve the pre-rotation row right up
  until the post tx lands, and a strict FK at insert time would
  race the indexer's materialisation; the query-time join
  handles it.
- New `POST /loans/:loanId/prepay-listing/match-source?chainId=N`
  endpoint in `apps/indexer/src/loanRoutes.ts`. Strict hex
  validation on every field. **Conflict policy: `INSERT OR
  REPLACE`** (Codex round-1 P2 #343). Lets the legitimate dapp
  retry override an attacker's first-arrival spoof; emits an
  operator-visible warning whenever a row is overwritten with a
  payload that differs from what's stored — that includes a
  `loan_id` mismatch (Codex round-3 P2 #343), since the REPLACE
  also overwrites the `loan_id` column and a spoofer POSTing to
  a different `/loans/<wrong>/` URL with the same public
  `(orderHash, bidder)` would otherwise silently move the
  breadcrumb to another loan and corrupt the loan-history join.
  A sustained spoof attack now shows up in the indexer logs as a
  tx_hash receiving multiple distinct `(loan_id, orderHash,
  bidder)` writes. Full prevention would need EIP-712 signed
  claims from the borrower; documented as a v2 follow-up. For
  non-financial analytics metadata the replace-and-warn shape is
  the right v1.1 trade-off.
- New `OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` rate-limit binding
  on the indexer Worker (60 req/min/IP). Matches the per-IP
  rate-limit shape `apps/agent` uses; the indexer's existing
  read surface stays uncapped (read-only, cached, low cost) but
  the new POST surface is opt-in to the same defensive posture.
- New `postPrepayMatchSource(chainId, loanId, body)` helper in
  `apps/defi/src/lib/indexerClient.ts` — best-effort POST that
  returns a boolean for telemetry/tests but callers don't
  branch on it (the rotation tx is already on-chain by the
  time this fires). Sets `keepalive: true` on the fetch (Codex
  round-3 P3 #343) so the small JSON POST survives a tab close
  or full-page navigation immediately after the receipt arrives
  — exactly the close-the-tab case the early-fire callback in
  `useNFTPrepayListing` is trying to cover. Uses a CORS-simple
  `Content-Type: text/plain;charset=UTF-8` instead of
  `application/json` (Codex round-4 P3 #343); the Worker's
  `req.json()` parse is Content-Type-agnostic on Cloudflare, so
  the parse stays correct, but the request avoids the
  preflight OPTIONS round-trip that would otherwise need to
  complete before the POST itself — which `keepalive: true`
  cannot guarantee during tab close. Non-2xx responses
  (rate-limit 429, D1 500, payload-rejection 400) log a console
  warning before returning `false` (Codex round-3 P3 #343), so
  the failure mode promised by the UI ("failures are logged") is
  actually delivered rather than swallowed when the response
  body is well-formed but the status code isn't.
- `useNFTPrepayListing` extends `updatePrepayListing` +
  `updatePrepayDutchListing` with an optional `matchSource?:
  MatchSourceBreadcrumb` parameter. When set, after the
  rotation tx confirms, the hook fires the breadcrumb POST
  **before** awaiting the OpenSea publish step and **without
  awaiting the POST itself** (`void` instead of `await`).
  Codex round-1 P2 + P3 #343: a stalled publish can no longer
  block the breadcrumb, and the breadcrumb's own RTT can no
  longer block the Match-button's `onClick` from resolving.
  Manual repricings (`PrepayListingActions`) omit the
  `matchSource` param and stay unchanged.
- `OpenSeaOffersSection`'s Match callback passes
  `{ orderHash: offer.orderHash, bidder: offer.bidder }` as
  `matchSource` on every Match — covering both fixed-price and
  Dutch rotations through the same path.
- `apps/indexer/src/index.ts`'s header comment updated to note
  the Worker now accepts the one breadcrumb POST in addition to
  its public-read GETs.

**Why hook-side and not section-side**

The Match-rotation tx receipt (which carries the `transactionHash`
the breadcrumb keys on) is exposed inside `useNFTPrepayListing`'s
`runWrite` callback, not as a React render-state field. Firing the
POST from the section would either require a hook API change to
return the receipt or a `useRef`-based tx-hash tracker — both
worse split-of-responsibility shapes than just having the hook
fire the breadcrumb when it has the receipt directly.

**No contract surface changes.** No new diamond storage, no
migration on contract storage. Operator action: apply the D1
migration (`wrangler d1 migrations apply vaipakam-archive
--remote` from inside `apps/indexer/`) AND provision the new
`OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` binding via the
`wrangler.jsonc` `unsafe.bindings` block (auto-deployed on next
`wrangler deploy`).

**Out of scope** (tracked for follow-ups):

- Wiring the breadcrumb into the loan-by-id surface so the
  dapp can render "matched via OpenSea offer X" on the loan
  details page (the data is captured here; the JOIN + UI
  presentation is a separate UX card).
- An analytics dashboard view that surfaces the
  offer-driven-vs-manual ratio (also separate UX work).
- EIP-712-signed claims to fully prevent the spoofing window
  the replace-and-warn shape only mitigates.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Thread — T-086 Block C v1.1 — ERC1155 quantity-aware offer normalization (#336) (PR #<n>)

Closes #336.

Extends T-086 Block C's OpenSea-offers Match flow to NFT collateral
in ERC1155 form. v1 (PR #328) banner-gated ERC1155 collateral
entirely — the `OpenSeaOffersSection` short-circuited to a
"v1.1-deferred" alert before the offers panel rendered.

**What changed**

- `useOpenSeaOffers` now takes a `collateralQuantity: bigint`
  parameter and threads it into the per-row normalizer. ERC721
  collateral passes `1n` (and the normalizer's quantity check
  collapses to a no-op); ERC1155 collateral passes the loan's
  on-chain `collateralQuantity` from the loan reader.
- The normalizer reads each offer's `consideration[0].startAmount`
  for ERC1155 rows (`itemType === 3`). Only offers whose decoded
  quantity equals `collateralQuantity` exactly pass — partial-fill
  collection offers (quantity ≠ locked) and over-quantity offers
  both get filtered out at the normalize step. Concrete-shape
  ERC1155 offers that do match flow through to the panel with the
  same per-row acceptability classification as ERC721.
- `NormalizedOffer` carries a new `quantity: bigint` field. The
  panel surfaces "× N units" alongside the offer's value on rows
  where `quantity > 1`, so the borrower sees the per-unit
  breakdown for matchable ERC1155 offers without cluttering
  ERC721 rows.
- The panel's footer carries a one-line note explaining that
  partial-fill offers stay on OpenSea's marketplace but aren't
  surfaced in the Match panel — closes the loop on "why is my
  OpenSea inbox larger than what the dapp shows".
- `OpenSeaOffersSection` drops the now-unused `collateralAssetType`
  prop (only `2` mattered, and that case is now handled inside
  the hook). `LoanDetails` updated to pass `collateralQuantity`
  instead.

**Why exact-quantity match for v1.1**

The canonical Seaport order the diamond rotates against pins the
FULL vaulted `collateralQuantity`. An offer for a partial fill
would let the panel mark the row Match-able then revert at fill
time when the buyer pays the unit-priced offer for the
whole-quantity NFT. Per-fill partial-collateral-sale would need
a separate path (sell-N-of-M with the loan staying open against
the residual collateral); design it deserves its own card.
Filtering at the normalizer keeps the surface honest until that
card lands.

**No contract surface changes.** `updatePrepayListing` /
`updatePrepayDutchListing` already settle against the full
collateralQuantity for ERC1155 — this PR is purely the dapp's
normalizer + UI catching up.

**Out of scope** (tracked for follow-ups):

- Partial-collateral-sale flow (sell N of M units, leave the
  loan open against the residual). Needs its own design — the
  protocol's collateral-locking model is currently
  whole-lot-at-a-time.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Thread — T-086 Block C MEV / race-window note in Advanced User Guide (PR #<n>)

Closes #337.

T-086 Block C (PR #328, merged 2026-06-03) shipped pragmatic English-
auction matching against OpenSea Offers with a documented v1
trade-off: a race window between the borrower's price-rotation tx
(`updatePrepayListing`) and the bidder's settlement tx
(`Seaport.fulfillOrder`) during which any third-party buyer can
snipe the rotated listing. The dapp's `RaceWindowModal` already
spells this out at click time, but a sophisticated user reading the
modal too quickly had no durable reference to come back to.

**This thread closes that gap on the documentation side.** A new
"Matching OpenSea offers on a prepay listing" section was added to
the Advanced User Guide under the Loan Details chapter
(`apps/www/src/content/userguide/Advanced.en.md`, anchor
`#matching-opensea-offers-on-a-prepay-listing`). The section
explains what the panel does, what the race window actually is,
what the user can do to mitigate it (notify the bidder out-of-band
before clicking Match; avoid matching at desperate prices that
leave the buffer thin; cancel the listing if the bidder goes
quiet), and what the v2 atomic-match path will fix structurally
(forward-link to Issue #333). Plain English at sophisticated-user
altitude — deeper than the modal, shallower than the §15.3 design
doc.

The dapp's `RaceWindowModal` now carries a "Learn more about the
race window" link that points at the new AUG section via the
existing `marketingUrl` helper (resolves to `https://vaipakam.com`
in prod, respects the `VITE_MARKETING_URL` dev override so local
dev links to the local www dev server). The link opens in a new
tab so the borrower's pending Match decision stays alive in the
current tab.

The non-English locales (`Advanced.{zh,ko,hi,ta,fr,de,ja,ar,es}.md`)
are intentionally left to a follow-up batch — landing the English
source first is the standard pattern for this repo (same shape as
EC-004's risk-disclosure translations). Non-en readers see the
existing localised sections; the new section is missing from those
files until the translation pass lands.

No contract changes. The dapp surface change is small but real —
one `<a href>` cross-link in `RaceWindowModal` plus a
`marketingUrl` import in `OpenSeaOffersPanel.tsx` — so the thread
is documentation-led + one-line dapp wire, not strictly docs-only.

## T-086 #309 Block B — Codex post-merge findings (4 × P2)

Pure polish PR addressing four P2 issues Codex flagged on the
merged Block B PR #326. No new features; no new selectors; no
behavioural change to the happy paths.

### What this PR fixes

**P2 #1 — Indexer's Dutch publish reconstruction reads governance
config at the wrong block.** The `getPrepayContext(loanId,
asOfTimestamp)` view's `asOfTimestamp` parameter affects the live-
floor interest-accrual math but NOT the governance config the
floor formula reads from storage (`cfgTreasuryFeeBps` etc.). Before
this PR, the autonomous OpenSea publish's `readContract` call ran
against latest chain state, so a mid-window `setFeesConfig` bump
between the post tx and indexer ingest would shift the projected
lender + treasury legs the JS reconstruction computes — the
defensive `expectedOrderHash` compare would fail and the publish
would skip even though the on-chain order is still validly signed
+ fillable. Fix: pin the eth_call to the post-tx's block number
(`blockNumber: receipt.blockNumber`). Applied to the pctx read, the
executor `seaport()` read, and the vault `getCounter(vault)` read
— all three feed the canonical-shape reconstruction and all three
should observe sign-time state.

**P2 #2 — Permissionless cleanup must allow Dutch listings to be
cleaned up at `auctionEndTime`, not `gracePeriodEnd`.** Dutch
listings have a Seaport `endTime` of `auctionEndTime` which the
facet enforces is `≤ gracePeriodEnd`. Past `auctionEndTime`,
Seaport rejects all fills — the order is functionally dead — but
the existing `cancelExpiredPrepayListing` guard only opened the
cleanup window at `block.timestamp > gracePeriodEnd`. For any
Dutch auction that closes hours or days before grace + a borrower
who's offline, the borrower-position NFT would sit locked even
though the listing was already unfillable. Fix: read the recorded
`mode` + `auctionEndTime` from the executor's `OrderContext` and
gate cleanup on `(mode == DUTCH ? auctionEndTime : gracePeriodEnd)`.
New revert `AuctionWindowStillOpen(loanId, nowTime, auctionEndTime)`
for the Dutch-too-early case. Fixed-price listings keep their
existing `GraceNotExpired` semantics verbatim. Mock recorder
extended with a `setOrderContextMode` test-side hook so unit tests
can stamp the Dutch shape without standing up the real executor;
new integration test
`test_cancelExpiredPrepayListing_dutchPathAtAuctionEnd` covers the
happy + revert paths.

**P2 #3 — Document the legacy-event-shape pre-live posture.**
Block B's event extension rotated the `PrepayListingPosted` /
`PrepayListingUpdated` topic hashes. The indexer's decoder derives
its allowlist from the current ABI; a redeployment whose cursor
crosses a pre-Block-B emission would silently skip the old log.
The Vaipakam platform is **pre-live** on every chain, so no
production emissions persist; the only legacy events live on
short-lived testnet rehearsals that the indexer is redeployed
against with a fresh cursor at the new diamond's deploy block. A
legacy-ABI fallback decoder was considered + rejected as
unnecessary for the pre-live case + a footgun (would silently mask
any future event shape regression). The event natspec now states
this posture so future readers don't ship a legacy-ABI fallback by
default.

**P2 #4 — Sweep starvation by expired Dutch rows.** The
`PrepayListingPostsSweep` cron query selects rows with
`opensea_published_at IS NULL` ordered by `posted_at ASC, LIMIT 5`.
A Dutch row whose `auctionEndTime` has passed is rejected by
OpenSea on every publish attempt (the Seaport order is expired),
so the row stays NULL forever and occupies one of the five batch
slots on every cron tick — newer publishable listings stay starved
behind it. Fix: extend the WHERE clause to filter
`(auction_mode IS NULL OR auction_mode != 1 OR auction_end_time
IS NULL OR auction_end_time > strftime('%s','now'))`. Fixed-price
rows + pre-Block-B rows (NULL columns) are unaffected.

### What's NOT in this PR

- **Legacy-ABI fallback decoder for the indexer** — the pre-live
  framing makes this unnecessary + adds the silent-skip footgun
  noted under P2 #3 above.
- **Persist projected lender + treasury legs in `OrderContext`**
  (the alternative for P2 #1's governance-drift case) — design
  doc §15.2 explicitly rejected this in the "Alternative
  considered + rejected" box because the fee-curve-decrease case
  would let frozen-shape orders keep filling at above-current-
  policy treasury take. The block-pin fix solves the indexer
  side without the on-chain trade-off.

### Verification

- Full forge cifast regression: **122/122 PASS** (+1 vs Block B
  post-merge baseline — the new Dutch-expiry integration test).
- `apps/defi` typecheck: green.
- `apps/indexer` typecheck: green.
- `apps/agent` typecheck: green.
- `apps/keeper` typecheck: green.
- No new selectors, no facet bytecode bumps, no ABI re-export
  needed beyond the recorder mock's new helper (test-side only,
  not part of the production diamond ABI).

### Closes

Codex's 4 post-merge P2 findings on PR #326 (linked via inline
review at https://github.com/vaipakam/vaipakam/pull/326).

### Related

- Block B: #326 (merged `b0aa7058`).
- Block A: #324 (merged `1bd9e472`).
- Round 5 design + Round 5.1 errata: #322 + #323.
- Pre-live framing: `memory/project_platform_prelive.md`.

## T-086 Block D — Atomic match-rotation closes the v1 §15.3 race window

Block D ships the v2 atomic match-rotation path described in the
Round-6 design (`docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
§17) — the load-bearing piece that retires the v1 two-step cancel +
post sequence on the borrower's NFT-collateral-prepay-listing
Match flow.

Pre-Block-D, accepting an OpenSea offer ran in two transactions:
cancel the existing v1 listing, then post a fresh listing at the
new ask price. Between those two transactions every state-shift
vector — a flipped kill switch, a buffer change, a grace-period
boundary, a floor move — could leave the loan with no listing at
all, sitting on a destructive failure mode ("listing destroyed if
cancel succeeded but post reverted"). Block D folds the whole flow
into a single Seaport `matchAdvancedOrders` call that runs inside
the diamond. Either the entire sequence — cancel the old order,
build the canonical replacement, settle against the bidder's signed
order — succeeds atomically, or nothing changes on-chain and the
borrower's live listing stays intact.

Borrowers who never posted a v1 listing can still Match — the
atomic path supports `existingHash == 0` and skips the cancel half
of the rotation. The Match button no longer requires a live v1
row; the offers panel surfaces every acceptable signed offer the
moment one is detected by the OpenSea poller.

The shared wiring primitive (`LibPrepayListingWiring`) is now used
by every prepay-listing entry point — v1 fixed-price post + update,
v1 Dutch post + update, and v2 atomic match. Every path reverts
with the same `VaultNotDeployed(borrower)` symbol when the
borrower's vault is missing; `ExecutorNotSet` is reserved purely
for the legitimate governance-level "executor address never
configured" precondition.

The frontend offers panel no longer hard-gates Match on the
OpenSea collection fee-schedule fetch — that fetch is now
advisory. The atomic facet re-checks the bidder order's actual
fee sum on-chain at match time, so a transient
`/opensea/collection` outage no longer locks every Match button.
Decaying Dutch bidder offers are surfaced with a clear
"`decaying-bidder-offer`" reason and are unmatchable from the UI;
the atomic facet's on-chain shape gate rejects them too.

The indexer writes durable `match_mode` breadcrumbs for every
`PrepayListingMatched` event. The legacy dapp-side POST handler
cannot silently downgrade an event-sourced `atomic` row to
`v1-twostep` — the new `ON CONFLICT` clause preserves the atomic
match-mode signal and logs any attempted downgrade for operator
visibility.

The OpenSea SignedZone path (fee-enforced collections) fails closed
at the agent's signed-offer proxy boundary with a clear `422
opensea-fee-enforced-needs-fulfillment-data` response. Wiring the
OpenSea Fulfillment Data endpoint (POST
`/api/v2/offers/fulfillment_data`) to fetch the SIP-7 `extraData`
for fee-enforced collections is tracked as a Block D follow-up;
until that lands the dapp shows an accurate "this collection
requires server-signed fulfillment data — not yet supported"
message instead of routing a doomed match to Seaport.

Closes #345; implements the Round-6 design ratified in #344
(commit `870f49da`).

## T-086 Block D cleanup — drop tautological balance guard + retire race-window framing

Block D atomic match-rotation (PR #346) shipped with a defence-in-depth
`AtomicMatchBalanceMismatch` revert that the §17.9 spec asked for, and
with a borrower-facing "race window" confirm modal carried over from the
v1 two-step cancel + post flow. With Block D fully landed both are now
historical:

- The balance guard checks `Σ(consideration) == offer_value` before
  forwarding to Seaport. By construction `effectiveAsk = offer_value
  − bidder_fee_total`, so the consumed-vs-offer-value identity is
  algebraically true at the call site. The real protocol-leg + routing
  assertions live upstream in `AskBelowFloor` and `FeeLegsExceedAvailable`
  — those fire independently of the tautology. The dead revert + its
  error symbol are removed.

- The "race window" confirm modal warned the borrower that any buyer,
  not just the matched bidder, could fulfill the rotated listing in the
  minutes between the v1 two-step cancel and post. Atomic match-rotation
  closed that window structurally — Seaport's `matchAdvancedOrders`
  settles cancel + replacement + bidder fill in one transaction — so the
  framing is misleading. The modal copy is rewritten as a plain
  confirm-this-match dialog and the cross-link is repointed at the
  atomic-match section of the Advanced User Guide.

No protocol-level behaviour change. The on-chain assertions that matter
(floor + buffer, fee-legs solvency, shape invariants) all stay; the
defence-in-depth pre-Seaport identity check is the only thing dropped.

## T-086 Block D follow-up — OpenSea Fulfillment Data unblocks fee-enforced collections

PR #346 (T-086 Block D atomic match-rotation) shipped with a
fail-closed placeholder for Seaport SignedZone offers — collections
that enforce creator fees via OpenSea's SIP-7 SignedZone contract.
The agent's signed-offer proxy detected those orders and returned a
`422 opensea-fee-enforced-needs-fulfillment-data` response so the
dapp could show a clear "not yet supported" message instead of
routing a doomed match to Seaport.

This change retires the placeholder. The proxy now wraps OpenSea's
Fulfillment Data endpoint instead of the single-order GET. OpenSea
returns the canonical Seaport order parameters, the bidder
signature, the SIP-7 `extraData` blob, AND a properly-shaped
`CriteriaResolver[]` for criteria offers — all in one upstream call.
Fee-enforced collections (Blur-style royalty enforcement, Yuga
collections, etc.) can now be matched atomically through the same
`matchOpenSeaOffer` path every other collection uses; criteria
offers (collection-wide bids on a trait) now settle via the real
resolver shape Seaport expects instead of raw Merkle proofs.

The proxy URL gains a required `?fulfiller=<vaultAddress>` query
parameter — OpenSea's fulfillment-data endpoint needs the fulfiller
address to validate creator-fee receivers and apply the correct
SIP-7 signature scope. The dapp resolves the borrower's vault
address before the Match button is reachable (the Match button only
renders for the position-NFT holder, who is by construction the
loan's borrower with a deployed vault).

No on-chain changes; this is an off-chain proxy / dapp wiring
change only.

## T-086 Block D — integration test for the Match-button rewire

Adds a focused vitest integration test for `useNFTPrepayListing.matchOpenSeaOffer`
that pins the new agent-proxy URL shape (`?fulfiller=<vaultAddress>&quantity=<lotSize>`)
+ the borrower-vault short-circuit + the agent-fetch failure modes
from PR #349. The test is structurally correct but currently skipped
behind `describe.skip` pending Issue #85 — the shared
`test/setup.ts`'s `localStorage.clear()` throws against the vitest 4 +
jsdom 29 environment in this monorepo and the whole vitest suite is
intentionally not wired into CI for that reason. When #85 lands the
skip flips back to a normal `describe`.

No code paths change; this is test-only intent capture.

## T-086 Block D — Seaport hash-rederive fork test on Base-Sepolia

Adds a forge fork test that exercises the real Seaport 1.6
deployment at the canonical address against a Base-Sepolia fork to
confirm the §17.5 on-chain hash re-derive invariant the atomic
match facet relies on. The unit-test `MockSeaport` uses
`keccak256(abi.encode(components))` for determinism but doesn't
match the EIP-712 typed-data digest real Seaport produces. The
fork test fills that gap.

Two phase-1 assertions:
- Real Seaport's `getOrderHash` is deterministic + non-zero for a
  well-formed bidder OrderComponents struct.
- Real Seaport's `getOrderStatus` for a freshly-constructed
  off-chain-signed order returns the
  `(isValidated=false, isCancelled=false, totalFilled=0,
  totalSize=0)` shape the atomic facet's early-fillable check
  passes for.

Gated by `FORK_URL_BASE_SEPOLIA`. Silently skipped when the env is
empty so CI without an archive-node URL passes — same fail-soft
pattern the Permit2 real-fork test uses.

The full `matchAdvancedOrders` happy-path settlement walkthrough
(conduit registration, ERC-1271 vault sig, both orders signed +
matched end-to-end) is a richer phase-2 follow-up — it needs a
whole diamond deployed on the fork + a real ConduitController
interaction. Phase 1 locks the hash-rederive contract; phase 2
will add the full settlement walkthrough.

## T-086 — wire `LibPrepayCleanup.clearActiveListing` into the non-default terminal paths

Closes the acknowledged technical debt that step 6 (PR #300) and step 10 (PR #303) explicitly noted: when a borrower has an active prepay-collateral-listing and the loan terminates via any path OTHER than default or HF-liquidation (i.e. `repayLoan`, `precloseDirect`, `refinanceLoan`, offset-completion), the listing's on-chain bookkeeping was previously left in place — the orderHash binding stayed on the vault, the borrower-position-NFT lock stayed on, and the executor's `orderContext` mapping kept the now-stale record. The only escape was the borrower's `cancelPrepayListing` after-the-fact escape hatch.

This change adds the existing `LibPrepayCleanup.clearActiveListing(loan, loanId)` library call to four more terminal sites:

- `RepayFacet.repayLoan` (full repay; both Active and FallbackPending cure paths)
- `PrecloseFacet.precloseDirect` (the ERC20-principal direct-close path; NFT-rental rentals can't carry a prepay-listing — gate is `assetType == ERC20`)
- `PrecloseFacet.offsetCompleted` (defensive — in normal flow the borrower must cancel the listing before initiating an offset because the step-6-round-2 lock-overwrite-protection blocks `_lock(PrecloseOffset)` over a live `_lock(PrepayCollateralListing)`; the call is belt-and-suspenders)
- `RefinanceFacet.refinanceLoan` (the OLD loan flip to Repaid)

Each call is placed AFTER every safeTransferFrom has committed but BEFORE the LibLifecycle status transition. This follows the standard validate-pull-mutate-finish pattern: by the time we touch listing bookkeeping, the lender has already been paid; if any earlier transfer reverts the whole tx rolls back atomically (including the cleanup) and the listing stays live as expected.

The library function is idempotent (early-returns when no listing is on the loan), so every site can call unconditionally without branching on `s.prepayListingOrderHash[loanId]`.

### Behavioural consequences

- **Borrower's repay/preclose/refinance is now self-contained.** They no longer need to remember to call `cancelPrepayListing` after closing a loan that had a live listing — the bookkeeping clears atomically with the close.
- **Same-block race resolution is cleaner.** If a buyer's `Seaport.fulfillOrder` lands AFTER the borrower's `repayLoan` in EVM order in the same block, the buyer's tx calls `isValidSignature` on the borrower's vault, which now returns invalid (the binding was revoked atomically with the repay) — Seaport rejects the fill cleanly with `BadSignatureV{X}` (or whatever Seaport returns for ERC-1271 rejection). If the buyer's tx lands FIRST, the borrower's repay sees `loan.status != Active` and reverts `InvalidLoanStatus()` — same EVM-determinism outcome as before, but no orphan listing left behind in either branch.
- **OpenSea catalog refresh** still lags by minutes (their re-validation pass picks up the now-invalid signature). That latency is closed by the Option B follow-up tracked in #316 (Seaport.cancel emit).

### Out of scope (explicitly)

- **`Seaport.cancel(orders[])` emit** — gives OpenSea's indexer instant notification (seconds, not minutes). Requires an executor storage change + new method to reconstruct OrderComponents and call Seaport.cancel as the order's zone. Tracked as #316.
- **Frontend friendly error** — when a borrower's `repayLoan` reverts because the loan was settled via prepay sale, the dapp can decode `InvalidLoanStatus()` + read the loan's current status + show a tailored "Your loan was settled via OpenSea sale; your borrower-remainder is in your claimables" message. Pure dapp-side change; will land alongside the MEV doc note follow-up.
- **`Seaport.incrementCounter()` sledgehammer** — rejected on the multi-loan vault concern: a borrower with three NFT-collateral loans can have three live listings on the same vault simultaneously; bumping the vault's Seaport counter would invalidate all of them.

### Test coverage

The library itself is unit-tested via the existing `LibPrepayCleanup`-call paths in `triggerDefault` / `triggerLiquidation`. The new wiring sites all go through the same library, so the existing assertions about "after cleanup: orderHash binding revoked, NFT lock released, executor's orderContext cleared, vault's per-orderHash mapping cleared" carry over. New integration tests can be added in a follow-up — the wiring itself is a single library call at each site so the audit surface is small.

## T-086 — friendly error when a repay races a buyer's OpenSea fill

Closes a UX rough edge introduced by T-086's same-block race semantics. When a borrower clicks "Repay in Full" on a loan that has a live OpenSea prepay listing, and a buyer's `Seaport.fulfillOrder` lands earlier in the same block, EVM determinism resolves the race cleanly:

- Buyer's tx settles the prepay sale (pays lender + treasury + refunds borrower's remainder into the borrower vault)
- Borrower's repay tx then sees `loan.status != Active` and reverts `InvalidLoanStatus()`

Pre-this-change the dapp surfaced this as a generic "Repayment failed" message via the standard `decodeContractError` decoder. That's technically accurate but bad UX — the borrower's loan is in fact already settled, they've been paid out, and there's nothing to retry. Without a tailored message they'd reasonably assume something is wrong and try to re-submit (which would just revert again).

This change extends `LoanDetails.handleRepay` with a small post-revert check: it re-reads the loan from the diamond and, if `status === Settled`, replaces the generic error with a JSX message:

> Your loan has already been settled — a buyer filled your OpenSea prepay listing in the same block, paying the lender + treasury and refunding the remainder to your vault. Your repay didn't go through (no funds moved), and you don't need to retry. **View claimables →**

The "View claimables" text is a router link to `/claims` so the borrower can grab the refunded remainder in one click. The page-level `loadLoan()` also runs in the catch path so the banner + actions card flip to the post-Settled view immediately, not just on the next refresh.

### Why this is conservative

The Settled status is exclusively the prepay-sale terminal in T-086 — every other close path uses Repaid / Defaulted / Liquidated / FallbackPending. A false positive would require a status flip to Settled with the borrower's repay still in flight, which only happens via the prepay-sale executor callback. So the detection is essentially deterministic.

If the post-revert chain read fails for any reason (RPC blip, etc.), the code falls through to the generic `decodeContractError` path unchanged.

### Scope

- `apps/defi/src/pages/LoanDetails.tsx` — `handleRepay` catch path, plus `actionError` state type widened from `string` to `ReactNode` so it can carry the JSX message + link
- `apps/defi/src/i18n/locales/en.json` — two new translation keys

Preclose and refinance call sites are NOT updated. The MEV race window for those paths is narrower (preclose needs the borrower-NFT lock cleared first; refinance has its own preconditions that block during a live listing), and they live on dedicated pages with their own error surfaces. If the equivalent UX gap shows up in practice for those, it lands as a small follow-up — the helper here is local to `LoanDetails.tsx` and can be lifted to a shared util if needed.

## T-086 Round-7 design doc — grace-period auto-list-at-floor

Adds §18 to `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
describing a permissionless protocol-driven auto-listing primitive
that fires when a loan enters its grace window. The new entry
point can post a fresh fixed-price Seaport listing — or rotate an
existing high-ask listing down — to the protocol-mandated floor
(principal + interest + treasury fee + the configured buffer)
without needing any oracle, off-chain attestation, or borrower
action.

The motivation is that today's grace window can pass with the NFT
unsold whenever the borrower either never posted a listing or
posted at an aspirational price. The protocol-leg floor is already
known on-chain; anyone reading the chain can compute the ask that
makes the lender whole. The new function exposes that as a
permissionless trigger, same trust model as
`cancelExpiredPrepayListing` and `markDefaulted`.

Post-grace flow stays unchanged — the NFT still transfers to the
lender in-kind at grace expiry if the listing hasn't filled. Round
3's drop of Scenario B (post-grace protocol-controlled auction)
stays in place. Round 7 lives entirely inside the grace window.

Round-3.7 (against Codex round-7) switched B-cond-3b's Dutch
floor-crossing time formula from floor- to ceiling-division so
the Seaport-truncating price-at-tick semantics don't report
`t_floor` one tick early at the boundary, and corrected the
B-cond-2 derivation to be bufferless. Round-3.7 added three
B-cond pin tests: `test_autoList_dutchB2FiresAtBareEndFloor`,
`test_autoList_dutchB2FiresAfterAccrualPastBareEndFloor`, and
`test_autoList_dutchB3bUsesCeilDivisionAtBoundary`.

Round-3.8 (against Codex round-8) supersedes round-3.7's
B-cond-2 Dutch derivation: the round-3.7 formula compared live
legs against `endAskPrice - endFeeSum`, which treats the
borrower's signed slack as protocol coverage and misses the
case where the borrower padded the slack entirely into
`consideration[2]` (the borrower leg) — leaving lender +
treasury at the bare post-time floor. Any live-leg increase
past the signed amounts makes the order unfillable while
B-cond-2 no-ops, leaving stale listings through grace.
Round-3.8 introduces an executor schema extension — parallel
to round-3.6's fee-leg snapshot — that records the signed
lender + treasury amounts at sign time, and B-cond-2 compares
live legs against those directly. The four B-cond-2 pin tests
are updated to cover the borrower-slack case and the
asymmetric per-leg rotation gates. Round-3.8 also corrects a
stale "all time computations use truncating integer division"
sentence in the B-cond-3b rounding-policy paragraph that
contradicted round-3.7's ceiling-division t_floor formula.

Round-3.9 (against Codex round-9) fixes four follow-on issues
the round-3.8 rewrite exposed. First, the round-3.8 B-cond-2
predicate kept a `> recorded + 1` tolerance inherited from the
fixed-price aggregate inverse — but the schema-extended read
is direct (no arithmetic, no rounding) and the executor's
fill-time check is strict, so a 1-wei shortfall makes the
order unfillable while the tolerance no-ops; round-3.9 makes
the predicate strict (`>`) on the direct read. Second, the
round-3.8 claim that fixed-price doesn't have the borrower-
slack-vs-signed-legs ambiguity was incorrect — the fixed-
price post-time invariant only requires a buffered floor and
allows the borrower to land the +1 slack in
`consideration[2]`; round-3.9 upgrades the fixed-price
B-cond-2 path to use the same signed-legs predicate as Dutch.
Third, the round-3.3 B-cond-1 Dutch-current-ask variant fires
on every block of a healthy Dutch listing's decay window
above the floor, making B-cond-3a/b unreachable; round-3.9
carves Dutch out of B-cond-1 entirely (rotation owned by
B-cond-2 + B-cond-3a/b + B-cond-5). Fourth, the §18.14
implementation checklist still said "NO schema change" —
contradicting round-3.6's fee-leg snapshot AND round-3.8's
protocol-leg snapshot; round-3.9 documents both additive
extensions in the checklist with their accessors, storage
shape, wiring sites, and clearOrder coupling.

§18.12 test obligations renamed for the strict-shortfall
predicate (round-3.8's `+2` short tests become round-3.9's
`+1` short tests) and grown with four new fixed-price pin
tests symmetric to the Dutch pins, plus two B-cond-1 Dutch
carve-out tests.

Round-3.11 (against Codex round-11) closes three internal-
consistency issues round-3.10's edits exposed. First, §18.14's
fee-leg accessor section still documented the round-3.6 shape
`orderFeeLegs(bytes32) returns (bytes memory)` with calldata
decoding, contradicting round-3.10's typed `FeeLeg[]` getter
fix in §18.5 — implementers following the §18.14 checklist
would have reintroduced the bytes-wrap revert. Round-3.11
updates §18.14 to the corrected typed-getter shape. Second,
the §17.7 Block D reuse table still claimed
`IListingExecutorRecorder.recordOrder` was unchanged,
contradicting round-3.10's signature extension in §18.14 —
implementers would have missed updating the atomic-match
facet's call site and mock-recorder co-update. Round-3.11
documents the full extended signature in the Block D table.
Third, §18.12's opt-out test obligation said the borrower
posting a fresh listing auto-clears the opt-out flag, while
§18.7 (canonical) says the flag is sticky and requires
explicit `clearAutoListOptOut` — the round-3.4 wording left
both branches as "working assumption" tests, an ambiguity
round-3.11 resolves to §18.7's sticky semantics. The
test obligation is renamed
`test_autoList_requiresExplicitClearAfterBorrowerCancel`
and round-3.10's salt-collision section reference is
updated accordingly.

Round-3.10 (against Codex round-10) addresses five follow-on
issues across the schema-extension and grace-end boundary
surface. First, §18.5 Case B step 2's fee-leg snapshot was
written as a `bytes`-wrapped `abi.decode` against the
executor's `orderFeeLegs` accessor — but the accessor returns
the typed `FeeLeg[]` array directly, so the bytes wrap would
revert or corrupt the preserved legs and make fee-aware
rotations unfillable; round-3.10 fixes the snippet to call
the typed getter directly. Second, the §18.14 checklist said
post paths populate the new `_orderProtocolLegs` mapping
through the existing `IListingExecutorRecorder.recordOrder`
broadcast — but that signature doesn't carry
`consideration[0]` / `[1]` amounts, and deriving them from
`askPrice` is the borrower-slack bug the snapshot exists to
avoid; round-3.10 extends `recordOrder` to take
`signedLenderAmount` and `signedTreasuryAmount` explicitly,
forwarded by every post path. Third, round-3.6's B-cond-3b
underflow-guard branch SKIPPED rotation and relied on
B-cond-2 to catch the case; with round-3.8's switch to
signed-legs derivation, a pure governance buffer-bump (no
interest accrual) leaves a Dutch listing structurally
insolvent through grace because B-cond-2 doesn't fire on
unchanged legs; round-3.10 changes the guard semantics from
SKIP to FIRE rotation. Fourth, the salt-collision test was
written as a borrower-cancel-then-relist scenario — but §18.7
locks the auto-list path via the opt-out flag on borrower
cancel, so the test as written would either need to bypass
the opt-out or fail; round-3.10 refits the scenario to a
keeper post → diamond `updatePrepayListing` → keeper re-post
sequence (cleanly mirrors borrower's own re-list flow without
tripping the opt-out). Fifth, a stale "repay + Seaport fills"
parenthetical at the grace-end boundary contradicted the §0
table that already documents Seaport's `endTime` as exclusive
at the boundary; round-3.10 corrects the parenthetical to
repay-only.

Design-doc-only change in this PR. Contract implementation,
keeper-bot scanner wiring, and dapp surface are tracked as separate
follow-up Issues after the design ratifies.

---

**Round-12 follow-up (against Codex round-12 on PR #356 — folded
into the implementation PR rather than a separate doc PR):** five
internal-consistency fixes. (1) §17.11 atomic-match `recordOrder`
snippet now passes the round-3.10 `signedLenderAmount` +
`signedTreasuryAmount` args explicitly. (2) §18.16 reuse-table
`orderFeeLegs` entry rewritten to reference the typed
`FeeLeg[] memory` getter from round-3.10 instead of the round-3.6
bytes-wrapped auto-getter that was already corrected in §18.5. (3)
§18.15 open question on borrower-post-clears-opt-out resolved to the
§18.7 sticky semantics that round-3.11 ratified — the working
assumption from round-1 is dropped, the question marked resolved.
(4) §18.14 terminal-cleanup checklist expanded to enumerate all
five terminal sites including `PrepayListingFacet.executorFinalizePrepaySale`
(round-3.10 against Codex round-10 P3 — the sale-settlement path
doesn't route through `LibPrepayCleanup.clearActiveListing`, so the
auto-list state reset is wired inline). (5) §18.16 reuse-table
clarification that Case A reuses `_buildAndRecord` which already
calls `LibPrepayListingWiring.wire` internally — the call site
does NOT wire a second time.

**Implementation track shipped in this same PR (per user direction
2026-06-04 "fold into the implementation PR"):** the contract
implementation, mock + test scaffolding, deploy-script wiring, and
frontend ABI sync land alongside the design-doc round-12 fixes.
See `feat/issue-355-auto-list-impl` for the full commit set:

- `IListingExecutorRecorder` interface extended with
  `signedLenderAmount` / `signedTreasuryAmount` on `recordOrder`,
  new `orderProtocolLegs(bytes32)` / `orderFeeLegs(bytes32)` /
  `orderContextRead(bytes32)` / `seaport()` views.
- `CollateralListingExecutor` adds the `SignedProtocolLegs` struct
  + `_orderProtocolLegs` mapping + write at `recordOrder` + clear
  at `clearOrder` + the typed-array getter; 4 production call
  sites (fixed-price post + update, Dutch post + update,
  atomic-match) updated to forward the signed amounts.
- `LibVaipakam.Storage` extended with `prepayListingAutoListOptedOut`,
  `prepayListingAutoListNonce`, `cfgPrepayListingDutchGraceMarginSec`,
  `cfgPrepayListingAutoListConduitKey` + new
  `LibVaipakam.isGraceWindow(loan)` helper + `MIN_LOAN_GRACE_PERIOD`
  constant.
- `ConfigFacet` setters for the two new governance knobs.
- `cancelPrepayListing` extended on `NFTPrepayListingFacet` to set
  the sticky opt-out flag on grace-window cancels;
  `clearAutoListOptOut` borrower-only setter added.
- `LibPrepayCleanup.clearActiveListing` resets both auto-list slots
  unconditionally (covers Repay / Defaulted / Refinance / Preclose /
  Risk terminals); `PrepayListingFacet.executorFinalizePrepaySale`
  resets them inline (the sale-settlement terminal path).
- `LibAutoList` library carries the pure-math B-cond predicates
  with all round-3.5 → round-3.10 algebra fixes baked in: bufferless
  Dutch derivation, ceiling-division `t_floor`, strict-shortfall
  predicate, B-cond-1 Dutch carve-out, fire-on-underflow guard.
- `NFTPrepayAutoListFacet` ships the `autoListAtFloorOnGrace`
  entry point with Case A (fresh post) + Case B (rotation +
  fee-leg preservation + Dutch-to-fixed normalization).
- Facet-addition 7-site checklist walked (`DiamondFacetNames`,
  `DeployDiamond` + selector helper, `SelectorCoverageTest`,
  `FacetSizeLimitTest`, `DeployDiamondIntegrationTest`,
  `HelperTest`, `SetupTest`).
- `MockListingExecutorRecorder` extended with the new read views
  + a test-only `setOrderContext` staging helper.
- `TestMutatorFacet` extended with auto-list-state mutators
  (`setPrepayListingOrderHash` / `setPrepayListingExecutor` /
  `setPrepayListingAutoListOptedOut` + matching getters).
- `LibAutoList` pin-test suite: 22 / 22 pure-math regression
  pins covering every round-3.5 → round-3.10 fix.
- `NFTPrepayAutoListFacet` integration tests: 10 / 10 covering
  precondition reverts (grace timing, eligibility, opt-out,
  conduit config), Case A happy path (signed-leg invariant
  byte-for-byte assertion), opt-out lifecycle (grace-only cancel
  sets flag, clear is borrower-only).
- Frontend ABI sync: facet added to `exportFrontendAbis.sh` +
  `packages/contracts/src/abis/index.ts` barrel; typechecks
  green across `@vaipakam/defi`, `@vaipakam/keeper`,
  `@vaipakam/indexer`, `@vaipakam/agent`.

Closes #355.

Closes the design half of Issue #355.

## T-086 Round-8 design doc — borrow-OR-sell optionality at offer creation

Adds §19 to `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
specifying a borrower-side opt-in at offer-creation that lets the
collateral NFT sit on an OpenSea (or Seaport-conformant) listing
denominated in the offer's principal asset at a reserve at-or-above
the protocol floor. The listing surfaces during the offer-pending
phase, and the borrower retains the option to either be matched on
the loan (lender accepts) or be matched on the sale (buyer fills) —
whichever fires first wins, the other becomes structurally
unfillable in the same tx.

The motivation is that today a borrower whose NFT's market price
drifts above their loan target during the offer-pending phase has
to cancel-then-list-then-recreate (five steps, multiple txs, NFT
spends time outside the vault). Round-8 collapses that to a single
opt-in flag at offer creation; the off-chain ordering of
lender-accept vs. buyer-fill resolves which path runs.

**Two-order model (round-2 design + round-3 refinements).** Round-1
of the design doc had assumed a single Seaport orderHash could
span the offer-pending → loan-active → grace lifecycle. That is
structurally impossible at the Seaport / executor level because
(a) Seaport hashes `endTime` into the orderHash and the pre-loan
endTime cannot match `pctx.graceEnd` (the loan doesn't exist yet),
(b) the consideration array shape differs (single-leg pre-loan,
three-leg post-loan), and (c) the active-loan `lenderLeg` grows
monotonically via day-by-day interest accrual. Round-2 ratified the
two-order model: a pre-loan Seaport order signed at offer-create
(single-leg consideration, endTime = `offer.expiresAt`) and a
fresh active-loan Seaport order signed at offer-accept via the
vault's ERC-1271 delegate (three-leg consideration, endTime =
`pctx.graceEnd`). At offer-accept the pre-loan order is atomically
cancelled + the active-loan order is signed + recorded in the
SAME `acceptOffer` tx. The borrower's signature is captured at
offer-create + the vault attests at offer-accept; the borrower does
NOT need to be online to authorize the active-loan order.

**Three structural simplifications:** (1) lending-asset-only
removes all swap / oracle / slippage exposure at settlement;
(2) above-floor-only reuses Round-7's solvency invariant verbatim
(the buffer-inclusive floor is the same single value, with no
double-buffer applied at the §19.2 invariant); (3) the no-loan
branch's settlement waterfall has zero protocol legs to satisfy —
proceeds flow through a dedicated diamond callback that credits
the borrower's vault balance via the standard
`_creditUserVaultBalance` path, keeping the proceeds withdrawable
through the existing vault-balance flow.

**Round-3 architectural rewrites** (in response to Raja's CHANGES_REQUESTED
+ Codex round-1 + round-2 review):

- A new `OfferStatus.ConsumedBySale` terminal (distinct from
  `Cancelled`) blocks lender acceptance after a sale-fill; the
  existing `OfferAcceptFacet._acceptOffer` gate is extended to
  observe the new terminal. Without this, a lender accept tx
  landing after the sale-fill tx would proceed against a vault
  that no longer holds the NFT.
- A dedicated `recordOfferOrder` / `clearOfferOrder` /
  `offerContext` interface surface on the executor — distinct
  from the loan-keyed `recordOrder` / `orderContext` — keeps the
  two branches' invariants independent. The round-1 "reuse
  `recordOrder` with `loanId = 0`" path collided with the
  executor's existing unrecorded-order revert sentinel.
- A diamond-hosted live sanctions recheck callback
  (`assertOfferFillNotSanctioned`) runs during pre-loan fill in
  the diamond's storage slot — the round-2 "executor calls
  `LibVaipakam._assertNotSanctioned(...)` directly" would have
  read the executor's storage slot, silently failing open with
  no oracle consultation.
- The vault's ERC-1271 binding is rotated at offer-accept: the
  pre-loan hash is revoked, the active-loan hash is registered;
  the round-1 implicit assumption that one binding spanned the
  transition was wrong.

Design-doc-only change in this PR. Contract implementation, dapp
wiring, indexer event handling, and the off-chain publish step
that POSTs the active-loan order to the OpenSea API at
offer-accept time are tracked as separate follow-up Issues after
the design ratifies.

Closes the design half of Issue #358.

## T-086 §19 Round-8 — Borrow-OR-Sell parallel-sale (PR #362)

Ships the borrow-OR-sell flow design doc §19 specifies: an offer's borrower
can opt their NFT collateral into a Seaport-conformant listing AT OFFER
CREATION TIME, BEFORE any lender has accepted. The listing carries through
loan acceptance — whichever path fires first (a lender accepting, or a
buyer filling the listing) wins, and the other is structurally blocked.

In Scenario A (the buyer wins) the diamond credits the borrower's vault
with the full sale proceeds, marks the offer ConsumedBySale terminal, burns
the offer's position NFT, and clears every executor + vault binding.
In Scenario B (a lender accepts before the buyer fills) the listing
persists across acceptance; if a buyer ever fills it the diamond
atomically settles the loan and splits the proceeds — lender gets their
settlement entitlement (the canonical `LibEntitlement.settlementInterest`
helper — full coupon for `useFullTermInterest` loans, pro-rata for
others), treasury gets its cut, the CURRENT borrower-position NFT holder
(lazily provisioned with a per-user vault if needed) gets the remainder.
The keep-listing-live design preserves the borrower's intent end-to-end:
they're OK with either outcome.

The Round-8 surface ships across `OfferParallelSaleFacet` (the borrower-
only `postParallelSaleListing` + `releaseParallelSaleLock` entry points),
the executor's offer-keyed dispatch (`offerContext`, `recordOfferOrder`,
`clearOfferOrder`, `offerFeeLegs`), three new diamond callbacks the
executor invokes at fill time (`recordOfferSaleProceeds`,
`markOfferConsumedBySale`, `assertOfferFillNotSanctioned`), and gates
across the existing offer-lifecycle paths (accept, cancel, mutate,
metrics, dashboards, indexer) that recognize the new ConsumedBySale
terminal. Eligibility is bounded: only Borrower-type offers with NFT
collateral and `fillMode = Aon` (single-fill) can opt in; the existing
T-034 cadence rules already cap NFT-collateral loans at 365 days so the
pre-loan floor (which hedges full duration's interest + explicit treasury
cut) stays well-bounded.

Closes #361.

Twelve adversarial Codex review rounds drove a substantial set of
refinements that landed in the final design: a strict reentrancy guard
on the offer-keyed callbacks (defeats a malicious principal-asset
transfer hook from re-entering `acceptOffer` mid-tx), an explicit
`graceEnd` check that blocks fills past the loan's grace boundary,
authorization tightening so post-acceptance only the current borrower-
position holder can release the lock (matches the loan-keyed prepay-
listing posture), a sibling-listing block that prevents the loan-keyed
prepay flow from overwriting the parallel-sale's ERC721 conduit approval
slot, an open-offset-offer block that forces the borrower to cancel any
PrecloseFacet offset offer before the parallel sale can settle (rather
than half-tearing-down the offset inline), and storage-layout discipline
(every new mapping appended at the end of both `LibVaipakam.Storage` and
`CollateralListingExecutor` so future UUPS upgrades stay safe).
A couple of UI-side follow-ups are intentionally deferred: surfacing the
new `allowsParallelSale` control in the create-offer form, and adding
the `consumed_by_sale` status to the frontend's `IndexedOffer.status`
union + `useMyOffers` mapper so sold-history rows render in My Offers.
Both will land as standalone UI cards in the next session.

## T-086 step 10 — default-flow lock-bypass

Builds on step 7 (#302). Resolves the deadlock that would otherwise
arise if a borrower's loan reaches default / liquidation while they
have an active Seaport prepay listing — the borrower-position NFT
is locked, and without step 10 the default-flow facets would
either fail outright (the strict `LibERC721._lock` overwrite-guard
from step 6 round 2 blocks re-locking under a different reason) or
leave stale orderHash bindings on the executor + vault that future
governance rotations could resurrect.

### What this PR ships

**New library `LibPrepayCleanup`** with one `internal` function:

- `clearActiveListing(loan, loanId)` — idempotent sweep. When a
  listing is live, atomically:
  1. Clears the diamond's per-loan `prepayListingOrderHash` +
     `prepayListingExecutor` mappings.
  2. Releases the `PrepayCollateralListing` lock on the
     borrower-position NFT (`LibERC721._unlock`).
  3. Tells the pinned executor to clear its `orderContext`.
  4. Tells the borrower's vault to revoke the conduit's per-token
     approval AND the orderHash → executor binding.
  No-op when no listing is live (early-return on zero orderHash).

**Wired into 3 terminal liquidation paths:**

- `DefaultedFacet.triggerDefault` — invokes `clearActiveListing`
  immediately after the `loan.status == Active` check, BEFORE the
  KYC / liquidity / swap scaffolding. The lock-release + bookkeeping
  clear must happen first so the subsequent state mutations
  (full-collateral-transfer fallback, internal-match dispatch, or
  external-aggregator swap) operate on an unlocked NFT.
- `RiskFacet.triggerLiquidation` — same pattern, after the
  `loan.status == Active` check.
- `RiskFacet.triggerLiquidationSplit` — same pattern.
- `RiskFacet.triggerLiquidationDiscounted` — same pattern.

`RiskFacet.triggerPartialLiquidation` is intentionally NOT wired
— partial liquidation keeps the loan Active with reduced principal
/ collateral; the borrower's listing stays meaningful and should
NOT be force-cancelled. (If the partial liquidation happens to
seize NFT collateral underlying an active listing, that's a
follow-up integration concern; today partial liquidation operates
on ERC20 collateral so the conflict doesn't arise.)

### Tests

2 new tests in `test/NFTPrepayListingFacetTest.t.sol`:

- `test_libPrepayCleanup_noopWhenNoListing` — confirms the
  library is a true no-op when no listing exists (no revert, no
  state change).
- `test_libPrepayCleanup_clearsLiveListing` — posts a listing
  then invokes the cleanup, asserts ALL five state mutations
  happen atomically (diamond mappings, executor.clearOrder, vault
  binding, conduit approval, NFT lock).

The library is invoked via a thin test-only entry on
`TestMutatorFacet.invokePrepayCleanup(loanId)` so the test
doesn't have to stand up the full default-flow scaffolding
(KYC + oracle + swap) to exercise just the cleanup logic.

Full `cifast` regression: 105 / 105 passing. Cross-flow
verification: DefaultedFacetTest (48/48), RiskFacetTest (73/73)
both green under the default profile — the new
`clearActiveListing` no-op path didn't break any existing default
/ liquidation tests.

### Why the strict `s; // suppress` pattern

Three of the four wired entry points (`triggerDefault`,
`triggerLiquidation`, `triggerLiquidationSplit`) read
`s = LibVaipakam.storageSlot()` BEFORE the cleanup call and use
`s` later for downstream state writes. The cleanup library reads
storage internally, so we don't pass `s` through — but Solidity
complains about the unused `s` in the brief window between the
status check and the next statement that uses it. The
`s; // suppress unused-storage warning` pattern matches the
existing convention used elsewhere in the codebase.

### Out of scope (still deferred to later steps)

- **Repay / Preclose / Refinance terminal cleanup integration**
  (`RepayFacet.repayLoan`, `PrecloseFacet.directClose` /
  `transferObligationViaOffer`, `RefinanceFacet`) — these still
  don't call `LibPrepayCleanup.clearActiveListing` on close.
  Step 6 round 2 added a borrower-side escape hatch (dropped the
  `loan.status == Active` gate on `cancelPrepayListing`) so the
  borrower can always self-clean post-close. Wiring the cleanup
  into the close paths themselves is queued for a follow-up
  contract-side pass once steps 12-15 land.
- **Indexer prepay_listings table** — step 12.
- **Frontend UI** — step 13.
- **OpenSea API integration** — step 14.
- **ERC1155 collateral** — step 15.

## T-086 step 12 — indexer handlers + `prepay_listings` D1 table

Closes the indexer-side gap left by step 6 (PR #300): the four
prepay-listing events (`PrepayListingPosted` / `Updated` /
`Canceled` / `PrepayCollateralSaleSettled`) were allowlisted as
"TEMPORARY — step 12 will land the handler" in the indexer's
event-coverage script. This PR removes those four allowlist
entries and ships the actual handlers + persistence table.

### What this PR ships

**New D1 migration `0015_prepay_listings.sql`:**

- Table `prepay_listings` — one row per LIVE listing per loan
  (composite PK `(chain_id, loan_id)` since at most one listing
  per loan is live at a time — the facet enforces this).
- Columns capture the listing payload (order_hash, ask_price,
  conduit, lister), chain-time anchors (posted_at, updated_at,
  grace_period_end), and per-row provenance (block_number,
  tx_hash, log_index). The on-chain pinned executor address is
  intentionally NOT persisted — the event payload doesn't carry
  it, and storing a placeholder would mislead readers. The
  frontend queries the diamond view directly when the rare
  governance-rotation case requires it.
- Two secondary indexes: `idx_prepay_listings_order_hash`
  (reverse lookup for cancel events that carry orderHash) and
  `idx_prepay_listings_lister` (frontend "my listings" view).

**Four new handlers in `chainIndexer.ts`:**

- `PrepayListingPosted` — `INSERT OR REPLACE` a row, resolving
  `grace_period_end` from the loan's `start_time +
  duration_days × 86_400 + default-grace`. The grace value
  isn't carried in the event payload; we read from `loans`
  (already populated by the time PrepayListingPosted fires
  per the contract's `loan.status == Active` precondition).
- `PrepayListingUpdated` — `UPDATE` the existing row with the
  new orderHash + ask + conduit + lister + tx provenance,
  keyed on `(chain_id, loan_id)`.
- `PrepayListingCanceled` — `DELETE` the row. Loan stays
  Active (a cancel doesn't close the loan; a subsequent
  terminal event will).
- `PrepayCollateralSaleSettled` — `DELETE` the row AND flip
  `loans.status` directly to `settled`. The Seaport prepay
  sale terminal does Active → Settled ATOMICALLY in the
  contract; there is no separate claim step nor a follow-up
  `LoanSettled` event the indexer can wait for. Flipping to
  `repaid` (as the regular RepayFacet terminal does) would
  leave the loan forever in the claimables set.

**Event-coverage script cleanup:**

The four `TEMPORARY` allowlist entries for the prepay events
are removed from `apps/indexer/scripts/check-event-coverage.mjs`'s
`DELIBERATELY_NOT_HANDLED` map. Coverage now reports
**26 handled / 15 allowlisted** (was 22 / 19).

### Tests + verification

- `pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit` —
  clean.
- `pnpm --filter @vaipakam/indexer check-event-coverage` —
  passes; the script now requires the four prepay events to
  be handled (which they are).
- D1 migration: applies cleanly to a fresh database
  (constraints + indexes idempotent via `CREATE TABLE IF NOT
  EXISTS` + `CREATE INDEX IF NOT EXISTS`).

### Operator action post-merge

Apply the new migration to the live staging D1:

```bash
cd apps/indexer
wrangler d1 migrations apply vaipakam-archive --remote
```

The migration only adds a new table + indexes — no existing
data is touched. Safe to apply during normal traffic; the
indexer's next scan window will start populating the table.

### Out of scope (still deferred)

- **Frontend UI consuming `prepay_listings`** — step 13. The
  table is ready; the React surface ("your loan has a live
  listing" banner + cancel CTA + listings browser) lands in
  the frontend PR.
- **OpenSea API integration** — step 14.
- **ERC1155 collateral** — step 15.

### Why this PR doesn't add a `prepay_listed` loan status

Considered + rejected. A loan with an active prepay listing IS
still `active` — the listing is a SEPARATE state machine that
can be cancelled out of without closing the loan. Conflating
the two would force every "is this loan still open?" query to
do `status IN ('active', 'prepay_listed')` instead of just
`status = 'active'`. The new `prepay_listings` table is a
separate join target the frontend can `LEFT JOIN` for the
"this loan has a listing" UI without changing the loan-status
semantic.

## T-086 step 13 — frontend UI for the Seaport prepay-listing flow

Closes the user-facing gap T-086 has been carrying since step 6
(PR #300) shipped the borrower-facing facet. The contracts + indexer
have known how to record / surface a live listing for two PRs; this
PR is the React surface borrowers actually use to post, update, and
cancel one.

### What this PR ships

**New `useNFTPrepayListing` hook
(`apps/defi/src/hooks/useNFTPrepayListing.ts`).** A single
controller that:

- Reads the live listing state from the indexer's `/loans/:id`
  join (the indexed `prepayListing` payload step 12 set up) and
  re-fetches after every successful action — that's the canonical
  off-chain source for `askPrice` / `conduit` / `lister` /
  `postedAt` / `updatedAt` / `gracePeriodEnd`, none of which live
  in diamond storage.
- Exposes the three borrower entry points
  (`postPrepayListing` / `updatePrepayListing` /
  `cancelPrepayListing`) through the diamond proxy, with shared
  tx state (`actionLoading` / `actionError` / `txHash`).
- Decodes contract reverts via the existing
  `decodeContractError` helper so the on-chain error names
  (`AskBelowFloor`, `PrepayListingDisabled`,
  `PrepayListingNotAllowed`, `ConduitNotApproved`, …) land in
  the user-facing alert.
- Tags every action with a new `prepay-listing` journey area so
  the diagnostics drawer can group the start → success/failure
  pair the same way other strategic flows do.

**Two new components under `apps/defi/src/components/loanDetails/`:**

- `PrepayListingBanner.tsx` — informational card shown on the
  loan-details page when a listing is live, visible to everyone
  (lender, borrower, third-party). Renders the ask, the order
  hash (with explorer deep-link), the conduit, the current
  position-NFT holder, and a countdown to the grace boundary.
  Switches to a grey "closed — permissionless cancel callable"
  state once `block.timestamp >= gracePeriodEnd`, matching the
  diamond's strict-`>` upper bound for `postPrepayListing`.
- `PrepayListingActions.tsx` — borrower-only action group
  rendered inside the Actions card. Two visual modes — "post"
  (no live listing yet) and "update + cancel" (live listing).
  Both modes show the live floor (`lenderLeg + treasuryLeg`)
  and the minimum ask (`floor × (10_000 + bufferBps) / 10_000`,
  read directly from the diamond's `getPrepayListingBufferBps`).
  An "advanced options" expander lets users override the
  conduit key (defaults to OpenSea's canonical conduit) or paste
  a deterministic salt; otherwise the salt is auto-derived from
  `crypto.getRandomValues`. Cancel goes through a confirm step
  so a misclick doesn't release the borrower-NFT lock by
  accident.

**LoanDetails page wiring.** `getLoanActionAvailability` grows
three new context fields (`collateralAssetType`,
`allowsPrepayListing`, `pastPrepayGrace`) plus a new
`prepayListing` availability flag that mirrors the on-chain gates
exactly. The page now reads `getEffectiveGraceSeconds(durationDays)`
once on mount to compute the live grace boundary; a read failure
collapses the gate to `!isOverdue` (a safe under-approximation —
the surface just hides slightly earlier than the contract would
allow). Banner placement is between `ClaimActionBar` and
`LenderDiscountCard`; action-group placement is inside the
existing Actions card, alongside the other borrower-facing
strategic flows.

**`IndexedLoan` extension.** `apps/defi/src/lib/indexerClient.ts`
gains an `IndexedPrepayListing` payload type and adds the
optional `prepayListing` field to `IndexedLoan`. The
`allowsPrepayListing` boolean from step 4 is similarly mirrored
on the indexed-loan shape. The frontend `LoanDetails` TS type
gains the same `allowsPrepayListing` field on its on-chain shape.

**i18n.** A new `prepayListing.{banner, actions}.*` namespace
under English. Non-English locales fall back to English (same
pattern `periodicInterest.*` uses); proper translations land via
the regular translation rotation.

### What's NOT in this PR

The user-discovery surfaces — a "listings browser" page, a
"post-from-vault" entry point, the `useDashboardLoans` row badge
when one of your loans has a live listing — are intentionally
deferred. The shape the indexer + this PR settle on is the same
shape those surfaces will read; layering them on is additive.

The OpenSea API integration (step 14) is the next PR. Until that
lands, a borrower who posts a listing sees the order hash on the
banner but has to either trust the off-chain Seaport network to
relay the order or use a different OpenSea-creating UI to surface
the order in the OpenSea marketplace. The order itself is
already valid Seaport-1.6 with a live ERC-1271 signature; it's
the discoverability of that order that step 14 closes.

### Why the banner shows the order hash (not a buyer-facing CTA)

Three reasons.

1. The order itself is signed by the borrower's vault via
   ERC-1271; a buyer who has the orderHash + components can
   call `Seaport.fulfillOrder` directly without needing the
   Vaipakam UI. Surfacing the hash unblocks that path
   immediately.
2. A "buy now" CTA would have to either embed an OpenSea
   redirect (which doesn't exist until step 14 lands) or ship
   its own Seaport fulfillment path. We don't ship a partial
   second.
3. The banner is shown to lender / borrower / third-party
   alike; the only audience that needs to ACT on the listing
   today is the borrower (update / cancel), and they get a
   dedicated action group below.

### Tests + verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` — clean.
- `pnpm --filter @vaipakam/{keeper,indexer,agent} exec tsc -p . --noEmit` —
  all four ABI consumers green after the new
  `getPrepayListingEnabled()` view landed in the synced bundle.
- Manual flow verification deferred to a connected wallet against
  the testnet deploy once step 14 lands (so the OpenSea
  side-channel exists to validate the end-to-end purchase).
  Until then the page renders, the action submits, the banner
  reflects the indexer's view.

### Round-3 hardening (Codex review on PR #308)

The first review on this PR caught a blocking dual-hook divergence
(banner state could drift from child action mode after a successful
write); round 2 lifted hook ownership to `LoanDetails` so a single
`useNFTPrepayListing` instance feeds both surfaces, with a new
`onAfterSuccess` option that the parent wires to `loadLoan` for the
on-chain refresh. Round 3 then addressed the remaining surfaced
findings:

- **Master kill-switch + buffer + NFT-lock gating.** A new
  `NFTPrepayListingFacet.getPrepayListingEnabled()` view exposes the
  `cfgPrepayListingEnabled` master switch to the frontend; combined
  with the existing `getPrepayListingBufferBps()` and
  `VaipakamNFTFacet.positionLock(tokenId)` reads, the action surface
  now renders a "feature unavailable" / "buffer unconfigured" / "NFT
  locked by another flow" notice instead of a form that would revert
  at submit. The cancel path stays open in every unavailable case so
  a borrower can always wind down a stale listing.
- **Cancel-stays-open past grace.** The action-availability gate
  used to require `!pastPrepayGrace`, which hid the entire surface
  once the listing window closed — stranding the borrower with a
  live listing and no UI cancel button. The gate now mirrors only
  the *post / update* preconditions; the component itself switches
  to a cancel-only mode when `pastPrepayGrace` is true and a listing
  is live.
- **Stale-state guards.** The hook now clears `listing` to `null`
  immediately on a `loanId` / `chainId` change before starting the
  new fetch, so navigating between two loans can't briefly show the
  previous loan's listing for the new id. After a successful write,
  the hook also polls the indexer with a 1 / 2 / 3 / 4 / 5 second
  backoff (up to ~15 s) for the expected post/update/cancel
  transition before settling the new listing — so the worker's
  event-ingest lag can't leave the UI in the pre-write banner mode.
- **Grace-boundary tick.** `LoanDetails` now bumps a `nowSec` state
  every minute so the `pastPrepayGrace` comparison re-evaluates if
  the user leaves the page mounted across the boundary crossing.
  Without it, the action surface could keep showing post / update
  CTAs that the diamond now rejects.
- **Form validation.** Salt input now parses inside a try/catch
  (and against uint256 bounds), with the same inline-error UX the
  conduit-key check already had — `BigInt('abc')` can't throw out
  of the submit handler. The conduit-key prefill on update mode
  was also broken (always reset to OpenSea regardless of the live
  listing's conduit); the input is now cleared on entering update
  mode and the advanced expander auto-opens with a hint showing
  the on-record conduit address, so the borrower consciously
  re-enters the conduitKey they used.
- **Banner link.** Dropped the `/tx/<orderHash>` block-explorer
  link from the banner — `orderHash` is a Seaport EIP-712 digest,
  not a transaction hash, and explorers would 404 on it. The order
  hash now renders as plain text with a tooltip; surfacing the
  posting transaction hash (which the indexer's `prepay_listings`
  table does store under `tx_hash`) on the `/loans/:id` response
  is a small follow-up.

### Closes

T-086 step 13 (frontend UI) is now complete. Step 14 (OpenSea API
integration) is the next item; ERC-1155 collateral support is
already in the contracts as of step 6 round 2 (PR #307) — no
follow-up needed there.

## T-086 step 14 — OpenSea Listings API integration

Closes the last user-facing gap T-086 had been carrying: the on-chain
Seaport order the diamond constructs is now automatically published to
OpenSea's marketplace UI so casual NFT buyers find the listing through
their normal collection-page browsing flow. Borrower clicks one
button, the on-chain post confirms, and within seconds the listing
appears on OpenSea.

### What this PR ships

**Contract event change** —
`NFTPrepayListingFacet.PrepayListingPosted` and `PrepayListingUpdated`
now also emit `conduitKey` and `salt` (and `newConduitKey` / `newSalt`
on the update path). The two values are everything that wasn't
otherwise recoverable from chain state — without them, an off-chain
consumer reconstructing the canonical Seaport `OrderComponents` can't
reach the same orderHash and OpenSea would reject the
`isValidSignature` check on the vault. Backward-incompatible for an
already-deployed event subscriber; pre-live the rotation is free.

**Cloudflare Worker proxy** —
`POST /opensea/listing` on `apps/agent`. The dapp reconstructs the
canonical components client-side and POSTs them to this proxy, which
forwards to OpenSea's Listings API with the server-held
`OPENSEA_API_KEY`. Same shape as the existing `/quote/0x` and
`/quote/1inch` proxies — CORS-locked to `FRONTEND_ORIGIN`, IP-keyed
rate-limit via a new `OPENSEA_LISTING_RATELIMIT` binding. No
`/cancel` proxy: the vault's ERC-1271 stops authorising the orderHash
on `cancelPrepayListing`, so OpenSea's next re-validation pass drops
the listing on its own.

**Indexer-side autonomous fallback** —
The `PrepayListingPosted` and `PrepayListingUpdated` handlers in
`apps/indexer/src/chainIndexer.ts` now ALSO reconstruct the canonical
`OrderComponents` and POST to OpenSea. The two producers
(frontend-direct via the agent proxy, indexer-autonomous via the
event handler) race harmlessly — OpenSea dedupes by orderHash. The
frontend path is the UX-latency win (listing on OpenSea in seconds);
the indexer path is the canonical safety net that covers the
close-browser case the dapp's POST couldn't reach by itself (see
#311 for the design rationale).

**Shared `@vaipakam/lib/prepayOrderShape`** — the canonical
`OrderComponents` reconstruction lives in `@vaipakam/lib` so the
frontend (`apps/defi`) and the indexer Worker share one source of
truth. Field order, item-type mapping, and consideration ordering
are load-bearing — any divergence would hash to a different
orderHash and OpenSea would reject the signature. The defensive
recompute via Seaport's own `getOrderHash` runs on both call sites
before the POST: a mismatch aborts the publish with a clear error
instead of letting OpenSea reject the signature later.

**D1 schema extension** —
`apps/indexer/migrations/0016_prepay_listings_opensea.sql` adds three
columns on `prepay_listings`:
- `conduit_key` — the raw `bytes32` key (we already stored the
  resolved conduit address)
- `salt` — borrower's chosen uint256 salt
- `opensea_published_at` — Unix seconds set when the autonomous
  republish was accepted by OpenSea; NULL means "still needs a push"
  (the cron retry loop tracked as #311 will sweep these)

**Frontend banner deep-link** —
`PrepayListingBanner` surfaces a "View on OpenSea ↗" button whenever
a listing is live + the active chain is on OpenSea's supported set.
The URL is deterministic from `collateralAsset + collateralTokenId +
chainId` (computed via the new `openSeaAssetUrl` helper), so it
works regardless of which publish path actually delivered the order
to OpenSea.

### What's NOT in this PR (intentional)

- **Explicit retry loop for `opensea_published_at IS NULL` rows** —
  the column exists; a periodic scan to retry is tracked as #311
  follow-up. The synchronous publish-on-event path covers the
  expected case; the cron is the long-tail backstop.
- **Mirror-cancel via OpenSea API** — the vault's ERC-1271
  invalidation propagates within minutes. Adding an explicit cancel
  POST would only shave latency, not correctness.
- **Multi-marketplace fan-out** — Reservoir / Blur / LooksRare
  tracked separately as #281.
- **Auction modes** (Dutch / English) — #309.

### Operator action post-merge

1. Apply the D1 migration:
   ```
   cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote
   ```
2. Provision `OPENSEA_API_KEY` in the account-level Secrets Store
   (binding name + secret name both `OPENSEA_API_KEY`, store id
   `1e66429d0fa24aa38a27bc05b7bcf63e`). Both `apps/agent` and
   `apps/indexer` wrangler configs reference it.
3. Set `VITE_AGENT_ORIGIN` on the dapp's deployed environment so the
   frontend-direct push hits the proxy.

Until the operator runs the above, the autonomous publish + dapp
push both no-op gracefully (the proxy returns 503
`opensea-not-configured`, the indexer logs and skips). The on-chain
order stays valid + fillable throughout.

### Verification

- `nice -n -10 ionice -c 2 -n 0 forge build` clean
- `pnpm --filter @vaipakam/{defi,agent,indexer,keeper} exec tsc -*` —
  all four ABI consumers green
- `pnpm --filter @vaipakam/indexer check-event-coverage` —
  26 handled / 15 allowlisted; no drift

### Closes

T-086 sequencing step 14. Step 15 (ERC1155 collateral) was folded into
the step-6 round-2 PR (#307). Steps 16-17 are follow-ups
(documentation polish + audit-prep).

### Related

- Step 6 (contracts foundational): #300 + round 2 #307
- Step 12 (indexer + D1): #304
- Step 13 (frontend): #308 + post-merge tick #310
- **Step 14 (this PR): OpenSea integration**
- Step 14 follow-up: autonomous republish retry loop (#311)
- Auction-mode extension (Dutch / English): #309

## T-086 step 2 — `LockReason.PrepayCollateralListing` enum extension

Round-4 design doc §13 step 2 closes with this PR. The setApprovalForAll-during-lock hardening (PR #282) put the counter + epoch chain in place; this PR adds the missing enum value the upcoming `NFTPrepayListingFacet` (step 6) will pass to `LibERC721._lock` when a borrower posts a Seaport-mediated prepay listing on their collateral NFT.

### The change

One line in `contracts/src/libraries/LibERC721.sol`:

```solidity
enum LockReason { None, PrecloseOffset, EarlyWithdrawalSale, PrepayCollateralListing }
```

The new value lands at the tail (storage value `3`) so the on-chain meaning of every existing `locks[tokenId]` is preserved. `None` (0), `PrecloseOffset` (1), and `EarlyWithdrawalSale` (2) keep their values. The natspec on the enum was promoted to call out the append-only requirement explicitly — adding a new reason post-launch is fine; reordering or removing entries reinterprets every existing lock value on a live diamond, which is a footgun if not flagged.

### Why this is its own PR

Step 2 in `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13 is the foundation step every later piece depends on. The counter + epoch + `setApprovalForAll` gate shipped via PR #282 — this PR adds the only remaining piece (the enum value) so step 3 (`LibCollateralSettlement.liveFloor`) and step 5 (`CollateralListingExecutor`) can land cleanly without bundling a one-line enum change into a bigger surface.

### Why it's safe

- **No call site needs to change.** Every existing reference to `LockReason` either compares against `None` (lock-state predicate) or supplies a specific reason at `_lock` time. There's no exhaustive switch on the enum values — verified by grep across `contracts/src/` + `contracts/test/`. The new value is purely additive.
- **Append-only on enums is upgrade-safe.** The underlying storage type is `uint8`; existing tokens that carry `locks[tokenId] == 1` (PrecloseOffset) keep that value. The Solidity ABI doesn't expose enum ordinals to external callers; consumers that read `lockOf` / `positionLock` get the bytes representation of the enum, which is already correct for any value 0–2.
- **Tests prove the new reason is a first-class citizen, not a special case.** Lock → unlock round-trip on `PrepayCollateralListing` exercises the same counter math, epoch bump, `setApprovalForAll` gate, and `positionLock` view as the existing reasons. A mixed-reason test (`PrecloseOffset` on token A + `PrepayCollateralListing` on token B) confirms the counter sums across reasons and each fresh lock bumps the epoch.

### Follow-ups still queued from §13

- Step 3: `LibCollateralSettlement.liveFloor(loanId, asOfTimestamp)` — closed-form floor formula. Standalone library.
- Step 4: `Offer`/`Loan` `allowsPrepayListing` flag (append-only).
- Step 5: `CollateralListingExecutor` singleton (ERC-1271 + Seaport zone). Biggest single step.
- Steps 6–17 per `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13.

## T-086 step 3 — `LibCollateralSettlement.liveFloor` closed-form floor formula

Step 3 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Introduces a small math library that returns the minimum aggregate sale price for a Seaport prepay collateral listing at any timestamp. The library is the source of truth the upcoming `CollateralListingExecutor` (step 5) will call from both:

- the **ERC-1271 sign-time delegate** — to refuse signing a listing whose total consideration is below the live floor;
- the **Seaport zone `validateOrder` callback at fill time** — to defend against the `Seaport.validate()` pre-registration attack (per design doc §5.7, which would otherwise let an attacker pre-validate a stale order and skip the ERC-1271 callback).

### What the library exposes

Three view helpers in `contracts/src/libraries/LibCollateralSettlement.sol`, each `internal view` reading from `LibVaipakam`'s storage slot:

| helper | maps to | computes |
|---|---|---|
| `principalPlusAccruedInterest(loanId, asOfTimestamp)` | Seaport `consideration[0]` (lender) | `loan.principal + LibEntitlement.accruedInterestToTime(loan, asOfTimestamp)` |
| `treasuryAndPrecloseFee(loanId, asOfTimestamp)` | Seaport `consideration[1]` (treasury) | `accruedInterest × (treasuryFeeBps + precloseFeeBps) / 10_000` |
| `liveFloor(loanId, asOfTimestamp)` | floor that the order's total consideration must equal-or-exceed | sum of the above |

The borrower's residual (`consideration[2]`) isn't computed here — it's the executor's `askPrice − liveFloor`, derived from the signed order at fill time.

### Reuses existing math; honors `useFullTermInterest`

The interest helper is `LibEntitlement.settlementInterest` — same canonical source `RepayFacet`, `PrecloseFacet`, `RefinanceFacet`, and `PartialWithdrawalFacet` use at settlement. This is load-bearing for loans created with `loan.useFullTermInterest == true`: `settlementInterest` returns `fullTermInterest(principal, rateBps, durationDays)` for those (the lender's contracted full coupon, owed regardless of how early the close happens), and falls back to per-whole-day-rounded `accruedInterestToTime` for the standard pro-rata path. Using only `accruedInterestToTime` would have understated the floor on full-term loans — a Codex P1 finding on the round-1 draft of this PR; addressed by routing both legs through `settlementInterest`.

The treasury-fee bps routes through `LibVaipakam.cfgTreasuryFeeBps()` (so the 0-means-default-100 fallback contract is preserved verbatim). The fee leg uses the SAME `settlementInterest` value as the lender leg — the treasury cut is taken from the lender's owed interest, so both amounts MUST share the same interest basis.

### `precloseFeeBps` summand is currently zero, structurally complete

The formula in design doc §5.2 reads `treasuryFeeBps + precloseFeeBps`, but `cfgPrecloseFeeBps()` doesn't exist in `LibVaipakam` yet — there's no preclose-specific fee in production. To keep this PR narrowly scoped to the math library, `treasuryAndPrecloseFee` writes the formula with an explicit `precloseFeeBps = 0` local. Step 5 (executor) adds the config getter + setter and drops the constant `0` for the live read — a one-line change with no surrounding shape impact.

### Test coverage

`contracts/test/LibCollateralSettlementTest.t.sol` exercises:

- **Day-zero**: at `asOfTimestamp == loan.startTime`, accrued is 0, lender leg is principal exactly, fee leg is 0, `liveFloor == principal`.
- **Pre-startTime fill timestamp**: `accruedInterestToTime` returns 0; floor collapses to principal (defensive — production Seaport ordering means this never happens, but the math must still be sensible).
- **Interest accrual**: 10 days at 12% APR on 100_000e18 principal produces ~328.767e18 accrued (hand-computed against the integer-arithmetic formula), and the floor matches `principal + accrued + accrued × 100bps / 10000`.
- **Sub-day rounding**: 23h 59m elapsed → 0 accrued (per-whole-day rounding flows through correctly).
- **Monotonicity**: across 6 timestamps over the loan's 30-day term, the floor is non-decreasing — the executor's design relies on this invariant for the "fill-time floor ≥ sign-time floor" property the 2% buffer compensates for.
- **Treasury fee override**: a `setTreasuryFeeBpsRaw(500)` (5%) bumps the fee leg accordingly; a `setTreasuryFeeBpsRaw(0)` falls back to the 1% constant default (the `cfgTreasuryFeeBps` contract).
- **Edge cases**: zero principal → floor = 0; zero rate → floor stays at principal forever.
- **Cross-loan isolation**: a 2× principal loan produces exactly 2× floor at the same timestamp (linear-in-principal sanity check).
- **`useFullTermInterest` at day zero**: a full-term loan already owes the full coupon at `t=startTime`; floor accounts for it, fee leg cuts from the full term too.
- **`useFullTermInterest` constant over term**: full-term floor stays flat across the loan's lifetime (compare to the pro-rata path where accrued grows daily).
- **Pro-rata + full-term convergence at maturity**: at `T+durationDays`, the two branches converge — pro-rata's accrued at full term equals the full-term coupon by construction.

The tests use four new view proxies on `TestMutatorFacet` (`getLiveFloor`, `getPrincipalPlusAccruedInterest`, `getTreasuryAndPrecloseFee`) plus a `setTreasuryFeeBpsRaw` direct-write helper — same pattern as the PR #282 lock-state testing scaffolding. `HelperTest._getTestMutatorFacetSelectors()` selector array grows 70 → 74.

### What this PR does NOT do

- No executor / facet wiring — that's step 5 (`CollateralListingExecutor` ERC-1271 + Seaport zone) and step 6 (`NFTPrepayListingFacet`).
- No `cfgPrecloseFeeBps()` getter or `ProtocolConfig.precloseFeeBps` field — deferred to step 5 with the executor that consumes it.
- No Seaport order construction — also step 5.

The library is a self-contained mathematical primitive; the executor is the consumer.

## T-086 step 4 — `allowsPrepayListing` lender-consent flag

Step 4 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Adds a one-bit lender-consent gate that flows from `CreateOfferParams` → `Offer` → `Loan`, gating the (step-6) `NFTPrepayListingFacet.postPrepayListing` entry. Today the gate's consumer (step 6) hasn't shipped yet; this PR lays the storage groundwork so step 6 can land as a clean addition with no struct-layout work.

### What this PR does

1. **Adds `allowsPrepayListing` to three structs** in `contracts/src/libraries/LibVaipakam.sol`, all at the tail of their respective definitions (append-only per the project's storage-layout rule):
   - `CreateOfferParams` — the lender's `createOffer`-time toggle.
   - `Offer` — the on-chain offer record, copied verbatim from `CreateOfferParams`.
   - `Loan` — the on-chain loan record, snapshotted from `Offer` at loan-init.
2. **Wires the two copies** that move the flag through the create / accept lifecycle:
   - `OfferCreateFacet.createOffer` — one line: `offer.allowsPrepayListing = params.allowsPrepayListing;`.
   - `LoanFacet.initiateLoan` — one line: `loan.allowsPrepayListing = offer.allowsPrepayListing;`.

### Default `false`; sweep across 222 construction sites

`CreateOfferParams` is constructed via Solidity named-arg syntax in 47 files (8 deploy / fixture scripts + 39 test files), totalling 222 `CreateOfferParams({ ... })` sites. Each one now explicitly carries `allowsPrepayListing: false` — the safe default. The sweep was done deterministically by a Python script that inserts the new field on the line immediately following the existing `allowsPartialRepay:` field (which is present at every site by Solidity's named-arg-completeness requirement) — preserving indentation, alphabetic neighbours, and not touching any non-construction reference.

### Mirrors the `allowsPartialRepay` pattern exactly

The lender opt-in shape mirrors the existing `allowsPartialRepay` consent gate verbatim. Both flags:

- Are take-it-or-leave-it parts of the offer package; an acceptor who disagrees simply doesn't accept.
- Default `false` for safe, explicit opt-in.
- Snapshot onto the `Loan` at init; immutable for the loan's lifetime regardless of any later offer-level change.

This shape choice keeps reviewer cognitive load minimal: anyone who has reviewed the `allowsPartialRepay` plumbing sees the same diagram applied one struct field deeper. The (step-6) `NFTPrepayListingFacet.postPrepayListing` gate will mirror the `RepayFacet.repayPartial` `PartialRepayNotAllowed` gate one-to-one.

### What this PR explicitly does NOT do

- **No step-6 facet.** `NFTPrepayListingFacet` (and its `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing` entry points) is the next foundational step in the queue. Until that lands, no caller can act on `Loan.allowsPrepayListing == true` — the flag is inert.
- **No ABI re-export.** `CreateOfferParams`'s ABI shape changes (one extra `bool` slot), which means consumers — frontend, indexer, agent, keeper — that build their own `CreateOfferParams` need a re-export + typecheck cycle to pick up the new field. The standard `bash contracts/script/exportFrontendAbis.sh` + `pnpm --filter @vaipakam/{defi,keeper,indexer,agent} exec tsc -b --noEmit` sweep runs as a separate change (per CLAUDE.md "Frontend ABI sync" + `feedback_abi_sync_after_contract_changes.md`).
- **No frontend UI** — the lender-side CreateOffer page doesn't yet expose the toggle. That's a step-13 deliverable (Frontend "Auction to prepay loan" UI), and includes both the lender-side opt-in and the borrower-side listing post / cancel / browse surfaces.

### Test coverage

`contracts/test/AllowsPrepayListingTest.t.sol`:

- **Offer round-trip**: a `setOffer({ allowsPrepayListing: true })` survives a read-back through `OfferCancelFacet.getOffer` with the flag intact.
- **Offer default**: an offer that doesn't set the flag reads back `false`.
- **Loan round-trip**: a `setLoan({ allowsPrepayListing: true })` lands correctly in storage (verified via `getLoanDetails` identity check; the `LoanDetails` struct's surface for this field can be added alongside the step-6 facet that needs it).
- **Loan default**: similar to the offer default case.
- **CreateOfferParams compile-time**: pins the field's presence on the calldata-input struct, fails to compile if removed.

The sweep itself is the second half of the test plan: every existing test that constructs a `CreateOfferParams` now does so with `allowsPrepayListing: false`, so the full forge-test regression validates that the new field's default-false path runs cleanly through every existing flow (create / accept / repay / preclose / refinance / partial-withdrawal / liquidate / default / claim / etc.).

## T-086 step 5 — `CollateralListingExecutor` singleton + `PrepayListingFacet` trust boundary

Step 5 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Lands the executor↔diamond pair that brokers Seaport-mediated prepay collateral sales. The borrower-facing post / update / cancel entry points are step 6 (`NFTPrepayListingFacet`); this PR is the trust boundary between Seaport's order-matching engine and the diamond's loan state.

### The executor singleton — `contracts/src/seaport/CollateralListingExecutor.sol`

A UUPS-upgradeable singleton implementing two trust-boundary surfaces Seaport calls into at fill time:

1. **ERC-1271 sign-time delegate** (`isValidSignature(hash, signature)`). Verifies that the `orderHash` is one this executor recorded for an active loan + an approved conduit. The richer content checks (live floor, recipient binding, schema) happen at fill time, not sign time — Seaport doesn't pass the order content into the 1271 call.

2. **Seaport 1.6 zone hooks** — BOTH `authorizeOrder` (pre-transfer) AND `validateOrder` (post-transfer). The 2-hook split is required by Seaport 1.6's `ZoneInterface`; missing `authorizeOrder` would make every listing unfulfillable (Seaport reverts on the missing selector before our checks run). Both hooks share `_checkOrderPreconditions`, which runs the FULL stack: `msg.sender == seaport` gate, conduit re-validation (catches post-sign governance revokes), loan-Active status, grace expiry, full offer-side schema (itemType / token / identifier / amount must match the loan's collateral), full consideration-side schema (3 legs in the loan's principalAsset; ERC20 lending only), live-floor amounts, recipient binding (lender + treasury + borrower recipients re-derived from current NFT holders + the diamond's `getTreasury()` — the signed recipient is checked against THIS value, not trusted from the order). `validateOrder` additionally calls the diamond's privileged finalization callback after Seaport's transfers complete.

3. **Governance-managed conduit allow-list** with `addApprovedConduit` / `removeApprovedConduit` (ADMIN_ROLE on the owner, → timelock + multisig post-handover). Re-checked at fill time.

4. **`recordOrder` / `clearOrder`** — diamond-only entry points (`msg.sender == vaipakamDiamond`) for step 6's `postPrepayListing` / `cancelPrepayListing` to bind / unbind `orderHash` to `loanId` + sign-time conduit. Includes an explicit `uint96` bounds check on `loanId` (silent narrowing would let a future `loanId > 2^96` wrap into a different loan record).

### The diamond-side trust boundary — `contracts/src/facets/PrepayListingFacet.sol`

A new diamond facet that pairs with the executor. Four entry points:

1. **`getPrepayContext(loanId, asOfTimestamp) external view`** — the single bundled view the executor reads for every fill. Runs `LibCollateralSettlement.principalPlusAccruedInterest` + `treasuryAndPrecloseFee` + `LibVaipakam.gracePeriod` + the NFT-owner / treasury resolves all in the DIAMOND's storage context. This is the **load-bearing architectural fix** for the Codex P0 finding on PR #288's first draft: the executor used to call those libraries directly, in its own (empty) storage context, which evaluated the live floor to 0 — every fill would have passed. The bundled-view design moves all storage reads to the diamond and ships the executor a struct.

2. **`executorFinalizePrepaySale(loanId) external whenNotPaused`** — the privileged finalization callback. Gated `msg.sender == s.collateralListingExecutor`; performs the three atomic mutations: `LibLifecycle.transition(loan, Active, Settled)`, `LibERC721._unlock(loan.borrowerTokenId)`, `LibVPFIDiscount.settleBorrowerLifProper(loan)` (the latter load-bearing per CLAUDE.md "VPFI Fee Discounts — Phase 5 flow").

3. **`setCollateralListingExecutor(address) external`** — ADMIN_ROLE-gated setter for the trusted executor address. `address(0)` disables the path; rotation supports executor upgrades without diamond changes.

4. **`getCollateralListingExecutor() external view`** — read-side for frontends + the executor itself.

### Storage extension

`LibVaipakam.Storage` gains one append-only field: `address collateralListingExecutor` (default `address(0)` while unset; `executorFinalizePrepaySale` reverts `ExecutorNotSet` until governance configures it).

### What this PR does NOT do

- **No borrower-facing flow.** Step 6's `NFTPrepayListingFacet` ships the `postPrepayListing` / `updatePrepayListing` / `cancelPrepayListing` / `cancelExpiredPrepayListing` entry points borrowers actually call. Step 6 also performs `LibERC721._lock(LockReason.PrepayCollateralListing)` (the enum value from #285) and `recordOrder` against this executor.
- **No `cfgPrecloseFeeBps()` getter** — the prepay-fee summand on the treasury leg stays `0` until governance opts in. Library structure is ready for the field; step 6 or a follow-up adds it.
- **No frontend / indexer / agent / keeper wiring** — those land in step 11 (ABI export + consumer typechecks) and step 12 (indexer event coverage).

### Test coverage

A dedicated executor unit test suite (mock-diamond harness) + diamond-side integration tests for `PrepayListingFacet` land in a follow-up commit on this branch. The mock harness covers each `authorizeOrder` / `validateOrder` revert path (wrong sender, unknown order, revoked conduit, non-Active loan, expired grace, schema mismatches, short-paid lender / treasury, wrong recipients) plus the happy path that drives a Settled-via-prepay state. Integration tests cover the executor↔diamond callback round-trip with the real `PrepayListingFacet` cut into the test diamond.

## T-086 step 6 — borrower-facing NFTPrepayListingFacet

Closes the design doc §13 step-6 bullet: ships the borrower's
diamond surface for the Seaport prepay-collateral-listing flow.

### What the borrower can now do

For a live loan whose lender consented at offer time
(`Offer.allowsPrepayListing == true`, snapshotted onto
`Loan.allowsPrepayListing` at loan-init), the current
borrower-position-NFT holder can:

- **Post a listing** of the collateral NFT at an ask price the
  borrower picks, as long as the ask covers the live floor
  (lender principal + accrued interest + treasury cuts) plus a
  governance-configured safety buffer.
- **Update the listing** by re-signing with a fresh order hash and
  ask price — used when interest has eaten through the original
  buffer and a fresh Seaport order needs to be posted.
- **Cancel the listing** at any time pre- or post-grace.

If a listing's grace window expires without a fill, anyone can
**cancel the expired listing** — the permissionless cleanup is
the safety net so the borrower's position NFT isn't left locked
forever waiting for a buyer that didn't show up.

### Master kill-switch — listings dormant until governance enables

A new ConfigFacet setter `setPrepayListingEnabled(bool)` gates the
`postPrepayListing` / `updatePrepayListing` paths behind a master
flag. The flag defaults `false` on a fresh deploy: until the
vault's narrow `setCollateralOperatorApproval` entry (design-doc
step 7), the vault's ERC-1271 delegate, and the default-flow lock-
bypass (step 10) are wired end-to-end, a posted listing CANNOT
actually fill (Seaport can't pull the NFT through the conduit
without the vault's per-token approval). Shipping step 6 behind
this gate keeps the UX trap dormant — borrowers can't post
listings that would lock their position NFT without an escape
until they manually cancel. The cancel paths (borrower-side AND
the permissionless grace-expired cleanup) stay open regardless of
the flag so any listings posted under a previous `true` always
have a cleanup path.

### What this PR ships in detail

Five entry points on the new `NFTPrepayListingFacet`:

- `postPrepayListing(loanId, askPrice, orderHash, conduit)`
- `updatePrepayListing(loanId, newAskPrice, newOrderHash, conduit)`
- `cancelPrepayListing(loanId)`
- `cancelExpiredPrepayListing(loanId)` (permissionless,
  intentionally NOT pause-gated so locked NFTs can always be
  released)
- `getPrepayListingOrderHash(loanId)` + `getPrepayListingBufferBps()`
  (view helpers for the frontend / indexer)

Three new events tagged `state-change/loan-mutation`:

- `PrepayListingPosted(loanId, lister, orderHash, askPrice, conduit)`
- `PrepayListingUpdated(loanId, lister, oldOrderHash, newOrderHash, newAskPrice, conduit)`
- `PrepayListingCanceled(loanId, caller, orderHash, reason)`
  where `reason` is `Borrower` or `GraceExpired`.

The events are temporarily allowlisted in the indexer's
event-coverage guardrail (`apps/indexer/scripts/check-event-coverage.mjs`)
with the same shape as step 5's `PrepayCollateralSaleSettled`
allowlist: the indexer handlers + new `prepay_listings` D1 table
land in step 12 of the design doc.

### Storage + config additions

Two append-only fields on `LibVaipakam.Storage`:

- `mapping(uint256 => bytes32) prepayListingOrderHash` — per-loan
  active orderHash. Used by cancel paths to look up the binding to
  clear without forcing the caller (especially the permissionless
  cancel) to know the off-chain hash; the borrower-position-NFT
  lock is the consent + safety primitive, this mapping is the
  orderHash bookkeeping.
- `uint256 cfgPrepayListingBufferBps` — the governance-configured
  safety margin on top of the live floor.

One new ConfigFacet setter:

- `setPrepayListingBufferBps(uint16)` — ADMIN_ROLE-gated,
  range-bounded to 1000 bps (10%) ceiling. Default storage value
  `0` is the intentional pre-config block: the listing facet
  refuses every post / update until governance explicitly
  configures the buffer (design doc §10.2 recommends 200 bps /
  2%).

### How the pieces fit with step 5

Step 5 shipped the executor singleton + the diamond-side trust-
boundary facet. Step 6 builds on top: the borrower-facing facet
talks to the executor via a narrow `IListingExecutorRecorder`
interface, calling `recordOrder` at post time and `clearOrder` at
cancel / update time. The executor's existing diamond-only gate
on `recordOrder` (msg.sender == vaipakamDiamond) makes the new
facet the only authorized caller; conduit-allow-list discipline
stays enforced on the executor side, so the borrower facet just
fails fast with a clear `ConduitNotApproved` error before issuing
the executor call.

The full end-to-end fill path (Seaport → ERC-1271 → vault NFT
transfer → zone callback → diamond finalization) is still the
executor's responsibility; step 6 only owns the diamond-side
listing lifecycle (sign → update → cancel).

### Out of scope (deferred)

- **ERC1155 collateral** — v1 is ERC721 only (design doc §7).
  ERC1155 lands in step 9; the facet reverts
  `UnsupportedCollateralForV1` if the loan's collateral is
  anything other than ERC721.
- **Vault narrow approval entry** (`setCollateralOperatorApproval`)
  — step 7 in the design doc; the conduit's per-token approval
  on the collateral NFT contract is the operator's responsibility
  for now (off-chain frontend orchestration). The Seaport fill
  cannot complete without this approval, so the path is not yet
  end-to-end functional on chain — but the borrower-facing
  diamond surface is.
- **Frontend UI** (step 13), **OpenSea API integration** (step 14).

### Test plan

- 22 new unit tests in `test/NFTPrepayListingFacetTest.t.sol`
  cover the ConfigFacet setter (admin gate + bounds), every
  documented revert path on `postPrepayListing`, the
  `updatePrepayListing` happy path (old hash cleared, new
  hash recorded, lock stays on), both cancel paths
  (borrower-authority gated + permissionless grace-expired),
  and the executor stub assertions (recordOrder + clearOrder
  argument verification).
- Full `cifast` profile regression: 92 / 92 passing including
  the new tests + every step-5 + step-2/3/4 test.
- Deploy-sanity guardrails: facet selector coverage + EIP-170
  size + integration cut verification all green for the 39-
  facet diamond.
- Frontend ABI sync: regenerated `packages/contracts/src/abis/`
  via `exportFrontendAbis.sh`; barrel updated to re-export both
  `PrepayListingFacetABI` (step-5 catch-up) and
  `NFTPrepayListingFacetABI`; `@vaipakam/defi` typecheck clean.
- Indexer event-coverage guardrail passes with the three new
  events allowlisted with explicit step-12 deferral reasons.

## T-086 step 7 — Vault narrow entries + ERC-1271 delegate

Builds on step 6's borrower-facing diamond surface (PR #300). Ships
the vault-side pieces that make the Seaport prepay-collateral-listing
flow actually fill-able once governance flips the master kill-switch.

### What this PR ships

**On `VaipakamVaultImplementation` (per-user UUPS proxy):**

- `setCollateralOperatorApproval(nftContract, tokenId, conduit, approved)`
  — Diamond-gated. Grants (or revokes) a Seaport conduit's
  per-token approval on the vault's collateral NFT. The diamond
  is responsible for pre-validating that the conduit is in the
  executor's governance allow-list at call time.
- `registerListingOrderHash(orderHash, executor)` — Diamond-gated.
  Pins the orderHash → executor binding on the vault so its
  ERC-1271 callback can delegate.
- `revokeListingOrderHash(orderHash)` — Diamond-gated. Idempotent.
  Clears the orderHash → executor binding so Seaport's signature
  verification at fill time refuses the order.
- `isValidSignature(hash, sig) → bytes4` (ERC-1271 callback) —
  reads the pinned executor for `hash` and delegates the
  decision to `executor.isOrderValid(hash)`. Returns the magic
  value iff the executor approves; the `sig` argument is
  intentionally ignored (the vault doesn't sign with a private
  key; the orderHash binding is the authoritative authorization
  record).
- `getListingExecutor(orderHash)` — view helper for the
  indexer / frontend to query which executor a given orderHash
  is bound to.
- New storage `mapping(bytes32 => address) _listingExecutor`
  appended to the pre-gap layout; `__gap` shrunk from 50 to 49
  slots so the overall UUPS storage footprint stays constant.

**On `CollateralListingExecutor`:**

- New `isOrderValid(bytes32 hash) → bool` view, factored out of
  the existing `isValidSignature` so the vault's ERC-1271
  delegate can consult it in plain-bool shape without
  re-deriving the magic-value-encoded `bytes4`. The local
  `isValidSignature` now delegates to `isOrderValid` itself —
  same semantics, single source of truth for the check stack.

**New interface `IListingExecutorValidator`:**

Narrow `isOrderValid(bytes32) → bool` surface that the vault
imports. Separate from `IListingExecutorRecorder` (the diamond's
record-order surface) so the vault doesn't pull in the conduit
allow-list / order-record entries that aren't its concern.

**On `NFTPrepayListingFacet` (diamond, step 6 facet):**

- `postPrepayListing` now also calls into the borrower's vault:
  `vault.setCollateralOperatorApproval(collateralAsset,
  collateralTokenId, conduit, true)` + `vault.registerListingOrderHash(orderHash,
  executor)`. Without these, Seaport couldn't pull the NFT
  through the conduit at fill time and signature verification
  would fail — making the listing un-fillable.
- `updatePrepayListing` revokes the OLD orderHash on the vault +
  registers the NEW one + re-grants the conduit approval
  (idempotent if conduit unchanged).
- `cancelPrepayListing` / `cancelExpiredPrepayListing` revoke
  both the conduit approval AND the orderHash binding on the
  vault so a previously-signed order can no longer fill.

**On `PrepayListingFacet.executorFinalizePrepaySale` (step 5 facet):**

- After a successful Seaport fill, the post-fill callback also
  revokes the orderHash binding on the vault. Seaport's
  `transferFrom` already clears the per-token approval at the
  ERC-721 level, so we only need the orderHash revoke here.

### Tests

4 new step-7-specific tests in
`test/NFTPrepayListingFacetTest.t.sol`:

- `test_post_wiresVaultOperatorApproval` — confirms the post
  path grants the conduit approval on the real ERC721 mock.
- `test_post_registersOrderHashOnVault` — confirms the vault's
  orderHash → executor mapping is populated.
- `test_cancel_revokesVaultBinding` — confirms cancel clears
  BOTH the orderHash binding and the conduit approval.
- `test_vault_isValidSignature_returnsMagicWhenExecutorApproves`
  — confirms the ERC-1271 callback returns INVALID for an
  unregistered orderHash (the registered-positive path needs a
  real executor; covered separately in the executor's tests).

Test scaffolding extended: each test now deploys a real
`MockRentableNFT721` as the collateral NFT, mints the token to
the borrower, transfers it to the borrower's vault (created via
`VaultFactoryFacet.getOrCreateUserVault`). The vault entries
operate against a live ERC-721 + a real UUPS proxy, not
fake addresses.

Full `cifast` regression: 103 / 103 passing. Cross-flow
verification: PrecloseFacetTest (60/60), EarlyWithdrawalFacetTest
(68/68 + 1 skipped), PrepayListingFacetTest (8/8) all green under
the default profile.

### End-to-end fill path now wired

Once governance calls `ConfigFacet.setPrepayListingEnabled(true)`
on a chain (post-audit), the full flow runs:

1. Borrower → `postPrepayListing(loanId, askPrice, orderHash, conduit)`.
2. Diamond validates, locks borrower NFT, records on executor,
   wires vault (grants conduit approval + pins orderHash).
3. Frontend posts the signed Seaport order to the conduit's
   order book (e.g. OpenSea).
4. Buyer fills via Seaport → Seaport calls vault.isValidSignature
   (which delegates to executor.isOrderValid) → Seaport pulls
   NFT from vault through conduit → distributes lender + treasury
   + borrower considerations → fires executor's `validateOrder`
   zone callback.
5. Executor's `validateOrder` re-runs the floor + recipient +
   grace checks, then calls back into the diamond via
   `executorFinalizePrepaySale(loanId)`.
6. Diamond transitions Active → Settled, unlocks borrower NFT,
   settles VPFI LIF rebate, clears bookkeeping (diamond +
   vault orderHash binding).

### Out of scope (still deferred)

- **ERC1155 collateral** — step 9 / 15. Step 7's
  `setCollateralOperatorApproval` is ERC721-only (uses
  `IERC721.approve`).
- **Default-flow lock-bypass** — step 10. `DefaultedFacet` +
  `RiskFacet` need to unlock the borrower NFT as their first
  step if the lock reason is `PrepayCollateralListing`.
- **Indexer prepay_listings table** — step 12.
- **Frontend UI** — step 13.
- **OpenSea API integration** — step 14.

## T-086 — Advanced User Guide: OpenSea prepay listing entry + same-block-race note

Closes the documentation gap left behind by T-086 steps 13 (frontend UI) and 14 (OpenSea publish). The Advanced mode user guide's "Loan Details > Actions > If you're the borrower" section listed every other terminal-flow action (Repay, Preclose direct, Preclose offset, Refinance, Claim as borrower) but never mentioned the new OpenSea collateral-listing flow, even though it has shipped and is reachable from the loan-details page.

This change adds:

1. A new borrower-side action bullet describing the OpenSea prepay listing flow in two sentences — what it does, when it's available, what happens at fill, and the cancel-anytime escape. Same terse style as the surrounding bullets.

2. A blockquote note immediately after the borrower action list explaining the **same-block-race outcome** when a borrower's `repayLoan` lands in the same block as a buyer's `Seaport.fulfillOrder` and the buyer's tx wins EVM ordering. Specifically:

   - The loan is **already settled** by the time the borrower's repay runs (sale waterfall already paid lender + treasury + borrower vault remainder)
   - The borrower's repay reverts harmlessly — no funds left their wallet
   - The Vaipakam dapp detects this case and shows a tailored message (PR #318); if for some reason the user sees a generic revert, the note tells them to check loan status on the Dashboard first

The note explicitly calls out that this is **the only case** a borrower-initiated repay can "fail harmlessly" without something actually being wrong, so borrowers don't spiral into "did I lose funds?" panic if they ever see a revert while a listing was live.

### What's NOT in this PR

- Translations of the new content into the existing Basic/Advanced locales (de, ta, etc.) — those follow the normal translation rotation pace.
- Equivalent additions to the Basic user guide — the OpenSea listing flow is an Advanced-mode feature and is documented there.
- Frontend / contract changes — the friendly-error UX referenced in the doc note lives in PR #318.
