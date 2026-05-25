## Forge-lint cleanup — Group A.4 + setRewardOApp→setRewardMessenger rename (Issue #89)

Closes Group A.4 of the forge-lint cleanup tracked in Issue #89, plus
finishes the partial T-068 LayerZero→CCIP rename of the cross-chain
reward messenger function.

### Part 1 — 92 `mixed-case-function` suppressions (convention preserves)

Every external/public function whose name carries a project-domain
acronym (VPFI, NFT, KYC, ETH, USDC, DIA, LTV, TVL, APR, URI), an
ERC-standard suffix (ERC20, ERC721, ERC1155, ERC4907), an OpenZeppelin
AccessControl convention (already covered by PR #269's 7 role
getters), or an upstream interface spec (Aave V3
`FLASHLOAN_PREMIUM_TOTAL`, project `IVPFIToken` `TOTAL_SUPPLY_CAP` /
`INITIAL_MINT`) gets a one-line
`// forge-lint: disable-next-line(mixed-case-function)` directly above
the declaration. 92 inline suppressions across 17 files — same shape as
PR #269 but at the wider scope.

Renaming any of these would have changed a 4-byte function selector
on a deployed contract — the keeper-bot, the frontend ABI bundle, and
the Tenderly snapshot all consume those names directly. Suppression
preserves the public ABI and documents the conscious decision at every
call site.

Files touched (suppressions only):

- `VaipakamVaultImplementation.sol` — 10 ERC20/ERC721/ERC1155 vault wrappers
- `VaultFactoryFacet.sol` — 15 `vault{Deposit,Withdraw,Approve,Set,Get}{ERC20,ERC721,ERC1155,NFT*}` wrappers
- `VPFIDiscountFacet.sol` — 16 VPFI buy/discount/staking helpers
- `VPFITokenFacet.sol` — 9 VPFI getters / setters
- `VaipakamNFTFacet.sol` — 9 NFT mutators + tokenURI / contractURI / setImageURIForStatus
- `ProfileFacet.sol` — 7 KYC family
- `MetricsFacet.sol` — 5 NFT / TVL getters
- `VpfiBuyAdapter.sol` / `VpfiBuyReceiver.sol` — 4 each (recover stuck, rescue ETH/ERC20)
- `StakingRewardsFacet.sol` — 3 VPFI-staking + APR getters
- `AdminFacet.sol` — 2 KYC enforcement gate
- `OracleAdminFacet.sol` — 2 DIA oracle setters
- `TreasuryFacet.sol` / `OracleFacet.sol` / `RiskFacet.sol` — 1 each (mintVPFI / calculateLTV ×2)
- `IAaveV3Pool.sol` / `IVPFIToken.sol` — 1 / 2 interface getters

### Part 2 — `setRewardOApp` → `setRewardMessenger` (T-068 finish line)

T-068 migrated the cross-chain reward flow from LayerZero (where the
external counterparty was an "OApp" = Omnichain Application) to
Chainlink CCIP (where it's a "Messenger"). The artifact-side rename was
already done — `Deployments.sol`'s `readRewardMessenger()` /
`writeRewardMessenger()` and the deploy shell scripts' "legacy
`.rewardOApp` artifact key" fallbacks have been in place for weeks —
but the contract-side function still carried the LayerZero-era name.
This PR finishes the partial migration:

- **Function rename:** `RewardReporterFacet.setRewardOApp` →
  `setRewardMessenger`. Public ABI break (4-byte selector change);
  consumer-side ABIs regenerate in this PR.
- **Error renames:**
  `RewardOAppNotSet` → `RewardMessengerNotSet`,
  `NotAuthorizedRewardOApp` → `NotAuthorizedRewardMessenger`. Each
  changes the error selector — ABI break, frontend / indexer / agent
  pick it up via ABI regen.
- **Storage field rename:** `LibVaipakam.Storage.rewardOApp` →
  `rewardMessenger`. Solidity storage layout is determined by field
  **order + type**, not name — so this is layout-preserving (same
  offset, same 32-byte slot). The pre-PR comment claiming
  "storage-layout stability" as the reason the field couldn't be
  renamed was a misconception; the real reason was the ABI break, which
  this PR pays in one bundle.
- **Event topic-key rename:** `bytes32("rewardOApp")` →
  `bytes32("rewardMessenger")` in `RewardReporterConfigUpdated`'s
  `key` field. The event topic hash is unchanged (computed from
  signature, not field-key strings). No consumer code decodes the
  string literal — verified via grep of `apps/`.
- **Event parameter name:** `ChainInterestReported.viaOApp` →
  `viaMessenger`. The event topic hash is unchanged (computed from
  types, not parameter names). The ABI's parameter-name field changes,
  which downstream decoders display.
- **Companion-facet alignment:** `RewardAggregatorFacet` also reads
  `s.rewardOApp` / declares an `onlyRewardOApp` modifier; renamed in
  lockstep.
- **`IVaipakamErrors.sol`** — canonical error declarations renamed in
  lockstep.
- **Consumer-side test + script files:**
  - `CrossChainRewardPlumbingTest.t.sol` — 8 test function names
    (`testCloseDayMirrorForwardsToOApp` → `…Messenger`, etc.) plus 90+
    local-variable renames (`oApp` → `messenger`).
  - `HelperTest.sol` — selector reference at L1035.
  - `DeployDiamond.s.sol` — `console.log` text + selector reference at
    L1209.
  - `ConfigureRewardReporter.s.sol` — local var + comment + the call
    site at L90.
  - `pause-all-chains.sh` — JSON key in the read loop at L126.
  - `deploy-testnet.sh` / `deploy-mainnet.sh` — comment polish on the
    "legacy `.rewardOApp` artifact key" fallback (the fallback itself
    is preserved for backward-compat reading of historical addresses
    files).
  - `MockRewardMessenger.sol` — comment alignment.

What stays as "OApp" (intentional historical context):
- `IRewardMessenger.sol` — explicit "this interface used to be named
  `IRewardOApp`" historical paragraph.
- `VaipakamRewardMessenger.sol` — "CCIP successor to the LayerZero
  `VaipakamRewardOApp`" preamble.
- `LibVaipakam.sol` — the storage-field comment now records the
  historical name + the corrected layout-stability reasoning.
- `GovernanceHandover.t.sol` — test names like
  `_runMigrateOAppGovernance` / `test_OApp_OwnerIsTimelock` refer to
  the broader governance handover applied to multiple OApp contracts
  historically; out of scope for this PR's setter rename.

### ABI regen needed on merge

```
bash contracts/script/exportFrontendAbis.sh
pnpm --filter @vaipakam/{defi,keeper,indexer,agent} exec tsc -b --noEmit
```

Picks up the renamed `setRewardMessenger` selector + the two renamed
error entries across `RewardReporterFacet.json`,
`RewardAggregatorFacet.json`, and the shared `IVaipakamErrors.json`
surface. No consumer code in `apps/` references the old names by
string — verified via grep.

### Lessons banked

- The "storage-layout stability" justification for refusing to rename a
  Solidity struct field is technically incorrect — layout depends on
  order + type, not name. The real cost of a field rename is the ABI
  break on selectors derived from the field's getters and the
  declared errors that mention it, both of which are bookkeepable.
- The `Edit.replace_all` lesson from PR #271 (literal-substring, not
  word-boundary) carried over: this rename used a careful
  longest-first replacement list (e.g. `setRewardOApp` →
  `setRewardMessenger` comes before `oApp` → `messenger` so the
  function name isn't garbled mid-pass).
- `OApp` as a comment-level word recurred in surprising places — the
  cleanup needed to look at companion facets (`RewardAggregatorFacet`),
  the canonical error interface (`IVaipakamErrors`), the storage
  library, and the test mock alongside the obvious facet. The grep
  sweep at the end caught residue in `MockRewardMessenger`'s comments
  that the initial rename plan missed.

Closes Group A.4 of #89. The #89 umbrella stays open until Batch 6
(`unwrapped-modifier-logic` + `unsafe-cheatcode`) lands; the
mixed-case-function / mixed-case-variable / SafeCast / immutable
categories that defined Group A are now complete.
