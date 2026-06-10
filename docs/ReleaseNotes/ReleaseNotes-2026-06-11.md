# Release Notes — 2026-06-11

Today's headline: **sanctions-gate audit + close-out paperwork following yesterday's T-087 close.** The single contract change is #494's keeper-side sanctions audit (PR #495): three Tier-1 entry points (`OfferMatchFacet.matchOffers`, `VPFIDiscountFacet.pokeMyTier`) plus `LibKeeperReward.payVpfiReward` now sanctions-screen their caller, closing concrete leaks where a flagged matcher could receive 1% LIF kickback, a flagged user could drive a protocol-funded broadcast, or — once #489 wires up Sub 2.D housekeeping — a flagged external keeper could draw VPFI rewards.

Alongside the contract change, today's operational paperwork:

- **#492 operator-activation umbrella tracker** filed as the single-stop index for every post-T-087 activation step + Phase-1 follow-up. Six new focused sub-cards (#486 Lido WETH-unwrap, #487 Aave interest harvest, #488 LP v3 TWAP pricing for keeper rewards, #489 per-facet keeper-reward wiring, #490 rewards distributor reads `rewardEmissionsBudget`, #491 staking distributor + buyback budget verification) cover the Phase-1 contract deferrals from yesterday's Sub 3 add-ons. PR #493 added banner references from `DeploymentRunbook.md` + `CcipCutoverRunbook.md` so future operators land on #492 first.
- **#496 (T-091 — NFT-holder claim path) closed as superseded.** Scout against `ClaimFacet` confirmed every claim sub-path already (a) gates the caller to the current NFT holder via `LibAuth.requireLenderNftOwner` / `requireBorrowerNftOwner`, (b) delivers funds directly to the holder's wallet so a fresh holder needs no vault, and (c) auto-provisions the original party's vault on-demand inside `VaultFactoryFacet.vaultWithdrawERC20:397`. The `yetToPromote` ToDo entry pre-dated the current infrastructure. PR #497 updated `docs/ToDo.md` accordingly.

## Thread — Sanctions gate on keeper-callable paths (#494)

Closes the keeper-side gap in the retail-deploy sanctions policy (CLAUDE.md "Retail-deploy policy — sanctions ON; KYC / country-pair OFF"). Three Tier-1 entry points + one library now sanctions-screen their caller.

### What changes

**`OfferMatchFacet.matchOffers` (Tier-1 hard revert)**

The range-orders matcher gets paid a 1% LIF kickback. A sanctioned matcher would receive protocol fees — the exact thing the OFAC screen exists to prevent. matchOffers now calls `LibVaipakam._assertNotSanctioned(msg.sender)` as its first statement; sanctioned matchers revert `SanctionedAddress(who)` before any partial-fill or offer-existence work.

**`VPFIDiscountFacet.pokeMyTier` (Tier-1 hard revert)**

pokeMyTier is a state-mutating entry point that drives a protocol-funded CCIP broadcast — Tier-1 entry per the retail-deploy policy. The other Sub 4 user-initiated paths (depositVPFIToVault / withdrawVPFIFromVault / setVPFIDiscountConsent) were already gated; this closes the matching gap on poke.

**`LibKeeperReward.payVpfiReward` (soft skip — no revert)**

The library's no-revert contract is load-bearing: housekeeping work (sweep, force-resend, periodic accrual, mirror cache catchup) MUST complete regardless of reward outcome. A sanctioned keeper is therefore SKIPPED rather than reverted. The function emits `KeeperRewardSkipped(keeper, actionKind, "sanctioned-keeper")` and returns 0; the housekeeping work still lands; the sanctioned address just gets no payout. Insertion point: same precondition cluster as `cfgKeeperRewardEnabled` / `no-gas` / `no-vpfi-token` — sanctions check is one storage read (free when the oracle is unset, which matches the existing fail-open deploy-time semantics).

### Why this matters

Before this PR, three concrete leaks existed:
- A sanctioned address could match offers on the range-orders book and receive 1% LIF kickback.
- A sanctioned user could fire `pokeMyTier` to trigger a protocol-funded CCIP broadcast.
- Once #489 wires `LibKeeperReward.payVpfiReward` into Sub 2.D housekeeping facets, sanctioned external keepers could draw VPFI rewards.

The audit also confirmed the surfaces that are CORRECTLY left open:
- `RepayFacet.repayLoan` — Tier-2 close-out, stays open so the unflagged counterparty can be made whole.
- `DefaultedFacet.markDefaulted` — same.
- `ProtocolBroadcastFacet.topUpBroadcastBudget` — caller donates ETH to the protocol; no reward path.

### Test coverage

- New `test_matchOffers_sanctionedMatcher_reverts` in MatchOffersScaffoldTest.
- New `test_PokeMyTier_SanctionedCaller_Reverts` in PokeMyTierTest.
- LibKeeperReward integration test deferred to #489 (no consumer of `payVpfiReward` exists yet; planting `cfgKeeperRewardEnabled` + `vpfiToken` + `sanctionsOracle` via vm.store on the bare harness is high cost for a 4-line addition that follows the established soft-skip idiom).

### Verification

- Existing test suites green (24 tests across the touched contracts).
- Deploy-sanity green.
