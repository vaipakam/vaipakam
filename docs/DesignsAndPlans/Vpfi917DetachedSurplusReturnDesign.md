# #917 — Returning a Detached mirror's pending surplus to Base — design record

| | |
| --- | --- |
| **Status** | Design. The owner chose option D on 2026-10-27. |
| **Card** | #917 (mirror over-remitted reward VPFI has no on-chain reclaim path) |
| **Owns** | Exit for the PENDING SURPLUS custody row on a chain whose reward role is `Detached`. That exit is a permissionless return to Base after a dormancy window, with no admin path. |
| **Does not own** | The custody era registry, era finalization and the closure proof (#1566 slice 4; `Vpfi1566CanonicalDeliveredBoundDesign.md`). The Mode-A and Mode-B repatriation flows (#1434 P2-w5, `VpfiCrossChainRecyclingDesign.md` §3.6a). |
| **Verified against** | `main` @ `9acd2387c`. Every file:line below was read at that commit. |

## 1. What is left of #917, and why

#917 was filed when a mirror received each day's *uncapped* reward slice. Its users could claim less than that, and the surplus sat in the Diamond's commingled VPFI balance with no exit. Most of that problem is gone:

- **Over-remittance is clamped at the source.** Base remits each day only what the mirror reported it owes, side by side (`RewardRemittanceFacet._planDay`), and one day per send (#2832). The unsent remainder is released as `RemitClampResidual`.
- **Reward VPFI is no longer commingled.** After custody activation it sits in the reward custody holder under named rows (#2186), not in the Diamond's balance.
- **An excess arrival has a bounded exit.** It lands in the OVERAGE row, which `releaseRewardCustodyOverage` (ADMIN, manual pause, treasury only) can release.

What remains is **terminal wind-down**: a mirror whose reward role ends up permanently `Detached`.

- A role change retires the live era. The retired era carries the chain's live-fresh custody (`LibRewardCustody.retireCustodyEraOnRoleChange`, `LibRewardCustody.sol:1035`).
- Once every day of the era's span is proven closed, `finalizeCustodyEra` (`:1082`) releases the era's remaining row.
- While the chain is Detached, that release goes to PENDING SURPLUS (`:1108`). Late fresh for an already-terminal era goes there too (`_bookRetiredFresh`, `:1167-1179`).
- The only way out is `RewardEraFacet.drainPendingSurplus`, which credits the live baseline and refuses unless the role is Canonical or Mirror (`RewardEraFacet.sol:65-71`).

So on a chain that never takes a role again, the row is stranded. `TokenomicsTechSpec.md:1110` states this ("which anyone may credit … once the chain is active again"), and `Vpfi1566CanonicalDeliveredBoundDesign.md:2659-2668` leaves the alternative open ("— or it is repatriated"). This document fills that gap.

A planned shutdown of an *active* mirror reaches the same state by detaching it. The live row then retires into an era, the era finalizes, and its remainder reaches PENDING SURPLUS. **So one mechanism covers both terminal cases.**

## 2. Why the value is owed to nobody

Value reaches PENDING SURPLUS only from a FINALIZED era, or as late fresh for one. An era finalizes only when `daysClosed` covers its whole span and nothing staged holds its row (`LibRewardCustody.sol:1086-1098`). A day closes only when every reward entry covering it has terminated: processed, past its claim cursor, and with no staging record or legacy domain left on that day (`LibRewardClosure._tryComplete`).

An entry the era cannot fund does **not** terminate. It defers, because the live leg bounds at zero while Detached (`deliveredFreshBound`, `LibInteractionRewards.sol:5920`). That holds the era open, so its value never reaches PENDING SURPLUS. **The return therefore never has to wait for reward expiry, and it never takes value a user could still claim.**

## 3. Why it cannot fire the moment a chain detaches

Detached is a normal *transient* state:

- A mirror moving to a different base chain must detach first (`RewardBaseChainRebindRequiresDetach`, `RewardReporterFacet.sol:888`).
- The CCIP cutover runbook rotates a chain through Detached as routine operation (`setBaseChainId(0)` → `setBaseRewardDeployment` → `setBaseChainId(<Base>)`, `CcipCutoverRunbook.md:411`).

A return that could run the instant the role reads Detached would let anyone pull the surplus out in the middle of a rotation. The return therefore needs evidence that the detach has **lasted**. Nobody must be able to write that evidence except the role change itself.

## 4. The mechanism

### 4.1 Detached-since: an existing stamp, no new field

Every effective role change on an activated chain runs `retireCustodyEraOnRoleChange`. It opens the next era and stamps `custodyEras[next].openedAt = block.timestamp` (`LibRewardCustody.sol:1049-1052`). That is the only writer of `custodyEraCurrent` and of an era's `openedAt`. Its only caller is `RewardReporterFacet._retireDeliveredResidualOnRoleChange`, reached only from the two role setters.

So while `rewardRole == Detached`, `custodyEras[custodyEraCurrent].openedAt` is exactly the moment the chain became Detached. A re-attach opens a new era, which resets it. **No new field is needed, and nothing else can write it.**

A chain detached *before* custody activation has no era record. It also has no PENDING SURPLUS (the row only exists on an activated chain), so the return has nothing to do there and refuses (§4.3).

### 4.2 The dormancy window

The window is one governance knob on the mirror, `detachedSurplusDormancySeconds`:

- default **30 days**;
- setter bounded to **[7 days, 365 days]**, so a rotation can never come near the floor;
- ADMIN, with an event carrying the old and new values.

The window is read live at the moment of the return. Shortening it only lets an already-finalized remainder leave sooner, and it can never fall below the floor. The return is allowed once `block.timestamp ≥ openedAt + window`.

### 4.3 The mirror-side return: `returnDetachedSurplus(uint256 amount)`

A new **permissionless, payable** entry point on `RepatriationFacet`, beside the other returns. The caller supplies only the CCIP fee, quoted via `quoteDetachedSurplusReturn(amount)`, and any surplus fee is refunded (the `VpfiReturnSender._send` pattern). It refuses by name unless all of the following hold:

1. **The role is `Detached`, checked explicitly.** Not `onlyMirror`, which a Detached chain passes (`RepatriationFacet.sol:401`). `Vpfi1566CanonicalDeliveredBoundDesign.md:3719-3735` already requires that Detached paths gate on the role itself.
2. **Custody is active** and an era is recorded.
3. **The dormancy window has elapsed** since `custodyEras[custodyEraCurrent].openedAt`.
4. **`0 < amount ≤` the PENDING SURPLUS row.** The return is repeatable, because late fresh can still arrive in the row after the window (§1).
5. **A destination is known (§4.4), and `amount` is within that lane's outbound capacity.** This is the existing `_assertWithinLaneCapacity`, so a large row leaves in chunks. Base's inbound capacity cannot be read from the mirror (#1660 r2 precedent).
6. **`whenNotPaused`.** The Diamond pause is the incident lever, and a return is a cross-chain value move like the stranded return. A chain being wound down is *detached*, not paused, so the pause does not block the normal path.

In one transaction:

- It debits PENDING SURPLUS through the existing row primitives (`RewardCustodyRowDebited`). A new event, `DetachedSurplusReturned(amount, dstChainId, issuingBase, detachedSince)`, names the value, where it goes and why it was allowed.
- It releases the tokens to the return sender.
- It sends one CCIP message with the VPFI token amount over the VPFI pool lane: a new wire kind, `DETACHED_SURPLUS_C1`, in `ReturnWire.sol`.

If any step fails, the whole return reverts. The row is untouched and nothing is lost.

### 4.4 The destination

The destination is **never** derived from `baseChainId`, which is zero on a Detached mirror. That is why every existing return path is already dead there: `sendStrandedReturn` and `executeRepatriation` both build `dst` from it and revert `RepatriationLaneUnknown(0)` (`RepatriationFacet.sol:810`, `:915`).

- **New storage field `rewardBaseChainIdLastNonzero`** (appended at the tail of `Storage`). `setBaseChainId` writes it whenever it writes a non-zero value. Nothing else writes it, and `setBaseChainId(0)` leaves it untouched. It names the base chain the mirror last served.
- **The Base Diamond the mirror last served** is already retained as `rewardEraLastNonzero` (`LibVaipakam.sol:6621`). It rides the wire as `issuingBase`, so Base can tell a return meant for itself from one meant for a Diamond it replaced.

If either is unset, the return refuses with `DetachedSurplusNoDestination`. **There is no fallback destination and no admin path.** A chain whose lane is gone keeps the value exactly where it is today.

### 4.5 The Base-side receipt

`VpfiReturnReceiver` gains a branch for `DETACHED_SURPLUS_C1`. Like every other branch it measures what actually arrived (the Diamond balance delta, `VpfiReturnReceiver.sol` ~`:326`), then self-calls a new `onDetachedSurplusReturnReceived(sourceChainId, issuingBase, amountMeasured)`, which is `onlyCanonical` and receiver-only.

- **Right Base** (`issuingBase == address(this)`). The measured amount is credited to the recycle bucket under a new, appended `RecycleSource.DetachedSurplusReturn`, through the `creditCustodyRelocated` path Mode A already uses (`LibVpfiRecycle.sol:951`): measured into the holder's RECYCLED row, then `recycleBucket += amount`. Reward VPFI stays in the reward programme and funds later days.
- **Wrong Base**, meaning a rotated or replaced canonical Diamond. The arrival is real VPFI, so it is not refused (a revert would only park a failed CCIP message). It is credited to OVERAGE instead, which is operator-visible and leaves only through the existing treasury release. It is never spendable reward value.
- **Per-chain record.** A new `detachedSurplusReturnedFrom[sourceChainId]` cumulative and the event `DetachedSurplusReceived(sourceChainId, amount, toRecycle)` make every return attributable to the chain it came from.

**What this credit is and is not, stated so nobody reads it as more:**

- It is a **relocation**. Like `RepatriationReturnRelocation` it is excluded from a day's credited recycled total and from the cumulative a chain reports.
- It does **not** restore `rewardBudgetRemittedGlobal` or any emission figure. The VPFI was emitted when it was remitted, and it comes back as recycled funding, the way forfeited and expired rewards do.
- It mints nothing. Every token credited is a token that arrived.

### 4.6 Automation

The keeper gains a pass, `detachedSurplusReturn`, modelled on `apps/keeper/src/remitAck.ts` (quote, send with `value: fee`, attempt backoff in the keeper's private database). It is armed by a new secret flag, `REWARD_DETACHED_RETURN_ENABLED`, and ships unset, like every other reward pass. On each configured mirror it:

1. calls `finalizeCustodyEra` for every retired era that has become final. Nothing calls this today; it is permissionless and pause-free;
2. when the role is Detached and the window has passed, sends `returnDetachedSurplus` for the lesser of the row and the lane's capacity;
3. raises an ops alert (ops bot) when a Detached chain's row is non-zero past the window but the return refuses, naming the refusal, for example no destination or a lane at capacity.

Anyone else may make the same calls. The keeper only pays the fee.

## 5. Behaviour stated for the functional spec

- A mirror that has been Detached for longer than the dormancy window returns its pending surplus to the Base it last served, automatically and in full, over time.
- The returned value funds later reward days on Base. It never goes to the treasury unless it reaches a Base Diamond other than the one it was meant for.
- The return never takes value owed to a user. Only finalized periods feed it, and a period with an unfundable claim never finalizes.
- A chain that re-attaches before the window passes keeps its surplus, and the surplus drains into its new live baseline as today.
- With no reachable Base, nothing moves.

## 6. Limits, stated

- **An era with an unfundable deferred entry never finalizes**, so its value never reaches the row and is never returned. That is correct, because a user may still be owed it, but it means a wind-down can leave value behind until such entries resolve.
- **A chain detached before custody activation** keeps its levelled residual in the Diamond balance. This mechanism does not cover it.
- **A return in flight when the chain re-attaches** still lands on Base and is credited there. The mirror's new era opens with zero headroom anyway (`levelDeliveredResidual`), so nothing is double-counted.
- **Mode-B stranded returns are also dead on a Detached chain** today (§4.4). The retained destination introduced here could serve them too. That is a separate change, not made here.

## 7. Change list (for the build PR)

| Area | Change |
| --- | --- |
| Storage | `rewardBaseChainIdLastNonzero`, `detachedSurplusDormancySeconds` (mirror); `detachedSurplusReturnedFrom` (Base). All appended at the tail of `Storage`, with the golden file rewritten. |
| `RewardReporterFacet` | `setBaseChainId` writes the last-non-zero id. A bounded `setDetachedSurplusDormancy` setter with its getter. |
| `RepatriationFacet` | `returnDetachedSurplus` (payable), `quoteDetachedSurplusReturn`, `onDetachedSurplusReturnReceived`; new errors and events. |
| `VpfiReturnSender` / `VpfiReturnReceiver` / `ReturnWire` | The `DETACHED_SURPLUS_C1` kind, its send method and its receive branch. These are UUPS satellites, so they reach a chain through their own upgrade or a fresh deploy. |
| `LibVpfiRecycle` | Appended `RecycleSource.DetachedSurplusReturn`. |
| Keeper | The `detachedSurplusReturn` pass, its flag and its alert. |
| Tests | Unit tests for every refusal, the window boundary (one second either side), a rotation inside the window, re-attach resetting the stamp, a chunked return, a late-fresh top-up after the window, and both Base sinks. An Anvil two-chain scenario: detach, finalize, wait, the keeper returns, Base credits recycle. |
| Docs | `TokenomicsTechSpec.md:1110`, the ops knobs list and the DeploymentRunbook detach section, plus a release-note fragment. |
