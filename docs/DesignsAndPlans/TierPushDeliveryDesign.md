# Tier push delivery: owed per lane, never blocking the user (#898, #911, #1277)

Status: built in the PR that closes #898 and #911. Part of #1277: its
reward-batch finding (078) belongs to the reward remittance work and is
out of scope here.

This supersedes the fail-closed rule in
[`CrossChainTierPropagation.md`](CrossChainTierPropagation.md) §4 and §6
and the "fail-closed when the budget is empty" step in
[`CrossChainRewardSystem.md`](CrossChainRewardSystem.md). Everything else
in those documents still holds: Base resolves the tier, mirrors cache an
authenticated tuple, nonces are strictly increasing per user, and the
mirror's freshness gates (version, expiry, 60-day maximum age) decide
whether a cached tier is usable.

## 1. The problem

On Base, every action that changes a user's VPFI standing sends the new tier
to every mirror chain in the same transaction. That includes stake, unstake,
loan start, settlement fee paths, consolidation and `pokeMyTier`. The send
was fail-closed, so the action reverted when the send could not go out:

- **The protocol budget was short** (#898). Anyone could drain it cheaply.
  `setVPFIDiscountConsent(false)` then `pokeMyTier()`, then consent on and
  poke again, makes one protocol-funded fan-out per poke and costs the
  caller only gas (#1277 finding 004). Once the budget was empty, every
  unstake that lowered a tier reverted. That froze users' own staked VPFI
  until an operator topped up, and the attacker could drain it again
  straight away.
- **One lane failed** (#911). The messenger looped over every destination
  and one failing quote or send reverted the whole fan-out. Causes include a
  lane the CCIP router no longer supports, an unconfigured destination, or
  a paused messenger or adapter. While that lasted, every tier-changing
  stake, unstake and loan start on Base reverted for everyone.

The fail-closed rule was built on purpose. A user who saw the budget empty
could otherwise unstake and keep their old, higher tier on mirrors. That
concern is real. But it cost far more than it protected. The rule turned a
fee-discount staleness risk, capped by the discount ceiling and the 60-day
maximum age, into a freeze of users' principal that anyone could trigger.

## 2. The rule

**A user's action never fails because a tier push cannot go out.** The
canonical tier is current on Base at once. The push to each mirror lane is
**owed** until it is delivered, and it is delivered by the user's next action
that pushes, or by anyone who asks.

### 2.1 Target and lanes

- The **target** is the tuple Base last committed for the user:
  `(effectiveTier, effectiveBps, tierExpirySec, tierTableVersion)` and its
  push nonce `N`. A rollup commits a new target, with `N + 1`, only when the
  freshly resolved tuple differs from the committed one. Consent still
  forces `(0, 0)`, as before.
- A **lane** is one broadcast destination on the messenger's list. For each
  user and lane, Base records what it last delivered there: nonce, tier,
  bps, expiry, version and when it was sent.
- A lane is **owed** when its delivered nonce is below `N`. It is
  **settled without a message** when what it holds already has the same
  effect as the target. That covers two cases:
  - both carry tier 0 and bps 0, whatever their version, since a mirror
    reads tier 0 as no discount;
  - both carry the same full tuple.

  In both cases the lane's nonce is raised to `N` and nothing is sent.

### 2.2 Who pays, and when

Each owed lane is delivered on its own. A failure on one lane never stops
another.

1. **A caller who pays.** `deliverTierPush(user)` is payable and open to
   anyone. The caller's `msg.value` pays for owed lanes first, in list
   order, with no rate limit. Whatever is unspent goes back to the caller.
2. **The protocol budget.** A lane the caller's value did not cover is paid
   from `protocolBroadcastBudget` when either of these holds:
   - the target **lowers** the lane's tier or bps, or the lane has never
     received a push. A lowered tier is the protocol's own interest, so it
     goes out at once.
   - the lane's last send was at least `tierPushSpacingSec` ago. Any other
     change, such as a raised tier or a new table version, waits for the
     spacing window.
3. **Otherwise the lane stays owed.** Base emits
   `TierPushDeferred(user, destChainId, nonce, reason)`. The reason is one
   of:
   - `Spacing`: the window has not elapsed;
   - `Budget`: the budget cannot cover the fee;
   - `Quote`: the lane's quote reverted;
   - `Send`: the send reverted;
   - `Destinations`: the destination list could not be read;
   - `NoDestinations`: no lane is configured.

A deferred lane stays owed. The user's next pushing action retries it, and so
does any `deliverTierPush(user)` call. Delivery never re-resolves the tier:
it sends the committed target. A user whose tier has aged into a new value
without a balance change calls `pokeMyTier`, which resolves and commits.

### 2.3 Why the spacing window bounds the drain

The protocol budget pays at once only for a lowered tier, or for a lane's
first push. Lowering a lane twice needs a raise in between, and a raise is
paid only once per window per lane. So any one user costs the budget at most
about two sends per lane per window. A Sybil needs a separate stake for each
identity, held past the minimum-history gate before its tier is above zero.
The consent-toggle loop in #1277 is bounded by the same rule.

- **Default window:** 1 day.
- **Admin setter bounds:** 1 hour to 7 days.

A user who wants a raise on a mirror sooner pays for it with
`deliverTierPush`.

### 2.4 Gas starvation cannot buy a skipped push

A caller could try to make a push fail on purpose by giving the transaction
just enough gas for the action and not for the send. The send would then
fail inside its try block and the action would land. After every caught quote
or send failure, Base checks the gas that remains. If less than 1/63 of what
the call was given is left, the failure was the 63/64 rule, not the lane, so
the whole transaction reverts. A deliberate gas shortfall can only fail the
action. It cannot defer the push.

### 2.5 Funds

- A protocol-funded send debits the budget by the lane's quoted fee, at the
  moment it is sent.
- A caller-funded send spends the caller's value and never touches the
  budget.
- A failed send moves no value. The call reverts inside its try block, so
  the attached value comes back.
- The messenger refunds any surplus to the Diamond. Base measures what came
  back and returns it to its source: the budget, or the caller's remainder.
  The Diamond keeps no untracked native balance from a tier push.
- `ProtocolTierBroadcastSent` names the lane, the fee, and whether the caller
  or the budget paid.

## 3. What a user can rely on, and what they cannot

- Stake, unstake, loan start, settlement, consolidation and `pokeMyTier`
  never revert because of a tier push.
- Base's own discount is always current.
- A mirror's cached tier can lag Base. A **lowered** tier reaches a mirror
  as soon as the lane works and the budget can pay. Until then, anyone can
  pay to send it. A **raised** tier can wait up to one spacing window, or
  until the user pays.
- A lane that never recovers is bounded by the mirror's 60-day maximum age,
  after which its cached tier reads as tier 0.
- Whether a user has owed lanes, and why each was deferred, is public:
  `getTierPushStatus(user)` returns the target and every lane's state, and
  each deferral emits an event. A keeper can deliver owed lowered tiers and
  alert on a low budget. That pass belongs to the keeper work and is not
  part of this change.

## 4. Messenger surface

The all-lane `sendTierUpdate` / `quoteSendTierUpdate` pair is replaced by
`sendTierUpdateTo(destChainId, …)` / `quoteSendTierUpdateTo(destChainId, …)`.
Both are Diamond-only for the send, and both refuse a destination that is not
on the configured broadcast list. Nothing else on the messenger changes.
This is pre-live, so there is no compatibility shim: chains take it by fresh
deploy.

## 5. Out of scope

- A keeper pass that delivers owed lowered tiers and alerts on the budget
  (keeper work).
- Re-pushing an unchanged tier before the mirror's maximum age (#1856).
- The eager `VersionBumped` broadcast and the dormant-user sweep, which
  remain the deferred follow-ups `CrossChainTierPropagation.md` §5 names.
- #1277 finding 078 (reward batches), which is reward remittance work.
