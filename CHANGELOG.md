# Changelog

All notable changes to Vaipakam (contracts + frontend + docs) are
recorded in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for every tagged release.

Version buckets:

- `[Unreleased]` — work that has merged to `main` but isn't yet on any
  deployed diamond. Ship-notes drafted here become the `[vX.Y.Z]` entry
  at tag time.
- `[vX.Y.Z-sepolia]` — release cut for a Sepolia Phase-1 deploy. Lists
  the facet set, storage additions, role-topology shifts, and any
  ops runbook updates required for that deploy.
- `[vX.Y.Z]` — mainnet release. Inherits everything from the most
  recent `-sepolia` entry that graduated, plus any mainnet-only
  hardening.

Every entry calls out, at minimum:

- **Facets** — facets added / replaced / removed via `diamondCut`. A
  replaced facet with changed function selectors counts as both
  "removed" (for the dropped selectors) and "added" (for the new ones).
- **Storage** — new fields on `LibVaipakam.Storage` or on individual
  upgradeable contracts (`VaipakamEscrowImplementation`). Includes the
  `__gap` slot count consumed, if any.
- **Roles** — role identifiers added, retired, or re-pointed (admin
  role-admin changes).
- **Events** — event signatures added or enriched (new indexed /
  non-indexed args). Enrichments are **not** backwards-compatible for
  indexers; flag them clearly.
- **Breaking** — any on-chain / off-chain contract that external
  integrators or the frontend will have to update against.

---

## [Unreleased]

### Changed

- **`AdminFacet.pauseAsset` / `unpauseAsset` — now accept either
  `ADMIN_ROLE` *or* `PAUSER_ROLE`** (previously ADMIN-only). Rationale:
  `ADMIN_ROLE` is handed to a 48h `TimelockController` post-deploy, so
  per-asset reserve pause (a.k.a. "blacklist asset") needs an
  incident-response surface that bypasses the delay. `PAUSER_ROLE` —
  already the hot-key multisig for `pause`/`unpause` — now covers the
  same responder path for asset-level reserve pause. No storage or
  event changes; new positive-path test
  `test_pauseAsset_worksWithPauserRoleAlone` locks in the behaviour.
- **`TransferAdminToTimelock.s.sol` — no longer transfers
  `PAUSER_ROLE` to the timelock.** `PAUSER_ROLE` joins
  `KYC_ADMIN_ROLE` on the ops hot-key multisig; both must be pre-
  granted to that multisig before the handover script runs. Fixes a
  cross-doc inconsistency where the script moved `PAUSER_ROLE` under
  the timelock while the runbook treated it as a hot-key surface.
  Updated `docs/ops/BaseSepoliaDeploy.md` §11.5 and
  `docs/ops/AdminKeysAndPause.md` (topology table + rotation
  procedure) to match.

### Added

- **Invariant tests** — 5 new property suites covering
  `ConfigBoundsInvariant`, `InterestMonotonicityInvariant`,
  `PerAssetPauseInvariant`, `OfferLoanLinkageInvariant`, and
  `VPFIStakingRewardMonotonicityInvariant`. 12 assertions, 100 runs ×
  50k calls each. Extends the handler pattern already used by the
  other invariant suites.
- **Positive-flow gap-filler tests** — 4 new happy-path tests in
  `PositiveFlowsGapFillers.t.sol`: country-pair allow lifecycle,
  exact-fee `LoanInitiationFee` deduction, partial-repay two-step
  with remaining-balance assertion, and keeper two-layer opt-in
  ledger state.
- **`AccessControlFacet.emergencyRevokeRole(role, account, reason)`**
  — DEFAULT_ADMIN-only escape hatch for incident response; bypasses
  the ADMIN_ROLE Timelock queue so a compromised key can be evicted
  in a single tx. Emits `EmergencyRoleRevoked(role, account, revoker,
  reason)` for audit-trail separation from routine revocations.
  Refuses to revoke DEFAULT_ADMIN_ROLE itself.
- **`StakingRewardsFacet.getStakingRewardPerTokenStored()`** — read-
  only getter over the time-weighted reward-per-token accumulator.
  Added to support the `VPFIStakingRewardMonotonicityInvariant`;
  cheap transparency for off-chain dashboards.
- **`VaipakamEscrowImplementation` `uint256[50] __gap`** — reserved
  tail slots for future UUPS storage additions. Consumes no state
  today; each future field must decrement the array length by the
  number of slots it uses.
- **`EscrowImplementationUpgraded` now includes `newVersion`** —
  third indexed field on the event, mirrors `s.currentEscrowVersion`
  post-bump so indexers can correlate later per-user
  `upgradeUserEscrow` calls without a follow-up read.
- **`ConfigFacet`** — runtime-tunable protocol config facet (fees,
  liquidation knobs, risk thresholds, VPFI tier table). All setters
  ADMIN_ROLE-gated via Timelock.
- **Activity page** inside the app (`/app/activity`) — reverse-
  chronological feed of the current session's journey events with
  status + area filters and deep-links back to the originating
  flow's page.
- **`ChainPicker` component** — reusable custom dropdown (trigger +
  floating menu) replacing the native `<select>` in the Footer,
  public dashboard chain selector, and Buy VPFI discount card. Uses
  the same visual language as the in-app `ChainSwitcher`.

### Changed

- **Phase 1 disables country-pair sanctions** at the protocol level.
  `LibVaipakam.canTradeBetween` unconditionally returns `true`; the
  `allowedTrades` mapping + `setTradeAllowance` setter are preserved
  for a Phase-2 re-activation with zero storage migration. Five
  negative-revert tests that asserted `CountriesNotCompatible` are
  tagged `vm.skip(true)` with Phase-2 re-enable hints.
- **OfferFacet docstring** — consent-surface paragraph rewritten;
  `creatorFallbackConsent` is mandatory on every create (not just
  illiquid legs), matching README.md §"Liquidity & Asset
  Classification" + docs/WebsiteReadme.md §"Offer and acceptance
  risk warnings".
- **Chain display ordering** is now canonical across every surface
  (Footer, Analytics, Buy VPFI, in-app ChainSwitcher, ChainPicker).
  `compareChainsForDisplay` sort helper in `frontend/src/contracts/
  config.ts`: mainnet before testnet, Ethereum family (chainId 1 +
  Sepolia 11155111) pinned to the top of each tier, rest alphabetical.
- **Light theme body** steps from pure white (`#ffffff`) to the
  existing palette grey (`#f7f8fa`); alternating landing sections
  move to `#f0f2f5` so they stay visibly distinct. No new colour
  values.
- **Public Navbar** — full logo always visible (the 1024–1199 px
  icon-only swap is gone). Hamburger breakpoint raised from 1024 px
  → 1200 px so nav links fold BEFORE the point where the logo
  previously had to shrink.
- **Navbar `.themed-select`** and the per-dropdown option rows now
  track the active theme tokens so the open dropdown panels look
  consistent with the surrounding chrome.
- **`KYC_THRESHOLD_USD` constant removed** (dead code — superseded by
  the tiered `KYC_TIER0_THRESHOLD_USD` / `KYC_TIER1_THRESHOLD_USD`).
  `contracts/README.md` constants table updated to the tiered pair.
- **External-protocol name references removed** from every project-
  owned comment and doc. Vendored third-party code under
  `contracts/lib/` is unchanged.

### Removed

- **`KYC_THRESHOLD_USD` constant** in `LibVaipakam.sol` (dead; only
  reference was a commented-out block in `RiskFacet.sol`).
- **Stale frontend coverage directory** (`frontend/coverage/`) — now
  in `.gitignore`.

### Storage

- `VaipakamEscrowImplementation`: appended `uint256[50] private __gap`
  at the tail. No existing storage slot positions shift.

### Events

- `EscrowImplementationUpgraded` — added `uint256 indexed newVersion`
  as a third indexed topic. **Breaking for indexers**: anyone
  subscribed to the old 2-arg signature must update their ABI.
- `EmergencyRoleRevoked` — new event on `AccessControlFacet`, paired
  with `emergencyRevokeRole`.

### Roles

- No topology changes. `emergencyRevokeRole` reuses the existing
  `DEFAULT_ADMIN_ROLE`; no new role introduced.

---

## [Conventions]

### Semver scope for protocol releases

- **Major** — any change that would require a co-ordinated subgraph /
  indexer / frontend update, e.g. removed function selectors, changed
  event signatures (including adding indexed args), storage-slot
  migrations on upgradeable contracts, role remapping.
- **Minor** — new facets or functions, new events (additive), new
  storage fields inside an existing `__gap`, new config knobs.
- **Patch** — documentation, tests, comments, non-behavioural refactors.

### Pre-release tag layout

- `-sepolia` — release cut against a live Sepolia diamond. Used to
  label what ops will actually apply via `RedeployFacets.s.sol`.
- `-mainnet-rc` — release candidate for mainnet cut-over; graduates
  to a clean `vX.Y.Z` tag on final sign-off.

### What belongs in an entry

Every merged-to-main change that a deployment engineer, indexer
operator, or auditor would want to know about. "Fixed a typo" does
not; "raised `MAX_SLIPPAGE_BPS` from 600 → 700" does.
