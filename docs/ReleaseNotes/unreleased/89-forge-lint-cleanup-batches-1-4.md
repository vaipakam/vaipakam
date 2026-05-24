## Forge-lint cleanup — Batches 1-4 (Issue #89, PRs #255 / #257 / #258 / #259)

CI's `forge build` output had been carrying 628 `forge-lint` warnings —
unused imports, mixed-case identifiers, screaming-snake-case immutables
that should have been lowerCamel, and a handful of unsafe-typecast +
modifier-shape findings. The volume itself was the problem: every new
PR added more warnings, and a real regression in warning *shape*
(e.g., a new `erc20-unchecked-transfer` after a refactor) was easy to
miss in the noise. This release ships four mechanical batches that
clear ~430 of the 628 (about two-thirds), without touching the deferred
ABI surface that needs a deliberate selector-break PR to migrate.

**Batch 1 — unused-import (93 warnings).** A driver script parsed the
build output, located each `note[unused-import]` block, and rewrote
the import lines surgically: single-symbol imports were dropped
entirely, multi-symbol imports had the offending name removed from the
brace list. No identifier renames, no behaviour change — pure dead-code
removal. Merged as PR #255.

**Batch 2 — screaming-snake-case immutable/const (10 of 15 warnings).**
The Solidity style guide wants immutables and constants in
SCREAMING_SNAKE_CASE; a small inventory of project test fixtures, scripts,
and adapter immutables were still lowerCamel. The script renamed 14
symbols across 11 files. Codex's review caught two real regressions
the script was blind to: the rename mechanism (a word-boundary regex)
silently mangled identifier-shaped substrings *inside* string literals
— the import path `"@diamond-3/..."` flipped to `"@DIAMOND-3/..."`
and broke remappings, and the CCIP channel-ID constant
`"vaipakam.ccip.channel.vpfi-buy"` flipped to `VPFI-buy` and started
hashing a different namespace from the production sources. The full
FlashLoanLiquidator immutable rename also got reverted because its
`owner()` / `diamond()` getters are part of the public ABI consumed by
the keeper-bot and documented in the rollout doc, so renaming the
storage field renames the auto-generated getter — a selector change
masquerading as a style fix. Net delivered: 10 SCREAMING_SNAKE_CASE
renames; 9 deferred. Merged as PR #257.

**Batch 3 — mixed-case-variable (184 of 194 warnings).** Function
locals, parameters, and event-arg names that ended in three-letter
acronyms (`newHF`, `collateralUSD`, `simulatedLTV`) standardised to
lowerCamel. Hardened the script with three lessons from Batch 2: a
proper Solidity-aware tokenizer that tracks four states (code, string,
line-comment, block-comment) so identifiers inside string literals
are protected, an explicit skip for declarations on `public`/`external`
state variables to preserve auto-generated getter selectors, and a
global-codebase walk per accepted symbol so call sites in inheritor
files (e.g., `MetricsFacetTest` referencing `SetupTest`'s `mockNFT721`)
get renamed in lockstep with the parent declaration. Six ABI JSONs +
four frontend TypeScript files were updated alongside the contract
source so the ABI shape compare in CI stayed clean in one shot.
Codex's review cycle still found three more issues: a `_gap` rename
that broke the OpenZeppelin upgradeable storage-gap convention, the
`isCanonicalVPFIChain()` external function inheriting its selector
from a same-named internal state-var (Batch-2 class bug recurring on
an external getter the SKIP-public-state-vars classifier didn't cover),
and two cases of the lint's `Xys`-as-`XyS` heuristic producing
awkward identifiers (`totalNfTsInVault`, `statusImageUrIs`) — overridden
to the standard transform. Final cycle: 4 Codex passes, 2 reverts,
clean signoff. Merged as PR #258.

**Batch 4 — mixed-case-function (85 of 165 warnings).** Internal /
private function renames only. The script now joins multi-line
function signatures up to the next `{` or `;` and skips any signature
containing `external` or `public`; every renamed external/public fn
would change a 4-byte selector and that's a deliberate ABI-break,
not a mechanical batch. 80 external functions deferred — the
OpenZeppelin AccessControl convention role getters
(`DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, etc.), `NFT`-suffix mutators
(`initializeNFT`, `mintNFT`, `burnNFT`), `KYC`-suffix gates
(`setKYCEnforcement`), and acronym-suffix admin setters (`fundETH`,
`setDIAOracleV2`, `setVPFIToken`). Two further lessons banked through
Codex's review: a per-file classifier dedup conflicts with a
whole-codebase rename walk when the same identifier has different
visibilities in different files (the `setDIAOracleV2` collision), and
the `/lib/` path filter over-excludes project-local
`script/lib/Deployments.sol` even though it's first-party code. Merging
as PR #259.

### Deferred to follow-up PRs

About 99 symbols across the four batches stayed un-renamed and need
deliberate follow-up PRs:

- **ABI-break PRs (Group A):** every public state-var auto-getter and
  every public/external function on a deployed contract whose selector
  is consumed by the keeper-bot, the frontend ABI bundle, or the
  Tenderly Diamond snapshot. Migration requires the rollout doc, the
  consumer ABIs, and the test fixtures to move in lockstep — same
  shape as the per-facet ABI sync that already runs after every
  contract change. Candidates include FlashLoanLiquidator's 4 immutable
  getters (Batch 2), the two `VpfiBuy*` cross-chain pub state vars
  (Batch 3), `isCanonicalVPFIChain()` (Batch 3), and the ~80
  external/public function names deferred in Batch 4.

- **Ecosystem / convention preserves (Group B):** four struct names
  whose ERC + NFT acronym blocks match OpenZeppelin / prevailing
  Solidity style (`NFTPositionSummary`, `ERC721Storage`, `ERC20Settlement`,
  `_TierCtx`), the `decimals` interface override in
  `MockSequencerUptimeFeed`, and the `__gap` declarations across the 7
  upgradeable contracts. These will likely land as targeted lint
  suppressions rather than renames — the convention is the
  load-bearing thing.

- **Test-base inherited state-vars (Group C):** `mockUSDC` and
  `mockWETH` declared in `InvariantBase` and read by 5 inheritor
  invariant suites via `base.mockUSDC()`. Bundled separately so the
  inheritor sweep + the base move in one focused PR.

### Lessons banked for the next mechanical refactor

Six classes of bug Codex caught that the lint warnings themselves
didn't surface, all now documented in the per-batch PR bodies for the
next person doing mechanical renames:

1. Word-boundary regex matches identifier-shaped substrings *inside*
   string literals.
2. Solidity has no single-quote string — apostrophes in comments must
   not flip the tokenizer's string mode.
3. The `mixed-case-variable` lint fires on declarations, not usages —
   inheritor files referencing inherited identifiers are missed unless
   the script walks the whole codebase.
4. Manual `external` function declarations sharing an identifier with
   an internal state-var are *also* ABI-bound; the skip-public-state-vars
   classifier needs to extend.
5. OZ `__gap` and AccessControl role-getter conventions take
   precedence over the lint's name suggestions.
6. The `Xys` plural-acronym lint heuristic produces unusable names
   (`totalNfTsInVault`, `statusImageUrIs`); always preview and
   override.

### Cumulative warning state on Issue #89

About 430 of 628 lint warnings cleared (~68%) across the four batches.
The remaining ~200 are split between the deferred groups above
(Group A is the big bucket — ~95 public/external selector renames) and
the categories not yet touched: `unsafe-typecast` (~136 warnings,
Batch 5), `unwrapped-modifier-logic` (11) and `unsafe-cheatcode` (9,
both Batch 6). Each remaining batch is mechanically smaller than
Batches 3-4 but needs the same per-batch Codex round-trip discipline.

Closes the Batches 1-4 work on #89; the umbrella stays open until
Batches 5-6 + the Group A/B/C follow-ups land.
