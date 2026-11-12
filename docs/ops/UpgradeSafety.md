# Upgrade Safety Review

Covers the two upgrade surfaces in the Vaipakam protocol:

1. **Diamond facet cuts** — add/replace/remove function selectors on the Diamond.
2. **UUPS vault upgrades** — replace the implementation behind every user's `ERC1967Proxy` vault.

Plus pre-flight checks that apply to both.

---

## Invariant: storage layout is append-only

Both the Diamond (via `LibVaipakam.Storage`) and the vault implementation use shared storage. The only safe modifications:

- ✅ **Append** new fields at the end of `LibVaipakam.Storage` struct.
- ✅ **Append** new fields at the end of `VaipakamVaultImplementation`'s state.
- ✅ **Reuse** a reserved/deprecated field only if its runtime effect was already removed AND the field is explicitly marked reusable in comments.

Never safe:
- ❌ Insert a field in the middle.
- ❌ Reorder fields.
- ❌ Change a field's type (incl. widening like `uint64` → `uint128`).
- ❌ Rename a mapping key type or value type.
- ❌ Replace a mapping with an array or vice versa.

The Storage struct lives at slot `keccak256(abi.encode(uint256(keccak256("vaipakam.storage")) - 1)) & ~bytes32(uint256(0xff))` (ERC-7201 derivation) — one wrong reorder corrupts every subsequent field across every facet.

### Enforcement
- Every PR touching `LibVaipakam.sol` must include a `git diff` review that the Storage struct only grows at the bottom.
- Pre-merge: `forge inspect src/libraries/LibVaipakam.sol storage-layout` output diffed vs. the previous release tag.
- Post-upgrade: one test that reads an old field and asserts the expected value from a known-state fork.

---

## Diamond facet cuts

### What a cut can do
`IDiamondCut.diamondCut` accepts `FacetCut[]` with action `Add | Replace | Remove`.

### Hazards
| Hazard | Mitigation |
|---|---|
| Selector collision (two facets claim the same `bytes4`) | `DiamondLoupeFacet.facetAddress(selector)` before and after the cut. Any unintended change → abort. |
| Orphan storage (remove a facet but leave its storage fields) | **Keep storage.** Removing the facet is fine; removing its storage fields is not (see append-only rule above). |
| Replacing a facet that holds `nonReentrant` state mid-call | Impossible via diamond cut (cuts only rewire dispatch), but: **pause the protocol** before any non-trivial cut to avoid mid-tx weirdness on pending user flows. |
| Deleted selector still referenced by external integrators | Announce selector removals 2 weeks in advance on the status page. |
| New facet exposes a state-mutating function missing `whenNotPaused` | Lint: every `nonReentrant`/mutating external function in a new facet is reviewed for pause gating. `PauseGatingTest` must be updated. |
| New facet exposes a state-mutating function missing `onlyRole(...)` where required | Manual review + a targeted test asserting unauthorized callers revert. |
| A curated refresh leaves out the facet that hosts a rule the refreshed facets self-call | The refresh-together families in `CLAUDE.md` list every such set. `RedeployFacets` refuses a Diamond that does not already route each host it depends on (for example `PredatesMatchRiskBoundsHost` since #3326: the match facets read the start-of-loan risk bounds from `OfferPreviewFacet.initRiskBounds`, which that script does not carry). Never work around a refusal by cutting a subset by hand; use the all-facets refresh or a fresh deploy. |
| A refresh changes a figure stamped on a loan when it opens | Open loans carry no stamp from the new code. Since #3562 the lender's yield-fee discount is the lower of the tier at entry and at settlement, and a loan open before the refresh has no entry record, so its lender loses the hold-tier part of the discount from then on. A lender who paid the Full tariff at opening keeps that paid bump, which does not depend on the record. Say so to lenders before such a refresh, or wait for the next fresh deploy. |

### Procedure (per cut)
1. Draft the cut in a new script: `script/UpgradeFacets_<name>.s.sol`.
2. Dry-run on a **forked mainnet** (`--fork-url $MAINNET_RPC`):
   - Record `facetAddresses()` before.
   - Execute the cut.
   - Record `facetAddresses()` after.
   - Assert only the intended selectors changed facet.
3. Run the **full test suite** against the forked state:
   ```bash
   forge test --fork-url $MAINNET_RPC
   ```
4. `forge inspect` — diff the storage layout vs. the deployed tag.
5. Queue the cut via governance timelock (`DEFAULT_ADMIN_ROLE` → `DiamondCutFacet.diamondCut` is not paused-gated, but the convention is `pause()` → cut → verify → `unpause()` for non-trivial cuts).
6. After execution: re-verify `facets()` and run the smoke test scripts from `DeploymentRunbook.md` §5.

### Reward plumbing facets (covered)

`RewardReporterFacet` and `RewardAggregatorFacet` are included in `script/DeployDiamond.s.sol` (28 cuts, up from the earlier 26). Matching selector arrays live in:

- `script/DeployDiamond.s.sol` → `_getRewardReporterSelectors()`, `_getRewardAggregatorSelectors()` — production deploy.
- `test/HelperTest.sol` → `getRewardReporterFacetSelectors()`, `getRewardAggregatorFacetSelectors()` — test harness.

Both lists MUST stay in sync. Any new external function added to either facet requires updating **both** places — diff them before shipping.

---

## Vault code changes (VaultBeacon, #3204)

### What changed
Every user vault is a `BeaconProxy` that asks the **VaultBeacon** which code to run on every call. The beacon is a separate contract (not a facet), owned by the Timelock and **not upgradeable**; no facet's storage write can change which code a vault runs. There is no per-vault upgrade any more: `upgradeVaultImplementation`, `upgradeUserVault`, `setMandatoryVaultUpgrade` and the "vault below the mandatory version" rules (#3178) are gone. Design: [`VaultCentralImplementationDesign.md`](../DesignsAndPlans/VaultCentralImplementationDesign.md).

A vault runs its owner's **pinned** version while that version is not revoked, otherwise the **current** version.

### Hazards
| Hazard | Mitigation |
|---|---|
| Storage layout change | Every registered version keeps the vault layout append-only; the storage-layout guard's `beacon:VaipakamVaultImplementation` root checks it, and `registerVersion` refuses a contract that does not report `vaultLayoutId()`. |
| A registered implementation whose initializer can still be called | Deploy the implementation with its constructor disabling initializers (`DeployDiamond` checks the Initializable slot read-only before it registers version 1); check the same for every later version before registering it. |
| A bad version reaches every vault at once | The change is two steps on the beacon, a proposal and an execution no sooner than `MIN_CODE_DELAY` (7 days, a constant, longer than any protected payout delay) later; the Pauser Safe can cancel a pending proposal; owners can pin during the wait; the guardian can revoke while paused. |

### Procedure (per version)
1. Draft the new `VaipakamVaultImplementation` — only **append** state.
2. Run the storage-layout guard (`node contracts/script/storage-layout-guard.mjs check`).
3. Deploy the implementation (not behind a proxy).
4. The Timelock calls `VaultBeacon.registerVersion(impl)` — it runs nowhere yet.
5. The Timelock calls `proposeCurrentVersion(id)`; owners see the pending change and may pin.
6. After `MIN_CODE_DELAY`, anyone calls `executeCurrentVersion()`.
7. Verify: `VaultBeacon.implementation()` (from a non-vault caller) and `resolvedVersionOf(vault)` for a sample of vaults.
8. To withdraw a bad version: `proposeRevoke(id, successorId)` then `executeRevoke()` after the delay; in an emergency, while paused, the guardian's `guardianRevokeVersion`.

---

## Pre-flight checklist (applies to both upgrade surfaces)

- [ ] Storage layout diff vs. last release tag — only new fields at the end.
- [ ] `forge test` 100% pass, incl. any new coverage for the change.
- [ ] `forge coverage` for the changed contracts shows no regression > 2%.
- [ ] Forked-mainnet test reproduces a critical user flow on the new state.
- [ ] Gas snapshot reviewed.
- [ ] Public status page draft ready (what's changing, why, user impact).
- [ ] Rollback path documented (can you revert the cut? if not, explicitly accept the one-way door).
- [ ] Timelock ETA window checked against known events (no upgrades during a monitored incident window).

---

## Post-upgrade monitoring

For 24h after every upgrade:
- Hourly check of `MetricsFacet.getProtocolTVL()` — compare vs. pre-upgrade snapshot; any unexplained drop > 0.1% triggers pause.
- Watch `DailyGlobalInterestFinalized` events — finalization must continue without gaps.
- Watch `ChainContributionZeroed` — any new instance post-upgrade is suspicious.
- First user claim of each reward type (staking, interaction, treasury) — walk one claim manually and verify amounts match preview.

---

## Review sign-off

Every upgrade (cut or UUPS) requires **two** independent reviewers to sign off in the PR:
1. One engineer familiar with the touched facet/contract.
2. One engineer **not** involved in writing the change.

Both confirm:
- Storage layout diff reviewed.
- Test coverage adequate for the change.
- Pause/timelock procedure followed.
- Incident-rollback plan exists.

No upgrade ships without both signoffs, regardless of urgency. If urgency requires bypass, use `pause()` instead and wait.
