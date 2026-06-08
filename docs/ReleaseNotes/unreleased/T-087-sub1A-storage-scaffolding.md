## Thread — T-087 Sub 1.A: storage scaffolding + ConfigFacet knobs for the cross-chain reward redesign (PR #<n>)

First implementation slice on the [`docs/DesignsAndPlans/CrossChainRewardSystem.md`](../../DesignsAndPlans/CrossChainRewardSystem.md) design that merged in PR #439 (sub-card #441 under umbrella #440). Storage scaffolding only — no user-visible behaviour change in this PR; existing fee paths still flow through the Phase-5 simple-TWA accumulator until the math + call-site rewires land in Sub 1.B.

### Storage layout (Base canonical + mirror)

The `LibVaipakam.Storage` struct gains the full T-087 surface, appended at the end of the struct so the existing storage slots that loupe-reading deploy tools depend on stay exactly where they were. The Phase-5 `userVpfiDiscountState` mapping is renamed to `userVpfiDiscountState_DEPRECATED` to mark its slot dead — the slot is preserved in place so layout is byte-identical to the pre-T-087 deployments; nothing reinterprets it. Every consumer in `LibVPFIDiscount.sol`, `LoanFacet.sol`, and `VPFIDiscountFacet.sol` was renamed in lockstep to the deprecated symbol so the code keeps compiling and the old accumulator still answers reads.

The new state added in this PR:

- The per-user ring buffer of protocol-tracked stake snapshots (`mapping(address => DaySnapshot[30]) dayBalances`, plus `lastUpdateDayId`, `currentStakeStartDayId`, `currentStakeStartSec`, `tierExpirySec`).
- The CCIP push tracking (`userTierPushNonce`, `userTierLastPushedNonce`), the version invalidation surface (`tierTableVersion`, `tierTableSweepDone`), the protocol-funded broadcast budget (`protocolBroadcastBudget`), and the enumerable registry of active stakers (`activeStakerRegistry`).
- The mirror-side cache surface (`userTierCache`, `currentTierTableVersion`, `baseAuthorizedMessenger` — the `baseChainId` slot is reused from the existing reward-report path, no second slot is allocated).
- The cross-chain buyback custody scaffolding (`buybackAllowedToken`, `buybackBudget`, `baseBuybackBudget`, `baseBuybackReserved`, `stakingPoolBuybackBudget`, `buybackRemittanceReceiver`).

Two new struct types land alongside this state: `DaySnapshot` (the per-slot `dayId + balance` tuple Codex round-4 P1 #2 required to disambiguate ring-buffer wraps) and `CachedTier` (the mirror-side packed slot, including the `effectiveBps` field Codex round-11 P1 #6 added so governance updates to the discount BPS table reach mirrors atomically with their version bump).

### Five ConfigFacet knobs

`setTwaRecentDays`, `setTwaWindowDays`, `setTwaRecentWeight`, `setTwaMinStakedDays`, and `setMirrorTierMaxAgeSec` are added to `ConfigFacet`, all ADMIN_ROLE-gated with the per-knob bounds the design doc §5 calls out. Each has its own dedicated error type (`InvalidTwaRecentDays`, etc.) so a misconfigured deploy reverts with a self-describing reason, and each emits a one-line audit event. The corresponding `cfgTwa*Effective()` getter helpers land in `LibVaipakam`, defaulting to the launch values when storage reads 0 — so a fresh deploy behaves correctly with zero post-deploy governance calls. The lower bound on `cfgTwaMinStakedDays` is `2`, not `1`, per Codex round-6 P2 #13 (a `1` would still permit the same-day flash-stake gaming case the gate exists to close).

### Producer artifacts

The five new selectors are wired into `DeployDiamond.s.sol`'s `_getConfigSelectors()` and `HelperTest.sol`'s `getConfigFacetSelectors()` per the facet-addition checklist; the deploy-sanity suite (`SelectorCoverageTest` + `FacetSizeLimitTest` + `DeployDiamondIntegrationTest`) all stay green.

### Out of scope for this PR

The skeleton `LibVPFIDiscount` ring-buffer helpers (`appendDailySnapshot`, `computeRingBufferTwa`, `computeEffectiveTier`, `computeProjectedTierExpiry`, etc.) are NOT added in this PR — they land in Sub 1.B alongside the math. The existing `LibVPFIDiscount.rollupUserDiscount` / `tryApply` / `tryApplyYieldFee` keep their current behaviour against the deprecated accumulator; every call site is untouched. The CCIP wiring (Sub 2) and the mirror-side facet deletions (Sub 1.D) stay out of this slice.
