# VPFI Recycling — Loop-Closure Design (independent assessment + v2 deltas)

| Field | Value |
| --- | --- |
| **Title** | VPFI Recycling — Loop-Closure Design |
| **Author** | Vaipakam Developer Team |
| **Date** | 2026-07-16 |
| **Status** | **RATIFIED (owner, 2026-07-16)** — all five §10 decisions accepted as recommended; pending Codex design-doc review before implementation cards are cut |
| **Owner directive** | *"Near-zero legal expenditure; better for the platform; no burning — recycle absorbed VPFI into the reward stream."* |
| **Related** | [`VpfiRecyclingBalanceGovernorDesign.md`](VpfiRecyclingBalanceGovernorDesign.md) (RATIFIED 2026-07-15), [`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md), [`VpfiAbsorptionDistributionFormulaRedesign.md`](VpfiAbsorptionDistributionFormulaRedesign.md) (#1294 rev 13 + #1297 rev 14 Codex-r6 freezes), [`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §5, [`VPFITokenomicsRedesignResearch.md`](VPFITokenomicsRedesignResearch.md), [`VPFISecuritiesFeatureExcision.md`](VPFISecuritiesFeatureExcision.md) |

> ⚠️ **Not legal advice.** Same posture as every doc in this family: near-zero
> legal *expenditure* is a design constraint, not a clearance claim.

---

## 1. Mandate and method

The owner asked for a fresh plan and design for VPFI recycling under three
constraints — (a) near-zero legal expenditure, (b) better for the platform,
(c) recycle absorbed VPFI into the reward stream, never burn — treating every
existing design as a suggestion, and benchmarking against how comparable
DeFi / DEX / lending protocols handle the same problem.

Method: the existing three-doc stack (governor + cross-chain substrate +
#1294 absorption/distribution formulas) was re-derived from first principles
against (i) the code ground truth (every VPFI inflow/outflow site was
re-verified), (ii) production tokenomics of GMX, dYdX, Aave, Curve/Convex,
Camelot, Jupiter, Osmosis, Hyperliquid, Raydium, Synthetix, and (iii) the
2023→2026 US regulatory arc, including two datapoints **not yet recorded in
this repo** (§4).

**Verdict up front (honest, not deferential): the ratified backbone survives
the adversarial re-derivation and should be KEPT.** The governor's
absorption-coupled budget (`dailyPool = scheduleFloor + (1−m)×Ā`), the
recycle-at-source/net-remit mesh, and #1294's fee-native tariff +
fee-linked loan-side reward cap independently reconstruct the three safest
patterns in production DeFi (§3). Discarding them would reproduce months of
Codex-hardened correctness work to arrive at the same shape. What the
re-derivation *did* find is that the loop is designed **open at the
distribution end** and thin at the cold-start absorption end — five concrete
gaps (§5) with five additive deltas (§6) that close the loop, none of which
reopens a ratified decision.

## 2. The one-paragraph model of the loop

VPFI the protocol absorbs (tariffs, notification fees, forfeited rewards,
future slashes — the governor §4 classes) credits a protocol-owned
**recycle bucket**. At day finalization the governor sizes the reward budget
as the decaying pre-funded floor **plus** `(1−m)` of trailing-7-day
absorption (`m` = 5% retained platform margin). Users earn from that budget
only through their **own completed lending activity**, per-user- and
per-loan-capped: rewards on a loan are bounded by a **fee-linked ceiling**
sized from that loan's notional tariff (`½×C*×(1−m_reward)` per side —
stamped for every reward-eligible loan whether or not any VPFI was actually
absorbed), so reward extraction is capped by the scale of fees genuinely
paid on that loan (the dYdX-style fee-linked cap), never by pool size. Nothing is burned: the 230M hard
cap already provides permanent scarcity (owner decision 2026-07-13), and
every recycled token extends the reward program's life instead —
after the 69M pre-fund exhausts, the program continues indefinitely at
`(1−m)×Ā`.

## 3. External benchmark — where the Vaipakam stack sits

Production designs for "protocol-absorbed native token → what now?", and
what each teaches:

| Protocol | Mechanism | What Vaipakam's stack already mirrors | What it deliberately avoids |
| --- | --- | --- | --- |
| **dYdX v4** | Trading rewards hard-capped at ≤90% of the *user's own net fees* per fill; block budget ≤ that block's fees. Killed the v3 wash-farming economy | #1294's `loanSideRewardCap = ½×C*×(1−m_reward)` is exactly this fee-linked cap, per loan per side; the governor's `(1−m)×Ā` is the epoch-budget analog | — |
| **Aave (2025 Aavenomics)** | "Buy and Distribute": revenue buys AAVE **into the ecosystem reserve** (not burned) to fund future incentives; 320k AAVE from a closed migration contract redirected into the reserve | Recycle bucket = the reserve pattern, minus any market operation (receipts arrive as fees, no buyback needed) | Buyback stays dormant (#687-C) — Vaipakam gets the "reserve refills rewards" property with zero market touch |
| **GMX** | esGMX escrowed rewards; unvested forfeits return to the pool; Multiplier Points burn on unstake | Forfeited interaction rewards → bucket (the same "forfeiture extends the runway" loop, §4 of the governor) | The separate non-transferable escrow token (§7 — rejected) |
| **Jupiter ASR** | Quarterly rewards conditioned on activity, computed on time-weighted stake, **auto-staked at claim** | Time-weighted tier accumulator already exists; **delta RL-1 adopts the auto-stake-at-claim analog (claim-to-vault)** | — |
| **dYdX retroactive rewards** | Unclaimed rewards **swept back to the community pool** at epoch end | Not adopted yet — **delta RL-3 proposes a (long) claim horizon** as an owner decision | — |
| **Curve/Convex (veCRV)** | 50% of fees pro-rata to passive lockers in cash-equivalents; gauge voting | — | This is the dividend-shaped end Vaipakam excised (#687-B); gauges also created the Curve-Wars capture surface (Mochi attack) — the fixed formulaic allocation here has no vote-directable emissions |
| **Trader Joe sJOE** | USDC revenue share to stakers | — | Same dividend shape — avoided |
| **Hyperliquid** | ~97% of fees auto-buy HYPE; fully automated, no discretion | The loop's full determinism (report→net→consume, no per-epoch committee) matches the "administrative/ministerial" property | Buyback + burn framing |
| **Uniswap (UNIfication, 2025)** | Chose **burn over distribute** explicitly to reduce regulatory exposure after years of fee-switch paralysis | — | Instructive contrast: burn was *their* legal-comfort tool because their alternative was a dividend to passive holders. Vaipakam's alternative is a **usage rebate**, which has its own (stronger) legal shape — so the owner's no-burn call costs nothing legally *as long as rewards stay usage-shaped* (§4) |
| **Synthetix** | Ended inflation; fee-funded rewards only | The governor's end-state (`floor→0`, budget `= (1−m)×Ā`) is this exact "emissions sunset into fee-funded rewards," built in from day one instead of retrofitted | — |

Sources: GMX docs (tokenomics/rewards), dYdX docs + Chaos Labs wash-trading
detection, Aave governance (Aavenomics update; Umbrella), Curve resources
(veCRV fee distribution), Jupiter ASR, Hyperliquid docs, Raydium docs
(buyback-to-treasury), Synthetix SIP-2043, Uniswap UNIfication coverage.

## 4. Legal frame — two datapoints to add to the repo's evidence base

The repo's legal spine (#694 research) anchors on the **SEC/CFTC
interpretation of 2026-03-17 (release 33-11412)**. Two earlier datapoints
strengthen the exact shapes this design family uses and are recorded here so
they are citable from specs and any future bounded counsel review:

1. **Fuse no-action letter (SEC Corp Fin, 2025-11-24)** — first no-action
   relief for a rewards token: a token earned through user activity and
   redeemable **only for discounts/rebates on platform costs**. Attribution
   stated precisely (this section is meant to be citable): the argument
   that *"cost reduction or redemption capability are not 'profits' to the
   consumer but rather a type of rebate to encourage certain consumptive
   behaviors"* is from **Fuse's incoming counsel letter** — the
   representations on which relief was requested. The **staff response
   itself** says only that the Division will not recommend enforcement
   action based on those representations, and expressly *"does not express
   any legal conclusion."* The precedent is therefore: a rewards program
   with exactly this consumptive/rebate fact pattern, described to the
   staff in exactly these terms, drew no-action relief. That fact pattern
   **partially maps** to the Vaipakam shape — rewards earned by own
   activity whose in-platform utility is fee-discount standing — and the
   material differences must travel with the citation: Fuse's rewards were
   for energy/grid-support behaviours, not financial/lending activity, and
   Fuse represented that it does not pass utility payments through to
   consumers, while this repo's own research (#694) continues to treat
   foreseeable activity rewards on a lending platform as a
   counsel-relevant residual. Fuse therefore supports the
   **consumptive-rebate characterization** of rewards-redeemable-for-fee-
   discounts — it is a partial analogy, never clearance for a lending
   rewards surface. It remains the closest external precedent and should
   be cited alongside 33-11412 in any legal-posture section — with both
   the counsel-letter-vs-staff-response distinction and this
   partial-analogy scope preserved wherever quoted.
2. **SEC Corp Fin statement on protocol staking (2025-05-29)** — protocol
   staking is non-securities where the activity is "administrative or
   ministerial," not entrepreneurial. Not directly applicable (VPFI is not
   PoS stake), but the *property it rewards* — full determinism, no operator
   discretion in the flow — is one the recycling loop already has and must
   keep (no per-epoch allocation committee; see RL-4's bounded register).

The resulting design rules, restated once (they bind every delta in §6):

- Rewards are **usage rebates**, sized by the user's own activity,
  fee-linked-capped. Never pro-rata to passive holding, never
  cash-equivalent revenue share, never a promised rate.
- **Issuer representations dominate** under 33-11412: all copy says
  *rebate / fee discount / program longevity* — never yield, APY, income,
  deflation, scarcity, or price.
- **No market touch, no published price, no purchase surface** (#687-A
  stands; governor §14 stands).
- **Full determinism**: the loop is bookkeeping over fees already received.

## 5. Gap analysis — where the ratified stack leaves value on the table

The re-derivation found the loop **closed on the absorption side and open on
the distribution side**, plus three smaller structural gaps:

| # | Gap | Evidence |
| --- | --- | --- |
| **G1** | **Distribution-end leak.** Claimed rewards pay `safeTransfer(msg.sender, …)` straight to the claimant's wallet (`InteractionRewardsFacet.claimInteractionRewards`). Every distributed VPFI exits the sink system entirely unless the user manually re-deposits to their vault. The whole hold-demand engine (tier TWA, min-history, min-tier clamp) only sees VPFI that users move back in by hand — the loop's biggest single leak, at the exact point the protocol controls | Code: `InteractionRewardsFacet.sol` claim transfer; tier system reads only vault balances via the tracked-balance chokepoint |
| **G2** | **Cold-start absorption is a single thin channel.** #1294 itself flags Full attach as "rare at cold start" (users hold no VPFI yet); until then absorption ≈ notification fees + reward forfeits. The Layer-1 spend-gated perks (E-2) and service bonds (#1219) that would widen absorption are sequenced behind the tariff work with no committed slot | #1294 "Product honesty"; governor §4 launch-status table |
| **G3** | **The retained margin is purposeless capital.** `m×Ā` accumulates in the bucket forever; Phase C tooling can move it between protocol pockets but no priority order exists for what it is *for* | Governor §3.3 ("Nowhere — and that is the point") |
| **G4** | **Unclaimed commitments never expire.** A committed reward day is released only by forfeit, "never by time," so availability accounting carries an unbounded tail of dormant `(user, day)` commitments from users who never return; each one permanently reduces `fundable[D]` | Governor §3.1 commitment accounting |
| **G5** | **The legal argument is asserted, not evidenced.** The stack's docs argue safety from first principles; no doc records the external precedent set (§3/§4) that makes the argument checkable by a future counsel in one sitting | grep: Fuse NAL cited nowhere in `docs/` |

## 6. The v2 deltas (RL-1 … RL-6)

All additive. RL-1 is the substantive design change; the rest are hardening,
sequencing, and evidence.

### RL-1 — Claim-to-vault delivery (the loop closer) — RECOMMENDED, ADOPT

**Change:** `claimInteractionRewards()` delivers the claimed VPFI into the
claimant's **per-user vault** by default, instead of `safeTransfer` to the
wallet. An explicit `claimToWallet` flag (or a one-time user preference)
preserves wallet delivery for anyone who wants it.

**Delivery primitive — Diamond-funded vault credit (load-bearing).** The
existing `VaultFactoryFacet.vaultDepositERC20` chokepoint is **not usable
as-is**: it is user-funded (`safeTransferFrom(user, proxy, amount)` against
the claimant's wallet allowance), while rewards are paid from the
**Diamond's** pre-funded VPFI balance — routing a claim through it would
revert for claimants without a matching wallet balance/allowance, or
silently move the user's own VPFI instead of the reward. RL-1 therefore
specifies a **Diamond→vault credit primitive**: the Diamond transfers the
reward VPFI directly to the claimant's vault proxy and then runs the same
*recording* tail the deposit chokepoint runs — increment the
protocol-tracked vault balance (`protocolTrackedVaultBalance`) and stamp
the post-mutation tier rollup (`rollupUserDiscount`) — so the credit counts
toward tier standing instead of being clamped out as unsolicited dust. Only
the recording logic is reused; the user-funded pull is not.

**Broadcast-safety rule:** on the canonical chain a tier-changing rollup
can trigger a protocol-budget-gated CCIP tier broadcast that bubbles
failures into the mutation (per `VPFIDiscountSystem.md`) — a claim must
never inherit that failure mode when today's wallet claim would have
succeeded. The credit primitive therefore records locally with the tier
broadcast **deferred/suppressed** (the push is an optimization; the next
mutation or keeper pass carries it), or — if the local rollup itself would
revert — the claim falls back to wallet delivery. Claim availability is
never reduced by delivery venue, tier plumbing included.

**Atomicity of the fallback:** the transfer + recording + rollup runs as
one revert-isolated unit (the house try/catch-around-self-call pattern), so
a failure at ANY step rolls back **all** vault-side effects before the
wallet fallback pays — never untracked vault dust from a
transfer-succeeded/rollup-failed split, never a double-pay (vault and
wallet), and never a bubbled revert that regresses availability. Tests
cover a forced rollup failure: vault state unchanged, wallet paid once.

**Why this is the highest-leverage delta:**

- Every rewarded VPFI lands **inside the sink system** on arrival: it
  increments the protocol-tracked vault balance, stamps the post-mutation
  tier rollup, and immediately counts toward fee-discount standing and
  future Full-tariff spending power. The distribution end of the loop
  stops leaking by default and starts feeding both demand sinks (S-1/S-3)
  mechanically.
- It directly attacks G2 as well: Full-tariff attach requires users to
  *have* vault VPFI. Claim-to-vault is the bootstrap that fills vaults
  without any purchase surface.
- Production precedent: Jupiter ASR auto-stakes rewards at claim —
  the reward re-enters the system instead of hitting the market.

**Legal shape — unchanged.** This changes the *delivery venue* of a rebate,
not its character. Critically, it is **not a lockup**: the vault is the
user's own custody surface and withdrawal stays available at any time, so no
"holding requirement" or vesting condition is introduced (avoiding any
hold-to-earn optics — the token is simply delivered where it is useful).
Copy rule: describe as "rewards land in your vault, ready to use" — never as
auto-staking or compounding.

**Mechanics and edge rules:**

- Use the Diamond-funded vault credit primitive above, never a bare
  transfer to the vault address — a bare transfer would be clamped out by
  the anti-dust tracked-balance rule and earn no tier standing — and never
  the user-funded deposit chokepoint (see the load-bearing note above).
- **Contract-routed claimants: raw default, explicit selector for all.**
  Two live wrappers depend on the claim paying a raw balance to the
  calling contract: `AggregatorAdapterImplementation.claimInteractionRewards`
  (adapter must hold the VPFI for `sweepToPrincipal`) and
  `BackstopVaultImplementation.claimInteractionRewardsToDiamond` (forwards
  the raw balance to treasury) — these are hardwired to raw delivery
  (updated in the same PR). For **other** contract callers the default is
  also raw (preserving every integration's observed behaviour), but the
  delivery selector (`deliverTo`) is an explicit claim parameter available
  to every caller — so a user claiming through a smart-contract wallet
  (Safe, AA account) is not shut out of the loop: their wallet passes
  `deliverTo = Vault` and gets the same Diamond-funded vault credit as an
  EOA. Only direct EOA-style user claims default to vault delivery. Tests
  cover both wrappers plus a contract-wallet vault opt-in.
- **Delivery must never reduce claim availability.** The claim path
  resolves the claimant's vault **read-only** (the existing vault mapping)
  — it never routes through `getOrCreateUserVault`, which both creates
  vaults and reverts `VaultUpgradeRequired` for vaults below
  `mandatoryVaultVersion`. If the vault is absent **or** gated by a
  mandatory upgrade, delivery falls back to wallet/raw transfer (exactly
  today's behaviour) instead of blocking the claim; a test covers the
  below-mandatory-version claimant.
- Sanctions posture unchanged: the claim entry point keeps its existing
  tier gating; delivery venue does not alter it.
- Forfeit routing is untouched **by RL-1**: forfeited amounts keep
  flowing to treasury exactly as today until the governor stack's PR-3a
  re-routes that class into the recycle bucket (forfeited interaction
  rewards are one of the governor §4 LIVE absorption classes, so the
  re-route is PR-3a's job, with the source-split rules applied there).
  RL-1 neither implements nor blocks that re-route — but the re-route
  must land with PR-3a or the G2 cold-start absorption stays thinner
  than this design specifies.
- **Mirror chains — same mechanics, honestly scoped benefit.** The vault
  system is per-chain, so the credit primitive applies identically on
  mirrors; but tier standing is resolved on Base and mirrors read only the
  Base-pushed cached tier (per the tier-propagation design), while local
  mirror vault VPFI satisfies only the required-balance checks. Rewards
  delivered into a mirror vault therefore give **local spendable balance**
  (Full-tariff spending power, balance gates) — they do not by themselves
  raise the user's tier. The tier-standing bootstrap is a Base-side
  benefit; a canonical-credit path for mirror deliveries is a possible
  future extension, deliberately out of RL-1's scope.
- Emit `RewardDeliveredToVault(user, amount, claimDayId)` per
  vault-delivered claim, stamped with the **claim day** — the day the
  tokens actually leave protocol custody — never one of the underlying
  finalized reward days. A claim spanning many reward days emits one
  aggregate event on its claim day; no per-reward-day split is emitted or
  needed, because RL-2 defines **both** sides of its ratio on the same
  claim-day basis (see RL-2's day-basis rule).

**Tests:** claim credits tracked vault balance + tier rollup stamped at
post-mutation balance; wallet opt-out honored; dust-clamp not triggered;
Diamond-funded credit works with zero wallet balance/allowance (the P1
failure case); adapter `sweepToPrincipal` and backstop treasury-forward
flows unchanged; forfeit split unchanged; invariant `diamondVpfiBalance ≥
userLifCustody + unclaimedRewardBudget + recycleBucket` unaffected (payout
leaves the diamond either way).

### RL-2 — Loop-closure metric (extends #1218) — ADOPT

Add to the transparency dashboard — **daily is a flow ratio, cumulative is
a stock ratio; the two are deliberately different quantities** (a stock
numerator over a flow denominator would re-count Monday's still-vaulted
rewards against Tuesday's small claim volume and spike above 100% without
meaning anything):

```
// Daily (flow): of what went out today, how much stayed in / came back
loopClosureRatio[D] = (netVaultDelivered[D] + absorbed[D]) / distributed[D]
//   vaultDelivered[u][D]     = rewards delivered to u's vault ON day D
//   rewardFundedDebits[u][D] = u's retention-ledger decrements ON day D
//   netVaultDelivered[D]     = Σ_u max(0, vaultDelivered[u][D]
//                                        − rewardFundedDebits[u][D])
//   // netting is PER USER, then summed — an aggregate net would let
//   // user B spending old rewards cancel user A's same-day retained
//   // delivery and under-report closure on mixed-user days

// Cumulative (stock): lifetime view
cumLoopClosureRatio[D] = (retainedStock[D] + cumAbsorbed[D]) / cumDistributed[D]
//   retainedStock[D] = Σ_u rewardRetained[u] at day-D close (ledger below)
```

The same-day netting is load-bearing: a user who claims 100 VPFI to the
vault and spends that same 100 on a tariff the same day must count **once**
(in `absorbed`), not once as "stayed" and again as "came back" — without
the netting that day would read 200%. Same-day reward-funded debits net
against that day's deliveries first (consistent with the ledger's
rewards-spent-first rule), so a daily value above 100% remains possible
only for the legitimate reason — a day that absorbed more than it
distributed — never from counting the same tokens twice.

**Day basis (pinned):** both sides of the ratio are **claim-day based** —
`distributed[D]` is the VPFI actually paid out by claims on day `D` (the
day tokens leave protocol custody), and vault deliveries are attributed to
the same claim day via RL-1's `RewardDeliveredToVault(user, amount,
claimDayId)` event. A claim spanning many finalized reward days therefore
lands entirely on its claim day on both sides; the underlying reward days
are deliberately not re-split. This makes the dashboard deterministic —
every indexer reading the same events reports the same number.

**Attribution rule (pinned — reward VPFI is fungible inside a vault, so
"still vaulted" is not observable from balances alone).** The indexer
maintains a per-user **reward-retention ledger**, driven by events:

```
on RewardDeliveredToVault(u, amount):    rewardRetained[u] += amount
on ANY vault VPFI debit for u            rewardRetained[u] -=
   (withdrawal, tariff, fee, perk spend):    min(debit, rewardRetained[u])
on non-reward vault VPFI deposits:       no change (never increases it)

vaultRetainedRewards[D] = Σ_u rewardRetained[u] at day-D close
```

Debits spend reward-delivered VPFI **first**, and later personal deposits
can never re-inflate the ledger — so a user who withdraws their rewards and
later re-funds the vault with non-reward VPFI shows zero retained rewards
(a naive `min(balance, cumDelivered)` clamp would falsely report full
retention in that case). `rewardRetained[u] ≤ trackedVaultVpfi[u]` holds by
construction, the metric is a conservative lower bound, and it can never
overstate loop closure. Per-day values are point-in-time snapshots at day
close (never summed across days — cumulative views recompute from the same
ledger, which also prevents double-counting a balance that persists across
day closes).

**Zero-distribution convention:** on days with `distributed[D] == 0` (day 0
/ non-emitting days, zero-demand days), the per-day ratio is reported as
`null / not applicable` and excluded from averages — never `0`, `NaN`, or
`∞`. Cumulative views use cumulative sums, which stay well-defined once any
distribution has occurred.

**Observability dependency (one small contract addition):** the ledger's
debit leg requires vault VPFI debits to be event-visible, and today
`VaultFactoryFacet.vaultWithdrawERC20` adjusts `protocolTrackedVaultBalance`
without emitting a generic debit event — VPFI leaving through a generic
vault path would be invisible and `rewardRetained` would overstate. RL-2
therefore adds one event, `VaultVpfiDebited(user, amount, source)`, emitted
at the tracked-balance decrement chokepoint (covers withdrawals, tariff
pulls, fee pulls, perk spends in one place). This is the delta's only
contract change beyond RL-1's delivery event.

Together with `selfFundingRatio` (#1218) this makes the loop's health two
observable numbers — how much of distribution stays in the system, and how
much of distribution the system's own absorption funds.

### RL-3 — Reward claim horizon (bounded liability tail) — RATIFIED (see §10.2)

**Proposal:** rewards become sweepable to the recycle bucket `H` days after
the underlying loan's terminal event (proposed `H = 365`; bounded knob,
min 180). The sweep is permissionless (keeper class) and applies the
governor's source-split rules with **split signals** — the two shares must
not share one credit event: the **fresh-funded share** (tokens genuinely
leaving the fresh budget into protocol custody) emits
`VpfiRecycled(EXPIRED_REWARD, …)` and enters the day-bucketed `credited[D]`
that feeds `Ā`; the **recycled-funded share** is a pure commitment release
(bucket availability restores, no tokens newly absorbed) and emits a
separate non-credit signal (e.g. `RewardCommitmentReleased(EXPIRED_REWARD,
…)`) that never touches `credited[D]` — otherwise dormant recycled-funded
rewards would inflate trailing `Ā` and future budgets on every expiry,
absorbing nothing.

- **For:** closes G4 — without a horizon, `fundable[D]` degrades forever
  under dormant commitments, and the accounting tail grows unboundedly.
  Production precedent: dYdX swept unclaimed epoch rewards back to the
  community pool. Legally inert (rebate programs with redemption windows
  are the norm; a 12-month window on a fee rebate is conservative).
- **Against:** it takes value from dormant users; the ratified governor
  deliberately chose "released only by forfeit — never by time."
- **If adopted:** prominent UX — claim-center countdown plus a pre-expiry
  notice that **must ride free channels** (the in-app notification center
  from #1213, which needs no billing): the existing paid-push channel is
  VPFI-billed and skips users with insufficient vault VPFI
  (`markNotifBilled` reverts and the watcher skips) — exactly the dormant,
  broke claimants RL-3 would sweep, so paid push may only ever be an
  *additional* channel, never the required one. Spec edit to the
  governor's commitment rules, and the horizon runs **per reward entry
  from that entry's first full claimability** — for most entries that is
  the loan's terminal event, but an entry that becomes claimable earlier
  (e.g. a lender entry closed/re-anchored by a position transfer) starts
  its horizon at that earlier moment, so the liability tail is genuinely
  bounded from first claimability. The clock never runs while a claim is
  blocked by missing finalization/broadcast.
- **Grandfathering at activation:** entries already claimable when the
  feature activates are never sweepable immediately —
  `expiresAt = max(firstClaimableAt + H, activationAt + noticeWindow)`
  with `noticeWindow ≥ 90 days` (bounded), so every pre-existing dormant
  claimant gets the full claim-center countdown and pre-expiry
  notification before any sweep is possible.

*(Historical note: this delta was drafted as an owner decision — rather
than folded in — because it amends a ratified sentence in the governor doc.
It has since been **ratified for adoption** (§10.2) and is as binding on
implementation cards as every other adopted delta: the 365-day sweep ships
with the RL-3 implementation PR, which also adds the superseding note to
governor §3.1.)*

### RL-4 — Recycled-stream allocation register — ADOPT AT PHASE C′ (dormant before)

Generalize the Phase-C "optional keeper-budget credit" into one bounded,
timelocked register — **defined over the residual only, so the claims-first
invariant holds by construction** (a naive bps split of the whole recycled
term could divert budget from reward claims to keeper/reserve on
high-demand days, contradicting the cross-chain design's §3.5 claims-first
rule; the register therefore never touches the claim-funded portion):

```
// Day D, after the governor sizes recycledBudget[D] and the claim
// commitments are fully funded (claims-first, unchanged):
forwardReserve[D] = RESERVE_N × Ā[D]   // RESERVE_N default 7: keep at least
                                       // one trailing week of coupled budget
                                       // in the bucket for future days
splittable[D] = min( marginRealized[D],                       // day-D m-share
                     max(0, uncommittedBucket[D] − forwardReserve[D]) )
splittable[D] split by weights: [keeperBudget, retainedReserve]
defaults: [0, 10000] bps      // exactly today's ratified behaviour:
                              // margin/surplus stays in the bucket
bounds: weights sum to 10000; keeperBudget ≤ 5000
```

- Encodes "what is the margin/surplus *for*" (G3) as an explicit priority
  stack: claims first (structural, not a weight — identical to §3.5 of the
  cross-chain design), keeper gas second, reserve last — now a declared
  config surface instead of an emergent property.
- **Scope of the no-defund guarantee (both horizons):** same-day claim
  commitments are funded before the register sees anything (structural),
  and the register's base is capped at the day's **realized margin** and
  floored by the **forward reserve** (`RESERVE_N × Ā`) — so a quiet day
  with a large bucket and small commitments cannot drain funds that
  future high-demand days would size against. The register never
  consumes bucket capacity below the forward reserve, and never faster
  than the platform's own margin accrues. Larger aged surpluses remain
  Phase-C surplus-tooling territory (operator-visible, deliberate,
  batched) — never the register's.
- Stays deterministic (weights read once at finalization, stamped like the
  margin) — no per-epoch discretion, preserving the
  administrative/ministerial property (§4).
- Deliberately **not** a gauge: users never vote reward direction
  (Curve-Wars capture surface avoided by construction).

### RL-5 — Absorption bootstrap hardening (sequencing, not new design) — ADOPT

Commit the second and third absorption channels to the same release train as
the tariff, so launch absorption is never single-channel:

1. **Notification flat VPFI tariff** (#1294 PR-7 / governor §13) — also
   removes the last conversion residual. Two separable halves with
   different dependencies: the **flat re-denomination** (dropping the
   `VPFI_PER_ETH_FIXED_PHASE1` conversion) has no deps and pulls forward
   freely; the **bucket credit** requires the recycle-bucket ledger +
   Diamond-custody re-route (governor §4.1 Layer 0 / PR-3a) — today's
   `LibNotificationFee.bill` withdraws user-vault VPFI straight to
   treasury, so shipping PR-7 alone re-denominates the fee but does not
   yet capture it as absorption. Sequence the credit half with (or after)
   PR-3a; until then the tariff is a fee, not yet a loop input.
2. **Spend-gated perks (E-2 / #1204)** — priority solver routing and
   listing-visibility boost are pure fee-for-service VPFI sinks that credit
   the bucket; build the two spend-gated perks (skip hold-gated ones if
   time-constrained) alongside PR-5b so a second permanent sink exists at
   Full launch.
3. **Service bonds (#1219)** — keep behind its legal glance, but schedule
   the glance now (it shares the bounded-review slot the excision doc
   already recommends) so the slash-absorption class isn't blocked on an
   unscheduled prerequisite.

With RL-1 filling vaults at the distribution end, these three plus the Full
tariff give four independent absorption channels within one release cycle of
each other — the flywheel stops depending on any single attach rate.

### RL-6 — Legal evidence pack + copy rules — ADOPT (docs only)

- Record §3's benchmark table and §4's two datapoints in
  `VPFITokenomicsRedesignResearch.md` (or as an appendix referenced from
  it), so the "hand any future counsel two documents" package is: SEC
  release 33-11412 + the Fuse NAL, with the production-protocol comparison
  as context.
- Reaffirm the copy rules (§4) as a checklist item in the release-gate for
  every user-facing recycling/rewards surface — the cheapest legal
  insurance in the whole program, and under 33-11412 the dominant factor.

## 7. Considered and rejected

| Idea | Why rejected |
| --- | --- |
| **Escrowed non-transferable reward token** (esGMX/xGRAIL pattern) | A second token contract = new audit surface, new mesh accounting (escrow state can't ride the CCT lanes), and non-transferable-with-vesting invites "investment-like maturation" analysis. RL-1 captures ~80% of the benefit (rewards re-enter the sink by default) with ~5% of the surface |
| **Vesting bonus** ("claim locked for 90d, get +10%") | Pays extra for time-holding — the hold-to-earn shape §5 of `UserValueEnhancementOpportunities.md` explicitly forbids reintroducing |
| **Demand-balancing split steering** (tilt the 50/50 lender/borrower split of the *recycled* term toward the underserved side) | Genuinely interesting as a market-balancing instrument, but it changes the distribution's character (rewards become operator-steered), adds an economic knob with a gaming surface, and violates the governor's "changes only the pool's size, never its distribution rules" boundary. Revisit only with live-market evidence of persistent one-sided books, as its own design |
| **Burn (any slice)** | Owner decision 2026-07-13 stands and the benchmark reinforces it: burn is the legal-comfort tool for protocols whose alternative is a dividend (Uniswap). Vaipakam's alternative is a rebate — the safer shape already. The governance escape-hatch note in §5.1 remains the only residual |
| **Buyback-style balancing** | Re-rejected on the standing #687-A posture (market operations) — unchanged from governor §10 |
| **EMA / tunable smoothing window** | Ratified as fixed `W = 7`; nothing in the re-derivation justifies reopening (one auditable economic knob beats two interacting ones) |

## 8. The closed loop, composite view

```mermaid
flowchart TB
  subgraph absorb [Absorption — four channels]
    T[Full tariff C* per party] --> B[recycleBucket]
    N[Notification flat tariff] --> B
    P[Spend-gated perks E-2] --> B
    F[Forfeited / expired rewards] --> B
  end
  B -->|Ā trailing 7d| G["Governor: (1−m)×Ā"]
  Floor[scheduleFloor 69M decaying] --> Pool[dailyPool]
  G --> Pool
  B -.->|"margin m stays (RL-4 register)"| R[Keeper budget / reserve]
  Pool --> Caps["50/50 halves → loan-side cap ½×C*×(1−m_r) → D1"]
  Caps --> C[claimInteractionRewards]
  C -->|"RL-1 default: vault delivery"| V[User vault VPFI]
  C -->|opt-out| W[Wallet]
  V --> S3[Hold-tier standing S-3]
  V --> T
  V --> P
  V --> N
```

Every arrow is either a fee receipt, internal bookkeeping, or a usage
rebate; no arrow touches a market, quotes a price, or pays for passivity.

## 9. Plan — how the deltas land

Mapped onto #1294's PR plan (which this design does not renumber):

| Card | Scope | Depends on | Notes |
| --- | --- | --- | --- |
| **RL-1 PR** | Claim-to-vault delivery: the **Diamond-funded vault credit primitive** (new VaultFactory/diamond surface — direct Diamond→vault transfer + tracked-balance/rollup recording tail, broadcast-safe), delivery selector (`deliverTo`) + wrapper hardwiring, `RewardDeliveredToVault` event, opt-out, tests | None (independent of D1/governor) | Can ship **first** — immediate loop value even before the governor exists, since it feeds the live tier system. Scope is NOT the claim tail alone — the credit primitive is load-bearing (§6 RL-1); reusing user-funded `vaultDepositERC20` or a bare transfer is forbidden |
| **RL-2** | Indexer/dashboard metric + the `VaultVpfiDebited` event at the tracked-balance decrement chokepoint (its one contract change) | RL-1 (`RewardDeliveredToVault`), #1218 metrics card | Ledger + flow/stock ratios per §6 RL-2 |
| **RL-3** | Claim-horizon sweep (**RATIFIED**, §10.2) | Governor PR-3 stack (commitment model) | Ships the 365-day per-entry sweep + the governor §3.1 superseding note |
| **RL-4** | Allocation register (dormant defaults) | Governor PR-3b | Config plumbing in the #1217 knob pattern |
| **RL-5** | Sequencing: pull PR-7 forward; E-2 spend-gated perks alongside PR-5b; schedule #1219 legal glance | — | Project-board sequencing, not new code design |
| **RL-6** | Evidence pack + copy checklist | None | Docs-only, immediate |

Spec edits (per house discipline, in the implementing PRs):
TokenomicsTechSpec §4 (claim delivery default + opt-out; claim horizon if
ratified), §9 (allocation register; loop-closure metric), plus
`_CodeVsDocsAudit` rows and release-note fragments per PR.

## 10. Owner decisions — RATIFIED (2026-07-16, all as recommended)

1. **RL-1 claim-to-vault delivery** — **RATIFIED: adopt** as the default
   reward delivery (wallet opt-out preserved). Highest-leverage,
   zero-legal-delta loop closure.
2. **RL-3 claim horizon** — **RATIFIED: adopt** the 365-day post-terminal
   horizon with sweep-to-bucket, amending the governor's "commitments never
   expire by time" sentence, with the UX safeguards listed in §6 (claim-center
   countdown, pre-expiry notification, horizon per entry from first full
   claimability). The governor doc §3.1 gains a superseding note in the
   RL-3 implementation PR.
3. **RL-4 allocation register** — **RATIFIED: adopt** at Phase C′ with
   dormant defaults (claims-first structural; residual split
   `[keeper 0, reserve 10000]` — exactly today's ratified behaviour).
4. **RL-5 sequencing** — **RATIFIED: adopt** — notification flat tariff +
   two spend-gated perks committed to the same release train as the Full
   tariff; #1219 legal glance scheduled with the excision doc's bounded
   review slot.
5. **Backbone confirmation** — **RATIFIED**: governor (RATIFIED 2026-07-15),
   cross-chain substrate, and the #1294/#1297 formula freezes proceed as
   planned; this design adds to them and reopens nothing else.
