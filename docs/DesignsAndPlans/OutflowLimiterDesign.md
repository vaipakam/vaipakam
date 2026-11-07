# Outflow limiter, large-withdrawal delay and outflow brake (#3206)

Status: **design for owner review**. The owner's decisions of 2026-11-06
(§1) are requirements. Choices they left open are marked **Default**, and the
open questions are in §11. This design builds on #3204
([central vault code](VaultCentralImplementationDesign.md)), #3205
([one vault outflow policy](VaultOutflowPolicyDesign.md)) and #3268's plan
(the lender is always paid into the lender's own vault), and ships after them.

## 1. Decisions (owner, 2026-11-06)

1. Per-asset rolling outflow caps, plus a delay on large wallet withdrawals.
   The liquidation swap limit stays at 6%.
2. The delay is measured **on the outflow**: a vault's wallet outflows of
   liquid assets passing $1000 in a rolling 24 hours (platform numeraire,
   illiquid valued at 0) wait the delay, for every account. The threshold is
   governance-set, default $1000. Nothing is measured on vault value or price
   moves. Repay, settlement, claims and liquidation proceeds are protocol
   destinations and are unaffected.
3. The caps live in **each vault's own storage**, enforced by the vault (the
   independent second line); the Diamond's check is the first line.
4. A **protocol-wide brake** per asset per window, over outflows from vaults
   and the Diamond, calls the existing auto-pause when exceeded.

## 2. What exists today

**Vault outflows.** The vault's `withdrawERC20/721/1155` accept any recipient
the Diamond passes (`VaipakamVaultImplementation.sol:221`, `:255`, `:298`),
through `VaultFactoryFacet.vaultWithdrawERC20/721/1155` (`VaultFactoryFacet.sol:821`,
`:989`, `:1071`; lien guard `:96`); the owner starts at
`VaultDepositoryFacet.withdrawFromVault` (`:208`). #3205 replaces them with one
vault function, `transferOut`, reached only through `LibVaultOutflow`, which
emits one `VaultOutflow` event per movement. **Diamond outflows** leave through
`LibDelivery.pushMeasured` / `pushOut` (`LibDelivery.sol:198`, `:247`),
`LibFacet.transferToTreasury` (`LibFacet.sol:63`), the keeper bonus
(`LibKeeperReward.sol:227`), reward custody (`LibRewardCustody.sol:912`) and
repatriation (`RepatriationFacet.sol:1042`).

**Auto-pause.** `AdminFacet.autoPause` (WATCHER_ROLE, `AdminFacet.sol:894`)
calls `LibPausable.autoPause` (`LibPausable.sol:362`): a 30-minute window by
default, bounded 5 minutes to 2 hours (`LibVaipakam.sol:494-496`), a no-op while
a window is open, and a revert `AutoPauseCoolingDown` within 24 hours of the
last window (`LibPausable.sol:117-122`, #2744). **Rate limits.**
`VpfiPoolRateGovernor` sets token buckets (capacity plus refill) with
compile-time MIN/MAX bounds (`VpfiPoolRateGovernor.sol:74-82`) and never
disables a limit (`:196-206`). **Protected mode** (`LibProtectedAccount`): a
2 to 5 day delay (`:52-54`), at most 16 open rows (`:64`), a gate that holds a
payout rather than refusing it (`:366`), an earmark per queued row (`:395`)
credited back on cancel (`:431`), release by anyone once due
(`VaultPayoutFacet.sol:126`), and a lock that cancels every row
(`ProtectedAccountFacet.sol:615`, `:625`).

**Valuation.** `NumeraireValueFacet.getLiquidNumeraireValue`
(`NumeraireValueFacet.sol:64`) values a non-Liquid asset at 0 and prices the
rest through `OracleFacet.getAssetPrice` (`OracleFacet.sol:604`), already in the
numeraire; `NumeraireConfigFacet.setNumeraire` (`:132`) rotates it. All of this
is read through the Diamond. #3272 moves pricing into a standalone price guard
that the vaults read too.

## 3. Which outflows count

What decides is the #3205 **destination class**, never the route.

| Class | Delay meter + vault cap | Brake | Why |
| --- | --- | --- | --- |
| Owner: the owner's wallet or an allowlisted address | yes | yes | The wallet outflow the decision means: withdrawals, payout releases, escape withdrawals, surplus collateral to a wallet, a released lien leaving later |
| Counterparty, position holder, seller claim, Diamond transient, listing escrow, backstop | no | no | Protocol destinations inside the system, each bound to a lien. Under #3268 the lender is paid vault to vault |
| Swap adapter, order taker, conduit | no | no (**Default**, Q4) | The value returns in the same transaction, under the 6% floor. Counting it would let a wave of liquidations trip the pause |
| Treasury, incentive | no | counted, never held | These leave the system but must stay unblockable (#3178) |
| Clawback to the recovery address (#3246) | **exempt** | **exempt** | It is the defence against a thief, so it never waits, is never held and never trips a pause. It still emits `VaultOutflow` |
| A Diamond push to a wallet or the treasury | n/a | yes | Goes through the single Diamond outflow entry (§7) |

A claim is therefore unaffected: it lands in the claimant's vault, and only the
later withdrawal to a wallet is metered. A route that paid a claim straight to
a wallet would be metered as owner-class, because otherwise it would bypass the
delay (Q2).

## 4. Where the configuration lives

**Default: a small `OutflowLimitConfig` contract owned by the Timelock**, whose
address is an immutable of the vault implementation; pointing vaults elsewhere
needs a new vault version through the #3204 beacon and its delay. It holds the
threshold with the numeraire it is denominated in, the delay length, the
per-vault buckets (one per ERC-20, one NFT count bucket) and the per-asset
brake buckets.

**Both lines read this one config; each keeps its own state.** No Diamond
storage copies it and no facet can write it: a change needs the Timelock, and a
loosening also waits the contract's own delay (§9). A second copy of the
numbers would only add a sync rule. What must be independent is enforcement and
meter state: the vault keeps its buckets, meter and queue in its own storage;
the Diamond keeps its buckets in `LibOutflowLimiter`'s namespace. The #3205
registry holds addresses, not delayed parameters, and the #3204 beacon is
deliberately minimal and not upgradeable, so neither is the Default (Q1).

## 5. Bucket algorithms

**Caps and the brake are token buckets, as in the CCIP pools.** Each keeps
`tokens`, `lastUpdated`, `capacity` and `rate`; it refills by `rate × elapsed`
up to `capacity`; a movement passes only if its amount is at most `tokens`, and
is debited. Units are the asset's base units, so no bucket needs a price or an
oracle. The vault and the Diamond each keep, independently, one bucket per vault
per ERC-20 and one NFT count bucket per vault (one unit per token id). The brake
keeps one bucket per asset protocol-wide, in the Diamond only.

**The delay meter is a strict rolling 24 hours, not a bucket.** A $1000 bucket
can pass up to twice that within some 24-hour span, against the owner's wording.
The vault keeps 25 hourly sums in whole numeraire units, rounded up, in
saturating 32-bit fields, eight per slot: four slots plus an hour index, about
five reads per outflow. The window is the current hour plus the **24** before
it, so the oldest hour, which still partly overlaps the trailing 24 hours, is
always retained. An outflow therefore stays counted for at least 24 hours and
at most 25. A slot is zeroed only when its hour is reused, 25 hours later.
Rounding and hourly steps only err toward delaying: a $1,000 outflow at 00:59
is still counted at 00:58 the next day.

An outflow is **delayed whole**, never split, when the window sum, plus the
pending reservation, plus its own value would exceed the threshold. Two figures
feed that rule, kept apart because they answer different questions:

- **The meter counts actual payments, at payment time.** A pay-now outflow is
  added when it pays, and a queued outflow is added **when it is released**,
  however long it waited. So a $10,000 withdrawal released after 26 hours still
  delays a $1,000 request made right after it. The released value is the larger
  of the value recorded at request and its value at release when the guard
  answers Ok; if the guard does not answer Ok, the recorded value is used.
- **The pending reservation counts queued rows not yet released**: one running
  sum of their recorded values, in the same units. A large queued withdrawal
  therefore delays small ones while it waits. Release moves its value from the
  reservation into the meter; cancel removes it from the reservation, since
  nothing left the vault.

## 6. Pricing an outflow without trusting the Diamond

The vault reads the #3272 price guard at the Timelock pointer's address, never
from Diamond storage, values the outflow with `LibNumeraireValue`'s arithmetic
(rounded up) and reads the token's decimals itself. The platform's liquid label
is the Diamond's depth probe (`OracleFacet.checkLiquidity`), which a faulty
Diamond could flip, so the vault uses a fact it can check: **an asset is valued
if the guard has a feed for it.** No feed counts as 0 (the illiquid-at-0 rule);
NFTs count 0 and are bounded by their count bucket; a feed with a thin pool is
counted, stricter than the platform label (Q3).

**Fail closed:** a feed whose answer is not Ok (stale, distrusted, sequencer
down) delays the outflow, never values it at 0. If the guard's numeraire
differs from the config's, every valued outflow is delayed until re-anchored
(Q6).

**A numeraire rotation does not carry the old sums over.** The meter and the
pending reservation are tagged with the numeraire they were written in. Sums
in one currency cannot be compared with a threshold in another, and converting
them would need a cross-rate the vault has no trusted source for. So when the
config's numeraire changes, every valued owner outflow is **delayed** (queued,
not refused) until 25 hours after the rotation took effect, when the last
old-currency hour has left the window. The meter then restarts empty under the
new tag. Queued rows keep their old-currency recorded values; on release they
are re-valued in the new currency, and if the guard does not answer Ok they
wait. Both lines apply the same rule, each against its own tag, so a
withdrawal made just before the rotation cannot be paired with an
undercounted one just after it. The first line runs the same rule against the same guard in the same
transaction, so honest paths never disagree. This build waits for #3272: a vault
calling `NumeraireValueFacet` would be the Diamond checking itself.

## 7. The two lines and the brake

**First line: `LibOutflowLimiter` in the Diamond.** `LibVaultOutflow` calls it
for every vault movement, and one Diamond outflow entry wrapping `LibDelivery`
and `transferToTreasury` calls it for the Diamond's own pushes; the #3205 AST
test is extended so no other Diamond code sends tokens out. For an owner-class
outflow it routes to queue or pay by the delay rule, debits its own per-vault
bucket and measures the brake. **Second line: in `transferOut`, on the vault's
own state.** It re-runs the delay rule on its own meter and refuses a pay-now
owner outflow that should wait, and debits its own bucket, refusing when short.

So a **Diamond flaw** cannot skip the vault's delay or cap: after a forged
release on one of #3205's listed exceptions, collateral reaches the borrower's
wallet only at the cap's rate, and above the threshold only after the delay. A
**vault-code flaw** reached through the Diamond is still bounded by the
Diamond's buckets.

**The brake trips without reverting**, since a revert would roll back its own
pause. When an outflow would take a brake bucket below zero,
`LibOutflowLimiter` calls a new non-reverting `LibPausable.tryAutoPause` (the
configured duration, reason "outflow brake"), and then:
- an owner outflow is **held, not refused**: it becomes a queued vault row with
  the full delay, as protected mode holds payouts today;
- a Diamond push to a wallet is credited to the recipient's vault (the existing
  `creditIfProtected` path), and a treasury push is accrued at the Diamond;
- treasury and incentive classes complete; the pause binds from the next
  transaction.

During the cooldown, `tryAutoPause` reports no pause and the brake still holds.
A drained bucket keeps holding owner outflows after the 30-minute window until
it refills. This meets the card's "pauses in the same transaction and is
refused" without a revert undoing the pause.

## 8. The large-withdrawal delay: queue, cancel by lock, release

**One queue, in the vault.** Protected mode's rows (`pendingPayouts`, Diamond
storage today) move into the vault beside the allowlist #3205 moves there. A
row's `releaseAt` is the later of the protected delay (if on) and the outflow
delay (if the rule applies). It records asset, token id, amount, recipient,
`releaseAt` and reason (protected, delay or brake). The 16-row bound stays; a
full queue refuses only the owner's own new withdrawal, never a counterparty.

**Cancel.** The owner or a recorded secondary key, by a signature the vault
verifies, or the Diamond (a cancel only reduces what leaves); the amount stays
free in the vault. **A lock cancels every row, for every account**: protected
accounts as today, unprotected ones by the owner wallet or keeper
(`lockVaultFor`). The vault also accepts a signed lock directly, so a faulty
Diamond cannot refuse one. **Default:** an unprotected unlock takes effect only
after the outflow delay, so a thief with the key cannot unlock and drain inside
the guardian's window.

**Release.** Anyone, after `releaseAt`, while live or under the #3173 escape
rule (as `VaultPayoutFacet.sol:126` does today). Both lines re-check that the
recipient is still allowed and that the per-vault buckets and the brake have
room. A short bucket reverts the release and the row waits for the refill;
nothing is lost.

## 9. Setters, bounds and defaults

All setters are on `OutflowLimitConfig`. **Loosening** (raising the threshold,
a capacity or a rate; shortening the delay; changing the numeraire) waits a
contract-held `MIN_CONFIG_DELAY` of 3 days on top of the Timelock's 48 hours, as
#3204 does for vault code: the Timelock proposes, anyone executes, the Pauser
Safe can cancel. **Tightening** applies when the Timelock executes. As in the
VPFI governor, every value has compile-time MIN and MAX constants, and zero or
a disabled limit is refused.

| Parameter | Default | Bounds |
| --- | --- | --- |
| Delay threshold (numeraire, rolling 24 h) | $1,000 (owner) | $100 – $50,000 |
| Delay length | 24 h (Q5) | 12 h – 72 h |
| Meter window | trailing 24 h, kept as 25 hourly sums (at least 24 h, at most 25 h) | constant (decided) |
| Per-vault cap per ERC-20 | ≈ $250k in units, refills in 24 h (Q5) | above the threshold; full refill no faster than 1 h |
| Per-vault NFT count | 20 ids, refills in 24 h (Q5) | 5 – 500 |
| Brake per asset | ≈ $2M in units, refills in 24 h (Q5) | at least 10× the per-vault cap |

**Units.** A cap's unit figure is converted from its numeraire value once, at
listing, and stated in the listing proposal. It never follows the price
afterwards. Every listed liquid asset must have entries. An unlisted ERC-20 has
no unit cap, but the delay still applies if it has a feed (Q7).

## 10. Transparency: events and views

**Vault events:** `OutflowMetered(asset, amount, value, windowTotal)`,
`OutflowQueued(id, asset, tokenId, amount, to, reason, releaseAt)`,
`OutflowReleased(id, delivered)`, `OutflowCancelled(id, by)`, `VaultLocked`,
`VaultUnlockScheduled(at)`, `CapBucketDebited(asset, amount, remaining)`.
**Diamond events:** `OutflowBrakeTripped(asset, amount, level, pauseSet,
pausedUntil)`, `OutflowHeldByBrake(owner, asset, amount, rowId)`, and the #3205
`VaultOutflow`. **Config events:** `LimitChangeProposed(param, asset, value,
executableAt)`, `LimitChangeExecuted`, `LimitChangeCancelled(by)`.

**Views:** on the vault, `windowTotal`, `roomBeforeDelay`, `wouldDelay(asset,
amount)` (with its reason, including "price unavailable"), `capRoom(asset)` and
`queuedRows`; on the Diamond, `brakeState(asset)`; on the config, every live and
pending value with its time. Before signing, the withdraw screen shows every
account the threshold, its 24-hour total, the delay and its cap room, and says
that a release waits during a pause and that an oracle fault delays rather than
values at 0. `docs/FunctionalSpecs/VaultOperations.md` states every parameter
and every §12 residual.

## 11. Questions for the owner

- **Q1. Config home:** a separate Timelock-owned contract (recommended), the
  #3205 registry, or the #3204 beacon?
- **Q2. Claims:** confirm that "claims are unaffected" means the claim lands in
  the claimant's vault and the later wallet withdrawal is metered; otherwise a
  claim route paying a wallet bypasses the delay.
- **Q3. Liquid in the vault:** "has a feed in the guard" (recommended, the vault
  can check it), stricter than the depth label the vault cannot verify?
- **Q4. Brake scope:** exclude adapter and conduit legs, and count treasury and
  incentives without holding them (recommended), or count everything?
- **Q5. Numbers:** delay length, per-vault caps, NFT count, brake capacities;
  the §9 figures are proposals, not derived from data.
- **Q6. Numeraire rotation:** move it into the guard together with the
  threshold's re-anchoring, or accept "delay all valued outflows until
  re-anchored"? Either way the old sums are not carried over: §6 delays
  valued outflows for 25 hours after a rotation.
- **Q7. Unbound legs and unlisted assets:** give incentive and
  Diamond-transient legs a per-vault cap too (tighter against a Diamond flaw,
  but it could stall a large liquidation, #3178)? And should an ERC-20 with no
  cap entry get a default unit cap, or none (Default: none, stated)?

## 12. Residual risks

- **Wide, small drains.** Up to $1,000 per vault per 24 hours leaves undelayed;
  many keys stolen at once are caught only by the per-asset brake.
- **Brake griefing.** A large honest withdrawal can trip a 30-minute pause. The
  cooldown limits it to one window per 24 hours, the delay shows the withdrawal
  a day ahead, and every pause shifts loan deadlines (#668).
- **The tripping transaction.** Treasury and incentive outflows complete past
  the brake, bounded by their liens and budgets (#3205).
- **A vault flaw reachable without the Diamond** is not bounded by the
  Diamond's buckets (#3204's audit scope).
- **Governance compromise** loosens limits only after 48 hours plus 3 days;
  noticing in time depends on #3237.
- **A numeraire rotation** delays every valued owner outflow for 25 hours.
  This is deliberate, it is announced by the governance delay, and rotations
  should be rare.
- **No-feed assets and NFTs** are not delayed (illiquid-at-0); liens and the
  count bucket bind them.
- **Hourly steps** keep an outflow counted for at most one hour longer than an exact window would, never shorter.
- **An oracle outage** delays every valued wallet outflow: stated friction.

## 13. Tests

- **Meter:** exactly $1,000 pays; crossing it queues the whole outflow; a slot
  clears only when its hour is reused 25 hours later; an outflow at 00:59 still
  counts at 00:58 the next day; a saturated slot still delays; no-feed assets and
  NFTs count 0; a stale or distrusted price, or a numeraire mismatch, delays.
- **Releases and the reservation:** a $10,000 row released after 26 hours is
  counted at release, so a $1,000 request right after it queues; a pending row
  delays a small request; a cancel removes the row from the reservation; a
  release counts the larger of the recorded and the current Ok value.
- **Rotation:** after an undelayed $1,000 outflow, a rotation to a new
  numeraire delays a just-under-threshold outflow in the new currency, in both
  lines; 25 hours after the rotation the meter is empty under the new tag and
  that outflow pays.
- **Second line,** with a test facet calling `transferOut` directly: an
  unqueued over-threshold owner outflow reverts; an outflow beyond the vault
  bucket reverts; a facet writing arbitrary Diamond storage cannot change the
  vault's meter, queue or config.
- **First line:** a test vault version that skips its own checks is still
  refused by the Diamond's buckets.
- **Buckets and setters:** refill, and the boundary at exactly `tokens`; every
  MIN and MAX, and zero refused; a loosening applies only after
  `MIN_CONFIG_DELAY` and the Pauser Safe can cancel it; a tightening is
  immediate.
- **Brake:** crossing it pauses in the same successful transaction and holds
  the owner outflow as a row; a Diamond push to a wallet is credited to the
  recipient's vault; a liquidation and a repay complete while it trips; during
  the cooldown it holds without pausing; adapter legs do not count; a clawback
  is never counted, held or delayed.
- **Queue:** an early release reverts; a release while paused reverts except
  under escape; a release short of bucket room reverts and the row survives;
  the owner's signature, a secondary's signature and a lock (all rows) each
  cancel; an unprotected unlock waits; a protected `releaseAt` is the later of
  the two delays.
- **Exempt classes:** repay, preclose, refinance, a claim into a vault and
  liquidation proceeds are not metered; withdrawing the claimed amount to a
  wallet is.
- **Deploy-sanity:** the AST entry test, and the size of the vault
  implementation and every touched facet.
