## Thread — T-087 Sub 3 add-on #474: Keeper VPFI rewards Phase 0 (PR #<n>)

Sub 3 add-on. Per 2026-06-09 design discussion: permissionless housekeeping calls (Sub 2.D sweep / force-resend, periodic interest accrual, mirror cache catchup, etc.) get paid in VPFI at `gasUsed * tx.gasprice * mult` ETH-equivalent value, debited from the `s.keeperRewardBudget` slot the priority router (#472) populates.

### What ships in Phase 0

**Library — `LibKeeperReward`** with the canonical pay function:

```
payVpfiReward(address keeper, bytes32 actionKind, uint256 gasUsed)
  → returns vpfiPaid (zero if skipped)
```

- Reads `s.cfgKeeperRewardMultBps` (default 2x); converts gas to VPFI at the Phase-0 FIXED rate (1 VPFI = 0.001 ETH).
- Debits `s.keeperRewardBudget`; `safeTransfer`s VPFI from the diamond to the keeper.
- NEVER reverts — kill-switch off / budget empty / no-gas / VPFI not configured all return 0 silently with a `KeeperRewardSkipped` event. Housekeeping must complete regardless.
- Emits `KeeperRewardPaid(keeper, actionKind, gasUsed, ethEquivalent, vpfiPaid)` on success.

**TreasuryFacet config surface** (8 new selectors):

- `setKeeperRewardMultBps(uint32)` — multiplier on gas. Bounded [10000, 100000] = 1x..10x. Default 20000 (2x). `uint32` because 100000 exceeds `uint16` max (65535).
- `setKeeperRewardCashOutSpreadBps(uint16)` — Phase-1 cash-out spread. Bounded [100, 2000] = 1%..20%. Default 500 (5%).
- `setKeeperRewardEnabled(bool)` — kill-switch. Default `false`.
- `setKeeperRewardTwapMaxAgeSec(uint32)` — Phase-1 TWAP staleness threshold. Default 1800 (30 min).
- 4 matching reads with default-fallback semantics.

### Phase 0 design choices

1. **Fixed rate, not LP TWAP.** The VPFI/ETH LP TWAP path is sketched (storage slot exists for `cfgKeeperRewardTwapMaxAgeSec`) but not wired. Phase 0 uses the same fixed rate the buy flow uses (1 VPFI = 0.001 ETH). Phase 1 wires the v3 TWAP path + staleness fallback to the fixed rate.
2. **No cash-out.** Cash-out spread setter + storage exist (default 5%) but the actual `cashOutKeeperReward(messageId)` flow requires ETH liquidity the diamond doesn't yet manage. Phase 1 wires it.
3. **No-revert path.** Every failure mode emits `KeeperRewardSkipped` and returns 0 instead of reverting. Housekeeping must complete; the keeper just runs at a loss until the budget refills.
4. **Hook NOT wired.** Adding `LibKeeperReward.payVpfiReward(...)` calls to individual housekeeping facets is a separate per-facet wiring task. This card ships the LIBRARY + the config surface; the consumer-side wiring lands when each facet's keeper-permissionless mode lands.

### Storage additions (append-only)

- `uint32 cfgKeeperRewardMultBps` — multiplier in bps. `uint32` (not `uint16`) because the upper-bound 100000 exceeds `uint16` max.
- `uint16 cfgKeeperRewardCashOutSpreadBps` — Phase-1 cash-out spread in bps.
- `bool cfgKeeperRewardEnabled` — kill-switch.
- `uint32 cfgKeeperRewardTwapMaxAgeSec` — Phase-1 TWAP staleness threshold.

(`s.keeperRewardBudget` already shipped in #472.)

### Producer artifacts

- TreasuryFacet selectors 49 → 57 (8 new).
- ABI bundle regenerated.

### Test coverage

13 new tests in `KeeperRewardTest.t.sol`:

- All 4 config setter happy paths + 4 default-fallback reads (multBps defaults 20000, spread defaults 500, twap defaults 1800).
- Bound enforcement (5 tests): multBps below 10000, multBps above 100000, spread below 100, spread above 2000, all revert.
- Access control (2 tests): non-admin caller for `setKeeperRewardMultBps` + `setKeeperRewardEnabled` both revert.

### Out of scope (Phase 1)

- **VPFI/ETH LP v3 TWAP pricing path + staleness fallback** — `cfgKeeperRewardTwapMaxAgeSec` slot is reserved but not yet consulted.
- **`cashOutKeeperReward(messageId)` ETH cash-out path** — spread setter + storage in place; ETH liquidity management not yet wired.
- **Per-facet wiring** — actual `payVpfiReward(...)` calls in housekeeping facets (sweep, force-resend, periodic accrual, mirror catchup) land when each facet's keeper-permissionless mode lands.

### Verification

- KeeperRewardTest 13/13.
- Deploy-sanity 12/12.
- Frontend tsc clean.
