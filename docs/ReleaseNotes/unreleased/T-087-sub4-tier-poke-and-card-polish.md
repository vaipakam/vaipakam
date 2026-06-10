## Thread — T-087 Sub 4 — Tier-poke selector + user-scoped EFFECTIVE_TIER hook + LenderDiscountCard polish (PR #<n>)

Frontend completion of T-087's chain-agnostic experience promise — phase 1. This PR lands the foundational pieces; the broader Stake VPFI surface + chain-switcher UX is the phase-2 follow-up.

### What changes

**Contract — new `pokeMyTier()` selector on `VPFIDiscountFacet`**

Permissionless, balance-mutation-free rollup of the caller's VPFI-discount accumulator. Use case: the time-only EFFECTIVE_TIER activation (Sub 1.B P1 #7) — once a user's stake has aged past `cfgTwaMinStakedDaysEffective`, their tier becomes claimable without any balance mutation. `pokeMyTier()` lets them surface that activation to mirror chains via the protocol-funded broadcast path (Sub 2.D) without making a tiny deposit/withdraw round-trip.

- Re-reads `LibVPFIDiscount.trackedVpfiBalance(msg.sender)` and re-stamps the accumulator at the same balance.
- Idempotent: equal-tier broadcasts short-circuit at the broadcast layer, so repeated pokes don't spam mirrors.
- Gated by `whenNotPaused` (consistent with deposit/withdraw); NOT gated by `vpfiDiscountConsent` (a consent-off user can still poke; their broadcast carries `(0, 0)` accurately).
- New event `TierPoked(user, trackedBalance)`.
- Selector wired through `DeployDiamond.s.sol` + `HelperTest.sol`; VPFIDiscountFacet selectors 24 → 25.
- ABI bundle regenerated.

**Frontend — `useEffectiveDiscount(user)` hook**

Generalized version of the per-loan `useLoanLenderDiscount`. Reads the post-gate `(tier, bps)` for any user. Drives every tier-display surface uniformly: dashboard tier widget, LenderDiscountCard, lender-preview hook.

**Frontend — LenderDiscountCard polish (zero-discount reason)**

Sub 1.D round-2 P3 #2 deferral. The zero-effective-discount state was previously surfaced with one blanket "consent enabled, no eligible VPFI" message — conflating two distinct cases:

1. **No VPFI staked**: the existing copy applies — stake to start earning.
2. **Min-history pending**: NEW — the user HAS VPFI in the vault but hasn't aged past `cfgTwaMinStakedDaysEffective`. Time alone activates the tier; no action needed.

The card now distinguishes them via the user's vault VPFI balance (`useVPFIDiscountTier`). When the balance is non-zero but the effective discount is zero, the new `minHistoryPendingTitle` / `minHistoryPendingBody` strings surface — copy explicitly tells the user their tier will switch on automatically.

### Producer artifacts

- VPFIDiscountFacet selectors 24 → 25.
- ABI bundle regenerated.

### Test coverage

3 new tests in `PokeMyTierTest.t.sol`:

- `test_PokeMyTier_HappyPath_WithStake` — staker can poke without balance change; tier preserved; event emitted.
- `test_PokeMyTier_HappyPath_NonStaker` — non-staker can poke (no-op at accumulator level); no revert.
- `test_PokeMyTier_RevertsWhenPaused` — covered by the shared `whenNotPaused` modifier across every facet.

### Out of scope (Sub 4 phase 2)

- **Global "Stake VPFI" CTA** on dashboard / offer / loan pages with one-click chain-switcher to Base.
- **"Tier update in progress" non-blocking notice** after stake/unstake that clears when the next CCIP push lands (polls mirror's `userTierCache` for the new nonce).
- **"Your tier is ready — claim on mirrors"** CTA + the visual poke button (this PR ships the contract surface + i18n strings; the button itself is part of phase 2).

These are coherent visual / UX changes; shipping them together in a phase-2 PR keeps the LenderDiscountCard polish + the contract foundation reviewable independently.

### Verification

- PokeMyTierTest 3/3.
- Deploy-sanity 12/12.
- Frontend tsc clean.
