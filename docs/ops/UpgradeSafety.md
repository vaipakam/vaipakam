# Upgrade Safety Review

Covers the two upgrade surfaces in the Vaipakam protocol:

1. **Diamond facet cuts** — add/replace/remove function selectors on the Diamond.
2. **UUPS escrow upgrades** — replace the implementation behind every user's `ERC1967Proxy` escrow.

Plus pre-flight checks that apply to both.

---

## Invariant: storage layout is append-only

Both the Diamond (via `LibVaipakam.Storage`) and the escrow implementation use shared storage. The only safe modifications:

- ✅ **Append** new fields at the end of `LibVaipakam.Storage` struct.
- ✅ **Append** new fields at the end of `VaipakamEscrowImplementation`'s state.
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

## UUPS escrow upgrades

### What a UUPS upgrade can do
`VaipakamEscrowImplementation` is a UUPS upgradeable. The implementation address is stored in the Diamond's `LibVaipakam.Storage`. `EscrowFactoryFacet.upgradeEscrowImplementation(newImpl)` replaces the address for **newly-created** escrows.

Existing users only upgrade when:
- `setMandatoryEscrowUpgrade(true)` is set (forces upgrade on next interaction), OR
- The user calls `upgradeUserEscrow()` themselves.

### Hazards
| Hazard | Mitigation |
|---|---|
| New impl's `_authorizeUpgrade` reverts for every caller (brick) | **Test on a forked mainnet** with the real escrow-admin role. OZ's `openzeppelin-foundry-upgrades` plugin does this automatically. |
| Storage layout change | Same append-only rule. Diff `forge inspect VaipakamEscrowImplementation storage-layout` vs. last release. |
| Reinitializer not wired | Every new version must either (a) have no new initializable state, or (b) expose a `reinitialize(N)` behind the same role. |
| Mandatory-upgrade flag flipped during high activity | Users mid-flow will pay extra gas to upgrade; coordinate with frontend to show a banner first. |

### Procedure (per upgrade)
1. Draft the new `VaipakamEscrowImplementation` — only **append** state.
2. Run the OpenZeppelin upgrade-safety checks (`validateUpgrade` from `Upgrades.sol`).
3. Deploy the new implementation to the target chain (not behind a proxy — just the impl).
4. `ESCROW_ADMIN_ROLE` (timelock) queues `upgradeEscrowImplementation(newImpl)`.
5. After timelock delay, execute.
6. Verify on a **new** escrow created post-upgrade:
   ```solidity
   getOrCreateUserEscrow(testUser)
   getEscrowVersionInfo(testUser)   // should reflect new version
   ```
7. For existing users: decide whether to set `setMandatoryEscrowUpgrade(true)`. Typical answer: **no**, unless the change fixes a security issue. Lazy migration preserves user gas.

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
