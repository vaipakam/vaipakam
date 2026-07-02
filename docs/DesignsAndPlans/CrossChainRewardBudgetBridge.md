# Cross-Chain Reward Budget Bridge (#776)

> Design doc — Option C, on-demand Base→mirror VPFI reward-budget
> remittance. Status: **signed off; Base sender implemented in PR #889**
> (this doc is code-free — the notes tagged "impl PR #889" describe the
> shipped behaviour of the companion code PR, not code in this PR).
> Remaining epic stages: PR2 (mirror receiver + deploy/CCIP wiring), PR3
> (E2E + spec/runbook), PR4 (keeper automation). See §13.

## 1. Problem

The cross-chain interaction-reward mesh finalizes accounting but never
moves the VPFI needed to pay mirror-chain claims:

- `RewardAggregatorFacet.finalizeDay` sums each chain's USD-18 interest
  into a global denominator; `broadcastGlobal` ships only the scalar
  `(dayId, globalLender, globalBorrower)` triple to mirrors.
- `VaipakamRewardMessenger` is **hard-coded data-only** — its receive
  path reverts on any attached token (`UnexpectedTokens`). It physically
  cannot carry VPFI.
- A mirror receiving the broadcast sets `knownGlobalSet[dayId]`, which
  opens the claim gate but checks **nothing** about VPFI balance.
- `InteractionRewardsFacet.claimInteractionRewards()` pays via
  `IERC20(vpfi).safeTransfer(claimant, paid)` **from the Diamond's own
  raw balance**. There is no reward vault and no per-chain budget
  reservation — only a global `interactionPoolPaidOut` counter vs the
  `VPFI_INTERACTION_POOL_CAP` (69M) constant.
- Nothing funds a mirror's VPFI. On a mirror the only mint path is the
  CCIP `BurnMintTokenPool` (`VPFIMirrorToken` has no EOA mint surface),
  so VPFI must be bridged over CCIP and routed to the mirror Diamond.

**Consequence:** a mirror day can finalize (gate opens) with an empty
VPFI balance → the claim passes the gate then **reverts at the ERC20
transfer**. The spec (`TokenomicsTechSpec.md` §4a line 258 +
`CrossChainRewardSystem.md:273-276`) asserts *as current behavior* that
"the Base treasury bridges that budget to each mirror through the
configured cross-chain token path as part of finalization" — which is
unimplemented AND names the data-only channel that cannot carry tokens.

This is a broken-feature + spec-divergence class issue (labelled
`bug`/`security`), not a fund-loss exploit: the failure mode is a
reverting claim, not stolen value.

## 2. Chosen model — Option C (on-demand remittance)

A **permissioned, batched, retriable** Base→mirror VPFI remittance,
decoupled from the `finalizeDay` hot path. Delivers the spec's
Base-funds-mirrors promise while avoiding the hazards of bridging value
automatically inside every finalization (CCIP lane rate limits, native
fee funding, replay, per-day failure recovery).

Modelled on the existing, proven **`remitBuyback` →
`BuybackRemittanceReceiver`** CCIP programmable-token-transfer flow
(mirror→Base). The budget bridge is its **mirror image** (Base→mirror).

### Non-goals
- No change to the claim math or the data-only reward messenger.
- No automatic bridging inside `finalizeDay`/`broadcastGlobal`.
- Not a per-user cross-chain claim — the aggregate chain slice is
  remitted; users still claim locally from the funded balance.

## 3. Slice computation (Base has every input)

A chain's owed VPFI for day `D` equals the sum of that chain's users'
accruals, which telescopes to the chain-level slice:

```
budget[chainId][D] =
    halfPool[D] × chainLenderNum[D][chainId]   / globalLenderNum[D]   // lender half
  + halfPool[D] × chainBorrowerNum[D][chainId] / globalBorrowerNum[D] // borrower half
```

All four inputs are already on Base after finalization:
- `halfPool[D]` = `LibInteractionRewards.halfPoolForDay(D)` (pure).
- `chainLenderNum[D][chainId]` =
  `s.chainDailyLenderInterestNumeraire18[D][chainId]` (written on
  report ingress); borrower analogous.
- `globalLenderNum[D]` = `s.dailyGlobalLenderInterestNumeraire18[D]`
  (written by finalize); borrower analogous.

**Zero-denominator guard (impl PR #889):** each half is added only when its
global denominator is non-zero — a finalized day with no activity on one
side (`globalLenderNum == 0`, e.g. every clean-repay was borrower-side)
contributes 0 from that half instead of dividing by zero. `halfPool == 0`
(day 0 / pre-emissions) short-circuits to a zero slice.

**Participation gate (impl PR #889):** the slice is non-zero ONLY for a chain
whose numerator was actually folded into `D`'s finalized denominator —
tracked by a per-day `chainDailyIncluded[D][chainId]` flag that
`RewardAggregatorFacet._finalizeAndWrite` sets for each expected+reported
chain. This closes the "ops removed a chain from `expectedSourceChainIds`
after it reported but before `finalizeDay`" hole: that chain is excluded
from `globalNum` yet keeps its stale `chainDailyNum`, so an ungated slice
would divide the stale numerator by the smaller denominator and over-send.
The flag snapshots participation AT finalize, so it is also immune to any
post-finalize expected-set edit.

Because Σ over *included* chains of `chainNum` = `globalNum`, Σ over those
chains of `budget[·][D]` = `halfPool[D]` (lender) + `halfPool[D]`
(borrower) = that day's full emission. So the remittances partition the
69M pool exactly — no over-emission is possible from the slice math itself.

**Rounding:** integer division floors each slice; the dust (≤ nChains
wei per half per day) stays on Base. Base is a consumer chain too, so
leftover dust is simply claimable/retained there — acceptable, matches
how the claim path already floors.

## 4. New on-chain state

Base-side (idempotency + global-cap safety):
```
mapping(uint32 => mapping(uint256 => uint256)) rewardBudgetRemitted;   // chainId => dayId => amount
mapping(uint32 => uint256)                      rewardBudgetRemittedTotal; // chainId => cumulative
uint256                                         rewardBudgetRemittedGlobal; // Σ all mirrors
```
`rewardBudgetRemittedGlobal + interactionPoolPaidOut(Base)` is guarded
`≤ VPFI_INTERACTION_POOL_CAP` so Base can never remit more than the
pool. A per-`(chainId, dayId)` non-zero entry blocks re-remittance
(idempotent; safe to retry a whole batch — already-sent days are
skipped).

**The reservation is symmetric (impl PR #889).** The guard above runs on the
remit side, but the Base *claim* side must reserve remitted budget too, or
Base could pay its own claimants the VPFI already shipped to mirrors and
jointly breach the 69M cap. So `LibInteractionRewards.poolRemaining()` and
the `InteractionRewardsFacet` claim/sweep caps subtract
`interactionPoolPaidOut + rewardBudgetRemittedGlobal` (not just
`paidOut`), and `getInteractionSnapshot()` reports the same reserved
`remaining`. `rewardBudgetRemittedGlobal` is Base-only (remittance is
`onlyCanonical`), so on a mirror it is 0 and the bound collapses to the
plain `CAP − paidOut`.

Mirror-side (observability only — claims draw from raw balance, so this
is not load-bearing for payout):
```
address rewardRemittanceReceiver;   // the receiver authorized to call the ingress
uint256 rewardBudgetReceivedTotal;  // cumulative VPFI credited from Base, for reconciliation
```
(A per-day received map was considered but dropped — the batch's `dayIds`
ride the `RewardBudgetReceived` event for reconciliation, so only the
running total needs to persist.)

## 5. Base-side sender — `RewardRemittanceFacet`

New facet (keeps `RewardAggregatorFacet` under the EIP-170 size limit;
verify at build):

```solidity
function remitRewardBudget(
    uint32 dstChainId,
    uint256[] calldata dayIds,
    uint256 perRemittanceCap        // operator/keeper sizes it under the live lane (§7)
)
    external payable
    nonReentrant
    whenNotPaused                   // Diamond-pause-gated, like broadcastGlobal / remitBuyback
    /* ADMIN or the optional rewardRemittanceKeeper (§9.1) */
{
    // reject empty dayIds; require perRemittanceCap in (0, CAP]
    // for each dayId:
    //   require s.dailyGlobalFinalized[dayId]              (else RewardDayNotFinalized)
    //   if rewardBudgetRemitted[dstChainId][dayId] != 0 → CONTINUE (skip; NOT a revert)
    //   slice = LibInteractionRewards.chainRewardBudgetForDay(dstChainId, dayId) (§3)
    //   if slice > 0: mark rewardBudgetRemitted[dstChainId][dayId] = slice; total += slice
    //        (writing the marker on the first pass also de-dupes a dayId repeated in this call)
    // if total == 0 → revert NothingToRemit
    // guard: total <= perRemittanceCap                    (else RemittanceExceedsCap)
    // guard: rewardBudgetRemittedGlobal + interactionPoolPaidOut + total <= CAP (else RewardPoolCapExceeded)
    // effects (CEI): rewardBudgetRemittedGlobal += total; rewardBudgetRemittedTotal[dst] += total
    // approve CcipMessenger for `total` canonical VPFI (exact amount, per feedback_token_approvals)
    // fee = CcipMessenger.quoteMessageFee(...); require msg.value >= fee
    // CcipMessenger.sendMessage{value: fee}(
    //     dstChainId, payload=abi.encode(dayIds, total), [TokenAmount(vpfi, total)], destGasLimit)
    // refund (msg.value - fee) to msg.sender
    // emit RewardBudgetRemitted(dstChainId, total, dayIds.length, messageId)
}
```

Note `perRemittanceCap` is a first-class parameter of the send API (not a
storage knob) so each send is independently chunked. Already-remitted days
are **skipped, not reverted** — a whole-batch retry after a partial/failed
send is safe (§8). Marking the first occurrence of a day also collapses an
accidentally-duplicated `dayId` within one call to a single slice.

The send is `whenNotPaused` + `nonReentrant` — the SAME outbound
pause/reentrancy gate as `RewardAggregatorFacet.broadcastGlobal` and
`TreasuryFacet.remitBuyback` (see `docs/ops/AdminKeysAndPause.md`), so a
Diamond-pause incident freezes reward-budget sends alongside every other
outbound reward/treasury flow even if the CCIP messenger itself is still
unpaused. Authorization (ADMIN / keeper) is layered ON TOP of the pause
gate, not instead of it.

The canonical 69M pool is held on Base, so the VPFI to send comes from
the Base Diamond's balance (locked into the CCT `LockReleaseTokenPool`
on send; an equal amount of `VPFIMirrorToken` is minted on the
destination — 1:1 CCT invariant preserved).

A companion view `quoteRewardBudget(dstChainId, dayIds) → (total, perDay[])`
lets the keeper/operator compute the VPFI amounts (it applies the same
skip/de-dup as the send path). **CCIP fee:** the keeper can't call
`CcipMessenger.quoteMessageFee` directly — the messenger authorizes quotes
by `channelOf[msg.sender]`, and the keeper EOA is not a registered handler.
For PR1 the fee is handled by over-paying `msg.value` on
`remitRewardBudget` and receiving the surplus back (the refund line above);
a convenience Diamond-side fee-quote view (the Diamond *is* the handler, so
it can quote) lands with the keeper automation in PR4.

## 6. Mirror-side receiver — `RewardRemittanceReceiver`

Per-mirror UUPS contract mirroring `BuybackRemittanceReceiver`:
- Implements `ICrossChainMessageRecipient.onCrossChainMessage(src, payload, tokens)`.
- Validates: sender is the configured Base messenger/peer; `tokens.length == 1`;
  `tokens[0].token == vpfiMirror`; `tokens[0].amount == decoded total`
  (declared-vs-delivered check, exactly like `BuybackRemittanceReceiver`).
- Forwards the delivered `VPFIMirrorToken` into the mirror Diamond
  (`safeTransfer(diamond, amount)`, fee-on-transfer-safe: it credits the
  Diamond's actual balance delta) and calls the thin ingress
  `IRewardBudgetIngress(diamond).onRewardBudgetReceived(token, amount, dayIds, sourceChainId)`
  to record `rewardBudgetReceivedTotal` + emit for monitoring. The payload
  is `abi.encode(dayIds, total)`; the receiver cross-checks
  `tokens[0].amount == total` (declared-vs-delivered).
- `GuardianPausable` on the receive path (matches every cross-chain
  contract); a paused inbound reverts and CCIP marks it re-executable.

Claims are unchanged: the Diamond's now-funded balance satisfies
`safeTransfer(claimant, paid)`.

**Why funding is deliberately fungible across days (not a per-day claim
reserve).** The per-day remittance accounting (zero-slice, idempotent
marker) lives on the *Base send* side; on the mirror, claims draw from the
raw VPFI balance and are gated by `knownGlobalSet[day]` (the broadcast
denominator), exactly as Base's own claims are gated by finalization. That
means a mirror's remitted VPFI is fungible: a claimant for a
broadcast-but-not-yet-remitted day can spend balance that arrived for a
different day. This is intentional and **safe, not a loss vector**:

- Underfunding is a **safe revert**, never an over-pay. If the balance
  can't cover a claim, `safeTransfer` reverts the whole (nonReentrant)
  claim tx — no partial payout, no double-spend — and the user simply
  retries after the keeper tops the mirror up.
- It **self-heals**. Σ remitted across all finalized days = Σ claimable
  (the slice math partitions the pool), so once every finalized day is
  remitted the balance covers every claim. The transient is purely
  ordering (early claimants drain first; later ones wait for the next
  remittance) — a liveness wrinkle inherent to the on-demand model, not a
  solvency gap.
- The keeper loop (§13 PR4) keeps mirrors funded ahead of the claim
  frontier, and the operational invariant is **remit-before-broadcast**
  for a day so its claim gate opens already funded.

A per-day claim-side *funded gate* was considered and rejected: it would
re-couple the deliberately-decoupled remit and claim paths (adding
mirror-side per-day funded state + a claim-path check) to convert a safe,
self-healing liveness transient into a hard gate — net-negative for a flow
whose failure mode is already "revert and retry."

## 7. Rate-limit & fee handling

- `VpfiPoolRateGovernor` caps VPFI CCIP lanes (the buyback/general
  starting point is ≈ 50k capacity, ≈ 5.8 VPFI/s refill). Batching over
  `dayIds` + `perRemittanceCap` drains a MULTI-day backlog in lane-sized
  chunks. But a **single day is remitted atomically** (its slice is marked
  and sent as one amount — the design keeps per-`(chain,day)` idempotency
  rather than partial-day accounting), so batching cannot split one day.
- **Mandatory lane provisioning (deploy gate).** Because a day is atomic,
  the Base→mirror reward-budget lane capacity MUST be ≥ the largest single
  `(chain, day)` slice, or that day can never be sent. That maximum is
  deploy-time computable from the FIXED emission schedule: it is bounded by
  `2 × halfPoolForDay(1)` (a chain that is 100% of both sides on the
  highest-APR day) — on the order of ~200k VPFI. So the reward-budget
  direction's `CCIP_RATE_CAPACITY` is provisioned to comfortably exceed
  that bound (NOT the 50k buyback default). The reward-budget lane
  (Base→mirror outbound) has its own rate-limit bucket, independent of the
  buyback lane (mirror→Base), so raising it does not affect buyback.
  `quoteRewardBudget` surfaces each day's slice so the operator/keeper can
  confirm it fits before sending.
- **Future option (not v1):** if a lower cap is ever required, partial
  per-day remittance (send part of a day's slice, track the remitted
  amount, send the remainder after refill) can replace the atomic marker.
  Deferred — the provisioning bound above makes it unnecessary for the
  Phase-1 schedule.
- CCIP native fee: paid as `msg.value` on `remitRewardBudget`
  (operator/keeper funds it), refund to caller — same shape as
  `broadcastGlobal{value: fee}`.

## 8. Failure / replay / partial-finalization

- **Idempotent:** per-`(chainId, dayId)` remitted-amount marker; a
  re-run skips already-sent days, so a retry after a partial/failed
  batch is safe.
- **CCIP delivery failure:** the tokens+message are one CCIP tx; on
  destination revert (e.g. paused receiver) CCIP records a failed
  message, manually re-executable once unpaused — nothing is lost (same
  guarantee as the buyback path).
- **Partial finalization:** `remitRewardBudget` only accepts days where
  `dailyGlobalFinalized[dayId]`. A chain zeroed at finalization — because
  the grace window elapsed before it reported, or `forceFinalizeDay`
  closed the day early (Insurance-pool reconciliation, IncidentRunbook §2)
  — is NOT flagged in `chainDailyIncluded[D]`, so its slice is **zero**
  and it can never spend budget that belongs to the chains actually folded
  into `D`'s denominator (§3 participation gate). A chain that DID report
  and WAS included finalizes and remits normally.
- **Re-org / late marker:** remittance runs only against finalized
  (immutable) day state, so no re-org exposure beyond CCIP's own.

## 9. Design decisions (resolved 2026-07-02)

1. **Authorization — DECIDED:** owner OR an allowlisted
   `rewardRemittanceKeeper` role. The role defaults **unset =
   owner-only**; enabling it lets the keeper loop (§13 PR4) automate
   remittance. Smallest surface now, room to automate. Setter is
   owner-only (admin multisig → timelock).
2. **`perRemittanceCap` — DECIDED:** operator/keeper-supplied argument,
   validated against a bounded max, so callers chunk under the live
   `VpfiPoolRateGovernor` lane capacity.
3. **Keeper automation — DECIDED: IN THIS EPIC.** Ship the apps/keeper
   loop that watches newly-finalized days and remits automatically under
   the rate cap (fee funding, backoff, idempotent re-runs), alongside
   the contract + operator runbook. Adds **PR4** (§13).
4. **Sanctions gating — DECIDED:** none. Remittance is a
   protocol-internal treasury movement with no external counterparty, so
   no `_assertNotSanctioned` on the remittance path.

## 10. Spec + docs to update (in the same PRs)

- `TokenomicsTechSpec.md` §4a line 258 — restate as: Base remits each
  mirror's finalized slice over the CCIP **token** path via
  `remitRewardBudget` (on-demand), not "as part of finalization."
- `CrossChainRewardSystem.md:273-276` — correct the claim that budgets
  arrive over the data-only BROADCAST path; point at the new token path.
- `docs/ops/IncidentRunbook.md` — add a "fund mirror reward budgets"
  operator step (quote → remit → verify mirror balance) + a low-balance
  monitor note.
- `docs/FindingsAndFixes/Findings0{1,2}052026.md` finding 00006 → mark
  resolved with the PR ref.
- Release-note fragment + `docs/FunctionalSpecs` intended-behavior edit.

## 11. Facet-addition checklist (per CLAUDE.md)

`RewardRemittanceFacet` must be added to: `DiamondFacetNames.cutFacetNames`,
`SelectorCoverageTest._populateRoutedSet` (+ `_getRewardRemittanceFacetSelectors`),
`FacetSizeLimitTest`, `DeployDiamondIntegrationTest`, `DeployDiamond.s.sol`,
`SetupTest.t.sol`, `HelperTest.sol`, `exportFrontendAbis.sh` FACETS +
`abis/index.ts`, indexer allowlist (if it emits indexed events), and
persist its address via `Deployments.writeFacet`. The new
`RewardRemittanceReceiver` needs its own deploy script wiring +
`DeployCrosschain.s.sol` registration + CCIP lane/peer config.

## 12. Test plan

- **Unit (Base):** slice math (single + multi-chain, rounding/dust),
  idempotency (double-remit skipped), global-cap guard, not-finalized
  revert, `perRemittanceCap` bound, fee handling.
- **Unit (mirror):** receiver declared-vs-delivered token validation,
  wrong-token/count reverts, pause freezes inbound, ingress records
  `rewardBudgetReceived`.
- **E2E (the missing coverage from scoping):** finalize a day →
  `remitRewardBudget` → CCIP-deliver (chainlink-local `CCIPLocalSimulator`
  as already used) → mirror Diamond balance rises → **`claimInteractionRewards()`
  on the mirror succeeds drawing the bridged VPFI** (closes the exact
  gap in `CrossChainRewardPlumbingTest` which stops at the gate).
- **Invariant:** Σ remitted + Base-paid ≤ 69M across the mesh.

## 13. Suggested PR staging

1. **PR1 — Base sender + accounting + views + unit tests**
   (`RewardRemittanceFacet`, storage, slice lib, cap guard). No
   cross-chain wiring yet; test slice/idempotency/cap in isolation.
2. **PR2 — Mirror receiver + ingress + deploy/CCIP wiring + receiver
   unit tests** (`RewardRemittanceReceiver`, `onRewardBudgetReceived`).
3. **PR3 — E2E funded-mirror-claim test + spec/runbook/finding updates +
   release note.** The functional gap is closed here.
4. **PR4 — keeper automation** (apps/keeper): watch finalized days, remit
   under the rate cap with fee funding + backoff + idempotent re-runs;
   ops config + secrets. Closes #776.
