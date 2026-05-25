## Forge-lint cleanup — bundle: A.1 + A.2 + SafeCast.toInt256 (Issue #89)

Three logically related forge-lint follow-ups that all need the same
ABI-regen pass land together to minimise the operator's `exportFrontendAbis.sh`
round trips. PR #267 (Batch 5.4) shipped 53 `unsafe-typecast` SafeCast wraps
for `uint256` downcasts; this bundle finishes the typecast sweep with the
remaining nine signed-int sites, and folds in the two ABI-break selector
renames that Batch 2 / Batch 3 deferred precisely because they needed a
deliberate ABI regen.

**Part 1 — SafeCast.toInt256 (9 sites, `unsafe-typecast`).** The
`SafeCast.toInt256(uint256)` wrap protects `int256(uint256)` casts from
silent two's-complement overflow when the input ≥ 2^255. Eight sites in
`LibInteractionRewards` (the `perDay` / `perDayNumeraire18` flow rate
encoding) and one in `OracleFacet._captureDailyPriceSnapshotInner` (the
daily Chainlink price snapshot) get the wrap. Per-site rationale: each
input is bounds-checked upstream (`perDay` ≤ supply, Chainlink price
non-negative per `_primaryPrice`'s guards), but explicit revert beats
silent overflow into a negative int256.

**Part 2 — A.1 FlashLoanLiquidator immutable rename
(`screaming-snake-case-immutable`, 4 immutables).** `owner`, `diamond`,
`aaveV3Pool`, `balancerV2Vault` rename to `OWNER`, `DIAMOND`,
`AAVE_V3_POOL`, `BALANCER_V2_VAULT`. These are immutables, so the
Solidity style guide wants SCREAMING_SNAKE_CASE; Batch 2 deferred them
because the auto-generated getters are part of the public ABI consumed
by the keeper-bot and the rollout doc. The bundle updates
`FlashLoanLiquidatorTest.t.sol`'s four getter call sites and
`docs/ops/FlashLoanLiquidatorRollout.md`'s four `cast call` verification
commands in lockstep. Constructor parameter names + their NatSpec
`@param` docs stay lowerCamelCase — those are function locals, not
state vars, and `mixed-case-variable` is the applicable rule there
(satisfied). Revert string literals (`"owner"`, `"diamond"`) preserved
verbatim — the string-literal-aware tokenizer pattern from Batch 3
caught those.

**Part 3 — A.2 cross-chain VPFI 3 identifiers
(`mixed-case-variable` / `mixed-case-function`).** `stuckVPFIByRequest`
and `totalStuckVPFI` (public state vars on both `VpfiBuyAdapter` and
`VpfiBuyReceiver`) rename to `stuckVpfiByRequest` / `totalStuckVpfi`;
`isCanonicalVPFIChain` (the storage struct field in `LibVaipakam` plus
the external getter on `VPFITokenFacet`) renames to
`isCanonicalVpfiChain`. The lowercase `vpfi` inside the camelCase
identifier matches the convention already used everywhere else in the
repo (`vpfiBuyReceiver`, `vpfiMirror`, `vpfiOftAdapter` in the
deployments JSON, `vpfiHeld` in the borrower LIF settlement). 46 source
sites across `crosschain/`, `facets/`, `libraries/`, the test suite,
`DeployDiamond.s.sol`'s selector table, `HelperTest.sol`'s selector
table, the contracts `README.md` and `RUNBOOK.md` move in lockstep. No
consumer code in `apps/` or `packages/` references these by name (the
only consumer-side touch is the ABI JSON regen).

**ABI regen needed on merge:** `bash contracts/script/exportFrontendAbis.sh`
will pick up the new selectors on `FlashLoanLiquidator` (4 immutable
getters), `VpfiBuyAdapter` + `VpfiBuyReceiver` (`stuckVpfiByRequest`,
`totalStuckVpfi`), and `VPFITokenFacet` (`isCanonicalVpfiChain`). One
regen pass covers all three parts.

### Lessons banked

1. `Edit` tool's `replace_all` is literal-substring, not word-boundary —
   `aaveV3Pool` → `AAVE_V3_POOL` over-matched into the constructor
   parameter `_aaveV3Pool` and its NatSpec `@param` doc, producing
   `_AAVE_V3_POOL` (non-idiomatic). Revert the constructor params
   manually after a `replace_all` on identifiers that appear as
   substrings of other identifiers — or use the Python tokenizer.

2. The lint's "VPFI" recommendation could be read as either `Vpfi` or
   `_vpfi_` (pure separator) — the project convention (`vpfi` lowercase
   inside camelCase, established across the deployments JSON and the
   contract filenames `VpfiBuyAdapter` / `VpfiBuyReceiver`) is the
   load-bearing reference; pick from prior art, don't invent.

Closes the bundle slice of #89; leaves Group A.4 (~75 NFT / KYC /
acronym external functions) for a dedicated follow-up PR.
