# Intent-based swap-to-repay — Functional Specification

This document specifies the **intended** observable behaviour of the
intent-based swap-to-repay surface (T-090 v1.1, parent #389) — the
sibling to the atomic on-chain swap-to-repay surface from T-090 v1
(#403). It is **implementation-independent**: every statement is sourced
from the design exploration in `docs/DesignsAndPlans/SwapToRepayIntentBased.md`,
the release notes for the v1.1 sub-cards, and the user-facing description
in `apps/www/src/content/userguide/Advanced.en.md`. It is **not**
transcribed from the contract code.

The on-chain surface (commit, custody, ERC-1271 binding, cancel
paths, lender-protection force-cancel paths) is in its final
shape at v1.1 GA. The agent-side resolver-pickup bridge to 1inch
Fusion is wired in code but **not functionally complete**: the
bridge submits orders without a `quoteId` field that Fusion's
relayer treats as required, so Fusion is expected to reject
every submission upstream until the v1.2 follow-up (issue #431)
either threads a real quoteId through from a 1inch quote/build
round-trip, or switches the bridge to 1inch's Limit Order
Protocol relayer endpoint (which doesn't require a quoteId).

Until #431 ships, the production dapp keeps the Commit button
disabled and recommends the atomic swap-to-repay surface instead.
The intent surface's spec below describes the intended behaviour
of the surface in its production-ready end-state (#431 + later);
where alpha/half-state behaviour diverges, the spec calls it out
explicitly.

## Scope and audience

This surface is intended for borrowers who currently hold a v1.1-eligible
loan — specifically, ERC-20-on-ERC-20 loans (collateral and principal
both liquid ERC-20 assets) where the borrower is not the same wallet as
the current lender-NFT holder.

It serves as an **alternative** to the atomic on-chain swap-to-repay
surface from v1. Both surfaces coexist on the Loan Details page; the
borrower picks which to use per repayment.

## Why it exists

The atomic surface trades through Vaipakam's on-chain DEX-adapter
try-list at the moment of submission. The intent surface trades through
a **solver auction** — borrowers signal intent to swap, solvers compete
on price over a short window, and the winning solver fills the order.
The intent surface is intended to surface a slightly better
borrower-facing price when there is solver competition, at the cost of
auction-window timing variability. The atomic surface stays available
for borrowers who prefer predictable timing.

## Eligibility

A borrower may use the intent surface for a given loan only if **all**
of the following hold at the time of commit:

- The loan is in the **Active** lifecycle state.
- The loan's collateral asset and principal asset are both ERC-20.
- The loan's collateral asset and principal asset are both on the
  protocol's **liquid** classification (an oracle feed and sufficient
  on-chain liquidity exist for both).
- The protocol-level **master switch** for the intent surface is enabled
  on the chain.
- The collateral asset and the principal asset are both on the
  governance-curated **token allowlist** for the intent surface.
- The loan's current Health Factor is at or above the configured
  commit-time HF gate (default 1.2 in HF-scale units).
- The loan is not at or past the configured maturity-plus-grace window.
- The caller is the current holder of the borrower-position NFT for the
  loan.
- The loan does not already have a live intent commit.

If any of the above is not met, the commit is rejected at the surface;
no collateral is moved and no order is registered.

The lender, or whoever currently holds the lender-position NFT for the
loan, **cannot** use this surface on their own loan (same self-repay
guard as the atomic surface).

## Commit — what happens, end to end

Submitting a commit on the surface produces, in a single transaction:

1. The borrower's collateral is moved out of the borrower's personal
   vault and into the diamond's own custody for the duration of the
   intent. The accounting records the diamond as the temporary holder.
2. The protocol registers a canonical Fusion-style order, binding the
   diamond as both the maker and the receiver of the order, and binding
   the protocol's signature-checking contract as the verifier of the
   order via ERC-1271.
3. The order's hash is stored on the diamond and indexed by the loan id;
   the order's auction deadline is recorded; the borrower-supplied
   minimum output (taker amount) is recorded.
4. The protocol approves the 1inch Limit Order Protocol contract to
   pull the custodial collateral when a solver fills the order. The
   approval is **per-token aggregate**: the protocol maintains a
   running total of pending custodial amounts across all live commits
   for the same collateral token and approves the Limit Order Protocol
   for the sum. When two or more live commits share the same collateral
   token, each commit raises the aggregate; each teardown (fill,
   cancel, force-cancel) lowers it. This is intentional — it avoids
   the per-commit approval reset that would otherwise revoke a sibling
   commit's allowance.
5. A `SwapToRepayIntentCommitted` event is emitted; the activity feed
   attributes the row to the borrower address that submitted the commit.

The commit transaction reverts entirely if any of the eligibility checks
above fail at submission time, or if the borrower-supplied order fails
any of the order-shape integrity checks below.

## Order-shape integrity (commit-time)

The intent surface enforces a **rigid order shape** at commit. The
borrower-supplied order must:

- Place the diamond as the maker and the receiver.
- Place the loan's collateral asset as the maker asset and the loan's
  principal asset as the taker asset.
- Place the loan's full collateral amount as the maker amount.
- Place a taker amount at or above the protocol's **live settlement
  floor** plus the configured buffer.
- Disable partial fills and disable multiple fills (a v1.1 intent fills
  exactly once or expires).
- Carry the protocol's canonical extension bytes verbatim, with the
  diamond as the pre-interaction and post-interaction target.
- Carry an auction deadline within the protocol's configured auction
  window bounds and not exceeding the loan's maturity-plus-grace
  boundary.
- Carry a nonce that has not been used by **any** prior commit on the
  same chain — successful, cancelled, or force-cancelled. The
  protocol's nonce-used set is per-chain and **permanent**: once a
  nonce is consumed by any commit it is never released for reuse, so
  clients must vary the nonce per commit forever rather than retry an
  earlier value after a teardown. This mirrors the underlying 1inch
  LOP bit-invalidator semantic where the bit is consumed permanently.
- Not request unwrap-WETH delivery (the receiver expects ERC-20, not
  native ETH).
- Not request epoch-manager checking (incompatible with the
  bit-invalidator path the protocol's order shape requires).
- Not request Permit2-mediated transfers (the diamond approves the
  Limit Order Protocol contract directly; Permit2-flagged orders would
  route the transfer through a different authorization path the
  diamond does not authorize).

Any deviation from the above rejects the commit at submission time with
a discriminated error so the dapp can surface a precise reason.

## Live floor — commit-time vs fill-time

The protocol enforces the live settlement floor at two distinct points
with different buffer semantics.

**At commit time**, the borrower-supplied `takerAmount` must be at or
above `(principal + accrued interest + treasury and preclose fees +
late fee accrual) × (1 + configured buffer bps)`. The buffer protects
the borrower from a marginal fill that the protocol would technically
accept but that leaves no headroom against block-to-block interest
accrual between commit and fill.

**At fill time**, the protocol's post-interaction hook re-evaluates the
floor at the fill-block timestamp **without** the buffer — the raw
`lenderLeg + treasuryLeg + lateFee`. The hook reverts the fill if the
solver-delivered amount falls below the raw floor. The buffer is a
commit-time guarantee for the borrower, not a fill-time cushion for the
solver: an order whose `takerAmount` already exceeds the raw floor at
fill time fills cleanly; the buffer's job at commit was to ensure that
condition still holds after a short auction window.

## Cancel — three paths

The intent can be cancelled along three paths.

### Borrower cancel (after deadline)

After the order's auction deadline has passed, the current holder of
the borrower-position NFT can cancel the intent. The protocol:

- Refuses to cancel before the deadline (the auction is still
  legitimately running for solvers).
- Tears down the on-chain commit record + the Fusion-side order
  registration.
- Returns the custodial collateral to **the loan's original borrower's
  vault** — the address recorded on `loan.borrower` at origination,
  not necessarily the current borrower-NFT holder. The two diverge
  only when the borrower-position NFT has been transferred after the
  intent was committed; that scenario is a rare edge case but the
  cancel teardown is keyed by the original-borrower record. The
  current NFT holder is the **authorised caller** of the cancel; the
  recipient of the returned custody is the original borrower.
- Emits a `SwapToRepayIntentCancelled` event attributing the cancel to
  the caller wallet.

### Permissionless cancel (after grace)

If the borrower-position-NFT holder never calls the cancel — possibly
because the wallet is no longer reachable — anyone can call a
permissionless cancel path **after** the deadline plus the configured
cancel-grace window (default 24 hours past the deadline). The same
teardown + collateral return happens; the activity feed attributes the
cancel to the wallet that called the permissionless path. The
returned custody still flows to the loan's original borrower's vault
(same recipient as the borrower-cancel path).

The permissionless path is the protocol's **anti-stranding affordance**,
not an automatic recovery: collateral returns only when someone
actually calls the function. If no caller ever does, the commit and
the custodial collateral remain in the diamond indefinitely. The
contract pays the caller no protocol-level gas compensation — the
expectation is that the original borrower, a keeper, or any third
party watching the protocol can call the path because the on-chain
state is observable and the function is open; the call is altruistic
or self-interested (cleaning up your own commit) rather than
incentivised by an in-protocol bounty. The contract does not schedule
automatic recovery; the affordance is only as strong as the off-chain
willingness to call it.

### Force-cancel (lender protection)

If, while the intent is live:

- The loan's Health Factor drops below the liquidation threshold, OR
- The loan crosses the maturity-plus-grace boundary, OR
- A lender-protection action (HF liquidation, time default, internal
  match liquidation, partial-period auto-liquidation) needs to run,

then the protocol's relevant entry point **force-cancels** the intent
in the same transaction as the lender-protection action. The
custodial collateral is returned to the borrower's vault before the
protection action runs against the (now-restored) collateral state.

A `SwapToRepayIntentForceCancelled` event is emitted with a
reason discriminator and a source address. The reason takes one of
two values: `HFBelowLiquidationThreshold` (used by all the HF /
liquidation-path triggers, including internal-match liquidation) or
`TimeDefaultDue` (used by the maturity-plus-grace default trigger).
The source field carries the diamond's own address — these
force-cancel calls always cross the diamond boundary, so the
event-recorded source is the diamond, not the originating facet.
Activity-feed tooling can therefore distinguish the **kind** of
trigger via the reason enum, but not the originating facet identity
via the source field.

The force-cancel is intentionally not attributed to a borrower wallet
in the activity feed; the lender-protection action that drove it
carries the attribution via its own downstream event. That downstream
event depends on which trigger ran: the HF-liquidation paths emit
`LoanLiquidated`, the time-default path emits `LoanDefaulted`, and the
partial-period auto-liquidation path emits
`PeriodicInterestAutoLiquidated`. Activity-feed tooling reading the
spec as the oracle must inspect the trigger kind to know which
downstream event to join the force-cancel row to.

## Fill — solver-side path

When a solver fills the order through 1inch's Limit Order Protocol:

1. The protocol's pre-interaction hook records a baseline of the
   diamond's principal-asset balance.
2. The solver moves the custodial collateral out of the diamond and
   delivers the taker-side principal-asset amount to the diamond.
3. The protocol's post-interaction hook measures the balance delta and
   re-evaluates the live settlement floor. The hook reverts the entire
   fill if the delivered amount falls below the floor at fill-time, or
   if the makerTraits or other on-order parameters have been tampered
   with mid-flight.
4. With the floor check passing, the post-interaction hook runs the
   canonical settlement waterfall:
    - The lender's leg is **credited to the lender's vault / claim
      slot** keyed by the **current lender-of-record** stored in
      `loan.lender`. This is not necessarily the address that
      originated the loan: when a lender-side loan sale completes,
      the protocol's lender-position migration updates `loan.lender`
      to the new lender, and the intent settlement records the leg
      against that current record-of-truth. The lender-position-NFT
      holder withdraws it via the protocol's claim entry point
      (`ClaimFacet.claimAsLender`). This indirect delivery is
      identical to the atomic surface's settlement path and is
      intentional: position-NFT transferability means the "current
      NFT holder" can change between fill registration and
      withdrawal, so a pull-based claim slot is the safer
      settlement shape than a direct push.
    - The treasury's leg is delivered directly to the configured
      treasury address.
    - Any favorable-quote surplus over the floor lands in the
      borrower's wallet directly (not the vault) so it can be spent
      immediately without an extra withdraw step.
    - The loan transitions to the Repaid lifecycle state.
    - The time-weighted VPFI Loan Initiation Fee rebate is recorded
      against the borrower's claim slot to be withdrawn via the
      borrower-side claim path.
5. A `SwapToRepayIntentFilled` event is emitted; the activity feed
   attributes the row to the borrower that originated the commit (NOT
   the solver who submitted the fill transaction).

The fill is fully atomic with the loan's terminal settlement — if any
post-interaction step reverts, the entire fill reverts and the
collateral remains in diamond custody for the borrower or
permissionless-cancel paths to recover.

## Interactions with other surfaces

While an intent is live, the following lender-side or borrower-side
actions on the **same loan** are intentionally blocked or
force-cancel-the-intent-first:

- Repayment, partial repayment, swap-to-repay (atomic), preclose
  (direct), preclose (offset), refinance, add-collateral, partial
  withdrawal — all blocked with a discriminated error; the borrower
  must cancel the intent first.
- HF liquidation, time-default, internal-match liquidation — proceed,
  force-cancelling the intent first so the protection action runs
  against restored collateral state.
- Partial-period auto-liquidation (the period-shortfall path) —
  proceeds **only when HF is below the liquidation threshold**, in
  which case the intent is force-cancelled first as above. When HF is
  still healthy, the auto-liquidation path rejects with the
  `IntentPending` discriminated error instead of running; the
  borrower must cancel the intent first (after deadline) before the
  shortfall path can run, exactly like the user-callable paths above.
  This narrower behaviour mirrors the contract's choice to gate the
  shortfall path through the HF-only force-cancel helper rather than
  the unconditional one.

This is the protocol's no-double-spend invariant for collateral that is
in temporary diamond custody.

## Activity feed

The four intent-surface events are recorded with the following
attribution + severity:

- `SwapToRepayIntentCommitted` — attributed to the borrower who
  originated the commit; severity `info` (loan stays Active).
- `SwapToRepayIntentFilled` — attributed to the borrower who originated
  the commit; severity `success` (terminal Repaid).
- `SwapToRepayIntentCancelled` — attributed to the wallet that called
  cancel (distinguishes the borrower path from the permissionless
  poke); severity `info`.
- `SwapToRepayIntentForceCancelled` — **system-attributed** (no
  borrower attribution; the event's only address field is the
  diamond `source`); severity `warning` (a lender-protection action
  followed).

In the dapp's current Activity page, the wallet-participant filter
admits only events whose participants include the connected wallet —
plus a `LoanDefaulted` special-case keyed by loan id. The three
borrower-attributed events surface for the connected borrower
through the participant filter; the system-attributed force-cancel
row does **not** surface for the borrower with the current filter
shape. Extending the `LoanDefaulted` special-case to include
`SwapToRepayIntentForceCancelled` so the borrower's view shows the
row joined to the loan they recognise is tracked as a v1.2
follow-up.

The dapp surfaces an in-page **pending intent** card on Loan Details
while a commit is live. The card shows the order hash, the deadline,
and a cancel button gated on `now >= deadline`. A 1-second timer drives
the countdown so the cancel button enables itself at the deadline
without a manual page refresh.

## Agent-side resolver-pickup bridge

The dapp posts the committed order shape to the agent worker's
`POST /intent/fusion/post`. The agent injects the
`INTENT_FUSION_API_KEY` secret server-side and forwards the order to
1inch's Fusion resolver-pickup endpoint; the dapp receives the
upstream JSON response unchanged.

If the agent worker's `INTENT_FUSION_API_KEY` secret is unset
(e.g. an operator deploying before rotating the secret in), the
endpoint degrades to a queued-ack response so the dapp's resolution
path stays clean. In that operator-pre-rotation state the on-chain
commit is the source of truth and Fusion-side discovery does not
happen; rotating the secret in restores the full pipeline without a
dapp-side redeploy.

## Open follow-ups (v1.2)

