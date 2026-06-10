## Thread — T-087 Sub 3 add-on #472: Fee-converted VPFI priority routing (PR #<n>)

Sub 3 add-on. Per the 2026-06-09 design discussion: every partial buyback fill's delivered VPFI now cascades through THREE destination budgets in priority order — `rewardEmissionsBudget`, then `keeperRewardBudget`, then `stakingPoolBuybackBudget` as final overflow.

### Why

Until this card lands, all delivered VPFI flowed straight to `stakingPoolBuybackBudget` (Sub 3.B/3.C behaviour). That widens the staker claim eventually (via Sub 3 add-on follow-up), but leaves fresh-mint emissions + keeper rewards unchanged.

The priority router lets governance decide that **some portion of buyback proceeds should first offset fresh-mint inflation** (by topping up the reward emissions budget the existing distributor pulls from BEFORE minting new VPFI). The same router can also fund operational keeper rewards before the overflow cascades to stakers.

### How it works

`LibTreasuryBuyback.postInteractionImpl` now calls a `_routePriority(s, actualVpfi)` helper after every partial fill. Each step claims up to `(target - current_budget)`; the remainder cascades. Zero target disables the step entirely (the cascade skips it).

1. **`rewardEmissionsBudget`** — claims up to `cfgRewardEmissionsTopUpTarget - rewardEmissionsBudget`.
2. **`keeperRewardBudget`** — claims up to `cfgKeeperRewardTopUpTarget - keeperRewardBudget`.
3. **`stakingPoolBuybackBudget`** — receives the remainder.

A new `BuybackPrioritySplit(delivered, toRewards, toKeepers, toStaking)` event fires per partial; the sum invariant `toRewards + toKeepers + toStaking == delivered` is enforced by construction.

### Backwards compatibility

Both top-up targets default to `0`, which disables both steps. With defaults, the cascade lands every fill into `stakingPoolBuybackBudget` — IDENTICAL to Sub 3.C behaviour. The 45 existing buyback unit tests pass unchanged.

### Storage additions (append-only)

- `uint256 rewardEmissionsBudget` — current credit of the rewards-emissions destination.
- `uint256 keeperRewardBudget` — current credit of the keeper-rewards destination.
- `uint256 cfgRewardEmissionsTopUpTarget` — floor amount the cascade tops the rewards budget up to.
- `uint256 cfgKeeperRewardTopUpTarget` — floor amount the cascade tops the keeper budget up to.

### Producer artifacts

- TreasuryFacet selectors 32 → 38 (6 new: 2 setters + 4 reads).
- ABI bundle regenerated.

### Test coverage

8 new tests in `BuybackPriorityRouterTest.t.sol`:

- Default zero targets → all to staking (regression confirmation).
- Full cascade across all 3 destinations.
- Partial cascade: rewards consumes everything when delivery < rewards gap.
- Rewards at floor → cascade skips to keepers; both at floor → all to staking.
- Sum invariant (`toRewards + toKeepers + toStaking == delivered`).
- Setter access control (not-admin rejection) for both targets.
- Zero target disables the step (round-trip).

### Out of scope

- The actual rewards distributor change that PULLS from `rewardEmissionsBudget` BEFORE minting fresh VPFI — that's a follow-up on the rewards distributor side. Until that lands, the new budget slot accumulates but doesn't yet offset fresh-mint emissions; once the distributor reads from it, the inflation-offset becomes live.
- The keeper reward distribution itself — Sub 3 add-on #474.

### Verification

- BuybackPriorityRouterTest 8/8.
- BuybackValidatedCommitTest 15/15.
- BuybackEndToEndIntegrationTest 2/2.
- BuybackIntentLedgerTest 28/28.
- Deploy-sanity 12/12.
- Frontend tsc clean.
