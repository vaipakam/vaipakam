# Cross-Chain Reward Budget Bridge (#776)

> Design doc — Option C, on-demand Base→mirror VPFI reward-budget
> remittance. Status: **DRAFT for sign-off** (no code written yet).

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

Because Σ over chains of `chainNum` = `globalNum`, Σ over chains of
`budget[·][D]` = `halfPool[D]` (lender) + `halfPool[D]` (borrower) =
that day's full emission. So the remittances partition the 69M pool
exactly — no over-emission is possible from the slice math itself.

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

Mirror-side (observability only — claims draw from raw balance, so this
is not load-bearing for payout):
```
mapping(uint256 => uint256) rewardBudgetReceived; // dayId => amount, for reconciliation/monitoring
uint256                     rewardBudgetReceivedTotal;
```

## 5. Base-side sender — `RewardRemittanceFacet`

New facet (keeps `RewardAggregatorFacet` under the EIP-170 size limit;
verify at build):

```solidity
function remitRewardBudget(uint32 dstChainId, uint256[] calldata dayIds)
    external payable /* onlyOwner or onlyRewardKeeper — see §9 open Q */
{
    // for each dayId:
    //   require s.dailyGlobalFinalized[dayId]              (else NotFinalized)
    //   require rewardBudgetRemitted[dstChainId][dayId]==0 (else AlreadyRemitted — skip, don't revert the batch)
    //   slice = _computeSlice(dstChainId, dayId)           (§3)
    //   mark rewardBudgetRemitted[dstChainId][dayId] = slice; accumulate total
    // guard: rewardBudgetRemittedGlobal + interactionPoolPaidOut <= CAP
    // guard: total <= perRemittanceCap (§7 rate-limit safety)
    // approve CcipMessenger for `total` canonical VPFI (exact amount, per feedback_token_approvals)
    // CcipMessenger.sendMessage{value: fee}(
    //     dstChainId, payload=abi.encode(dayIds, slices, total), [TokenAmount(vpfi, total)], destGasLimit)
    // emit RewardBudgetRemitted(dstChainId, dayIds, total, messageId)
}
```

The canonical 69M pool is held on Base, so the VPFI to send comes from
the Base Diamond's balance (locked into the CCT `LockReleaseTokenPool`
on send; an equal amount of `VPFIMirrorToken` is minted on the
destination — 1:1 CCT invariant preserved).

A companion view `quoteRewardBudget(dstChainId, dayIds) → (total, perDay[])`
lets the keeper/operator compute amounts + `CcipMessenger.quoteMessageFee`
before sending.

## 6. Mirror-side receiver — `RewardRemittanceReceiver`

Per-mirror UUPS contract mirroring `BuybackRemittanceReceiver`:
- Implements `ICrossChainMessageRecipient.onCrossChainMessage(src, payload, tokens)`.
- Validates: sender is the configured Base messenger/peer; `tokens.length == 1`;
  `tokens[0].token == vpfiMirror`; `tokens[0].amount == decoded total`
  (declared-vs-delivered check, exactly like `BuybackRemittanceReceiver`).
- Forwards the delivered `VPFIMirrorToken` into the mirror Diamond
  (`safeTransfer(diamond, amount)`) and calls a thin ingress
  `IRewardBudgetIngress(diamond).onRewardBudgetReceived(dayIds, slices)`
  to record `rewardBudgetReceived` for monitoring.
- `GuardianPausable` on the receive path (matches every cross-chain
  contract); a paused inbound reverts and CCIP marks it re-executable.

Claims are unchanged: the Diamond's now-funded balance satisfies
`safeTransfer(claimant, paid)`.

## 7. Rate-limit & fee handling

- `VpfiPoolRateGovernor` caps VPFI CCIP lanes (starting ≈ 50k capacity,
  ≈ 5.8 VPFI/s refill). Early-schedule daily budgets can exceed a lane
  bucket. The on-demand design handles this by: (a) a `perRemittanceCap`
  the operator/keeper sizes under the live lane capacity, and (b)
  batching over `dayIds` so a large backlog is drained in lane-sized
  chunks across multiple sends. `quoteRewardBudget` surfaces the total
  so the caller can chunk.
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
  `dailyGlobalFinalized[dayId]` — a zeroed/forced-finalized chain
  (Insurance-pool reconciliation, IncidentRunbook §2) still finalizes,
  so its slice is computed against the finalized denominator like any
  other.
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
