# VPFI service bonds — work-token sink (S-4 / R-3)

**Status:** design note for **legal glance → decision → build**. Card:
#1219. Umbrella: #1221. Legal frame: #694. Part of the VPFI circular-flow
programme ([`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md)).

## Objective

**The original goal** was a temporal + permanent VPFI sink shaped as a
performance bond, never a return: operators post VPFI to access higher
operational limits, and misbehaviour slashes the bond into the recycle loop.

**What survived review is narrower, and the difference is load-bearing.** Both
selectable forks are **non-slashable capacity deposits**: no misbehaviour
confiscates anything, because no slash predicate cleared the objectivity bar
(§2). What each retains:

| | temporal sink | permanent sink | slash |
| --- | --- | --- | --- |
| **(A)** | yes — deposits held while active | no | **none** |
| **(C)** | yes | yes — the arming fee | **none** |

So this document must not be read as specifying a performance bond, and the
word must not be used for what it now describes — the shape rules below make
that a hard naming requirement rather than a preference. An earlier revision of
this objective said "misbehaviour slashes the bond" while §1.4 was
simultaneously forbidding exactly that description, which is the opposite
instruction to anyone implementing or writing copy from the top of the file.

## Shape rules (the legal spine)

1. **No yield, ever.** Bonds earn nothing — not interest, not rewards, not
   fee shares. Posting a bond buys operational capacity, full stop.
2. **Refundable at will, subject to the sanctions gate** — a deposit, not a
   purchase. v1 has no unwind delay, because v1 has no evidence that arrives
   after an operator stops acting.

   **The delay attaches to ANY predicate whose proof can arrive after the
   action — not to the liveness tier specifically.** An earlier revision tied it
   to that tier, which was true when liveness was the expected next step and is
   now a slash-and-run hole: with equivocation the only viable candidate, an
   operator could sign two conflicting statements, unbond immediately, and have
   the second surface afterwards. Tying the delay to a design that may never
   ship leaves the one that might unprotected.

   **An unbond request must also STOP new predicate-governed admissions, not
   merely snapshot `unlockAt`.** Revoking privileges does not close the door
   where the predicate governs a permissionless surface — this note records that
   `matchSignedOffer` has no per-matcher authorization and `matchIntent` can
   remain open — so an operator can request unbond, **act again afterwards**
   with an evidence horizon outliving the snapshot, and withdraw before that
   proof arrives. So the request puts the bond into a state that **rejects new
   predicate-governed admissions**, or post-request calls are explicitly
   **unenrolled and non-slashable**. Either is sound; leaving it unsaid is not.
   **request → act → proof** is an acceptance case.

   So each delayed-proof predicate carries its own **evidence horizon**, and the
   delay is the maximum over the predicates governing **still-actionable actions
   taken before the request — including predicates governance has since
   disabled.**

   "Live at the unbond request" was the earlier wording and it is wrong: turning a
   predicate off stops it applying to FUTURE actions, and says nothing about
   evidence for actions already taken. An operator could otherwise act, wait for
   governance to disable that predicate for unrelated reasons, and withdraw before
   the proof resolves. Disabling a predicate cancels prior liability only if the
   design says so explicitly — and it should not, because that turns a routine
   configuration change into an amnesty. For equivocation
   that horizon is how long a conflicting statement can still be produced and
   proven — which depends on the artefacts' own validity window rather than on
   any observation commitment, and must be defined with the predicate.

   **Measure the horizon in ACTIVE BLOCKS, not wall-clock.** With a timestamp
   horizon, a chain halt lasting beyond commitment-plus-adjudication leaves the
   **first recovery block already considering the withdrawal unlocked**, while no
   proof transaction could have been included during the halt — so the operator
   orders `unbond` ahead of the equivocation proof and escapes a slash that was
   fully reserved. The kill-switch suspension rule does not cover this: it
   protects the operator's *performance*, not the *prover's* submission.

   **Blocks alone are not enough either: a PAUSE stops the prover while the
   chain keeps producing.** If a guardian or global pause makes the proof
   selector unavailable, block-counting still expires `unlockAt`, and the
   operator unbonds immediately after unpause — the same escape, arrived at
   without any halt. Measuring in blocks fixes the outage case and not this one.

   So one of: **proof submission stays pause-EXEMPT** (cleanest — the prover is a
   third party reporting on an offence, not an operator performing a service, so
   there is no containment reason to stop them), **protocol-paused blocks are
   excluded from the horizon**, or a **post-unpause grace window** during which
   proofs may land before any pending withdrawal completes.

   **And the proof and release windows must NOT overlap at the boundary.** If
   proofs are accepted *through* `unlockAt` while cleanup or withdrawal is
   permitted at `block.number >= unlockAt`, the operator front-runs the proof
   with the release and withdraws — timely evidence losing its reserved debit to
   transaction ordering, which is precisely the failure the horizon prevents
   everywhere else. Strict non-overlap: **proofs valid through block N, release
   only after N**, with **both transaction orderings tested at the boundary**.

   The first is preferred and the general rule behind it is worth stating: the
   levers that stop the OPERATOR must never also stop the PROVER, because every
   time they have been conflated in this document the result has been a slash
   escape.

   The qualifier is not a hedge and must not be dropped: the acceptance criteria
   below require `unbond` to REFUSE for a sanctioned operator, so for a flagged
   wallet the principal stays frozen until delisting — **refusing by REVERTING
   only once the flag is already persisted**. The FIRST authoritative
   observation parks instead, because a revert would roll back the very write
   that records it (see §Mechanics).

   **And for a CONFIRMED-flagged balance the check must FAIL CLOSED.**
   `LibVaipakam._assertNotSanctioned` is explicitly a no-op "when the oracle is
   unset or fails open", so requiring only that helper lets a previously
   confirmed operator withdraw during an oracle outage — breaking the freeze this
   rule promises, and invalidating the rotation reasoning above, which treats a
   flagged balance as undrainable.

   **And the successful clean release CLEARS the marker.**
   `assertNotSanctionedFailClosed` is a `view` helper — it permits or reverts and
   writes nothing — so a persistent confirmed flag would outlive the delisting
   that cleared it. The operator could then unbond, post a fresh clean balance,
   and have a later oracle outage freeze **that** balance as though it were the
   flagged one. The repository already has the pattern for this:
   `LibSanctionedLock.clearConfirmedFlag`, used at each resolution point in
   `ClaimFacet`. Acceptance case: **flag → delist → rebond → outage**, asserting
   the new balance withdraws.

   **And the FIRST observation must persist before the refusal reverts.** If an
   operator becomes sanctioned after bonding and their `unbond` attempt is the
   first call to read the authoritative flag, a plain revert rolls back the very
   write that would have recorded `sanctionsConfirmedFlagged` — so nothing
   persists. `refreshSanctionsFlag` is permissionless and **optional**, so nobody
   is guaranteed to observe it either. If the oracle then goes unavailable, that
   balance takes the never-confirmed fail-OPEN branch and withdraws, **despite
   having already been seen flagged.**

   So the flagged path is a **committed transition, not a revert**: the call
   records the confirmation and parks the withdrawal — its own state change,
   which survives — rather than reverting and losing the observation. Refusing by
   reverting is correct only where the refusal needs to record nothing.

   The primitive already exists: **`LibVaipakam.assertNotSanctionedFailClosed`**
   (#998 S10 / #1006) reverts `SanctionsOracleUnavailable()` whenever the oracle
   is unset or its call reverts. So: **record the confirmed flag, and release a
   flagged balance only through the fail-closed check**, while operators never
   confirmed flagged keep the ordinary fail-open path — an outage must not freeze
   everybody's capital, which is the reason the fail-open default exists. An earlier revision
   promised refundability unconditionally here while requiring the freeze there
   — an implementation could satisfy one only by violating the other, and the
   unconditional promise is the one that would have been quoted in copy.
3. **Slashing is rule-bound and evidence-anchored**, never discretionary
   value capture: each slash condition is an objectively verifiable
   on-chain fact — and the evidence must be **committed state, not a
   revert** (a reverted transaction leaves nothing to adjudicate; see
   "offence recording" below).
4. Marketing language depends on **whether a slash predicate is actually
   enabled**, not on which tier is deployed — and that applies to the RATIFIED
   decisions list below as much as to this rule. An earlier revision of that
   list named the attested tier itself as sufficient for "operational security
   deposit", which the authorization branch contradicts: it recovers no slash
   and leaves the principal fully refundable. "Operational security deposit" only
   where a principal can really be confiscated.

   An earlier revision said "under (B) or the attested tier", which names a
   deployment rather than a capability — and §2 establishes that the attested
   authorization branch recovers **no slash** and leaves the principal
   non-confiscatable. Copy written from the tier label would then recreate the
   exact representation problem the (A)/(C) rule below prohibits, inside the tier
   that was supposed to resolve it.
   Under **(A) OR (C)** — the principal cannot be confiscated in either,
   since C's arming fee is a separate spend and does not put the deposit at
   risk — it MUST be "operational capacity deposit": calling a
   non-slashable deposit a security or performance bond is the
   representation problem this note exists to avoid. Never staking, never
   earning, under any of them.

## Mechanics

**A deposit-on-behalf variant needs a refund owner before it is permitted.**
The acceptance criteria screen that selector for sanctions, but the bond record
is keyed by `(operator, role)` and carries no depositor interest at all — so
nothing says who owns the refundable principal. Letting the operator `unbond`
turns a third party's payment into a gift they never consented to; giving refund
rights to the payer cannot represent two contributors and can stop the operator
managing their own aggregate bond.

Neither is a detail to settle in implementation, because they are different
products. **Either an explicit consented-gift model** — the deposit is
irrevocably the operator's on arrival, stated as such at the call site, the
payer has no claim, **and the OPERATOR authorises each one, SINGLE-USE.** "Each one" is not replay
protection: an authorization implemented as an off-chain signature or a
standing approval lets a payer submit the same one repeatedly with dust
transfers until the bounded tranche set is full — the identical raise-blocking
grief, now with a signature attached. So consent is bound to **payer, operator,
role, token and exact amount**, carries the **chain and contract domain** plus
an **expiry**, and **consumes a nonce before the transfer**. Replay is an
acceptance case. Consent is not
optional garnish: a permissionless on-behalf selector lets a hostile payer drip
tiny deposits between an operator's delayed actions, creating a distinct
exposure epoch each time until the **bounded tranche set is full** — after which
the operator's own legitimate raises are refused until those horizons expire.
A griefing vector costing the attacker dust. The alternative, if a permissionless
variant is wanted, is to keep unsolicited funds **outside** the operator's
tranche, exposure and capacity state entirely until they accept them — **or tracked depositor shares**, with withdrawal
authorization and the refund recipient both bound to those shares. Until one is
chosen, the on-behalf variant does not ship; screening a selector whose
ownership semantics are undefined only makes it *safely* ambiguous.

**Bonds are a VPFI custody class, and the token-rotation lifecycle must know
about them.** `VPFITokenFacet.setVPFIToken` can rotate the live token, and its
own NatSpec requires the pause-drain-rotate procedure in
`docs/ops/VPFITokenRotationRunbook.md`, which enumerates every custody class and
drains it. A bond record holding only an `amount` cannot survive that: after a
rotation, `unbond` has no way to tell which ERC-20 supplied the principal, so it
either pays the new token (wrong asset, and a theft from the pool backing it) or
strands the old VPFI with no withdrawal path at all.

Putting the token identity in the events is not enough — events do not fund a
withdrawal. So, before bonds ship, **either**:

- **bonds join the rotation inventory** — enumerated, drained to zero, and
  read back as zero before the rotation proceeds. ⚠️ **This is an OPTIMISATION,
  never a sufficient branch on its own**, and an earlier revision offered it as
  one: draining is voluntary, so an offline or unwilling operator blocks the
  rotation indefinitely. Draining what you can is useful; relying on it is the
  hostage condition. **and**
- **the record snapshots the token** (or a token epoch) and a **dual-token
  migration withdrawal** exists, so an operator bonded in the old asset can
  still exit in it.

  **One `token` plus one `amount` per `(role, operator)` is not enough for that
  branch**, which the struct below only half-fixes. After a rotation an operator
  may hold an old-token bond and then `postBond` in the new live token:
  overwriting `token` mislabels the old principal, and adding to `amount` mixes
  two assets `unbond` cannot apportion — so the operator either withdraws the
  wrong asset or cannot withdraw at all.

  So the dual-token branch means **per-token (or per-epoch) sub-balances**, or
  **rejecting new-token deposits until the old-token balance is fully
  withdrawn**. The rejection is much simpler and pushes operators toward the
  drain the rotation wants anyway; sub-balances only earn their complexity if
  bonds must stay continuously posted across a rotation.

  ⚠️ **A retained old-token balance must NOT keep buying capacity.** The
  capacity rule derives `rate(bond)` and the 4× ceiling from an undifferentiated
  nominal amount, so a preserved old-token balance would go on granting elevated
  throughput as though it were the new asset — even when the rotation happened
  **because that asset was compromised and is now worthless**, and even when the
  replacement has different decimals. Two implementations could reasonably
  either count it or ignore it, which is its own defect.

  So: **old epochs have ZERO capacity after rotation**, full stop, unless an
  explicit conversion **actually replaces the collateral** with the new asset.

  ⚠️ **Zeroing the old epoch does not make the CURVE valid for the new token.**
  `bondAt4x` is a raw-unit threshold and — under (C) — so is the flat arming
  fee, so carrying either across a rotation into a token with different decimals
  or value is a silent mis-scaling: a threshold configured for 6 decimals grants
  **4× capacity for a negligible deposit** in an 18-decimal replacement, and the
  opposite rotation makes bonded capacity effectively unreachable.

  So rotation **atomically installs token-epoch-specific capacity and fee
  parameters before any new-token deposit or spend is enabled** — the parameters
  are per token epoch, like the capacity itself. **A differing-decimals rotation
  is an acceptance case**, because same-decimals testing cannot distinguish a
  correct implementation from one that simply carried the numbers over.
  An earlier revision offered "snapshot the capacity curve per token epoch" as
  an equal option — it is not one: distinguishing epochs records *which* rate
  applied without revoking the entitlement, so a compromised token's elevated
  rate is preserved indefinitely, which is precisely the prohibition two
  paragraphs up. Affected buckets are invalidated at rotation, and
  **rotate-then-spend is an acceptance case**. Preserving the principal is a custody
  obligation; preserving its capacity is not.

  ⚠️ **But drain-to-zero is NOT a complete branch, because draining is
  VOLUNTARY.** An operator who is offline, has lost their key, or simply
  declines to withdraw blocks the rotation indefinitely — no sanctions
  involvement required — and this design permits only an owner-authorised
  withdrawal to move principal, defining no administrative drain. So a single
  unresponsive operator holds the whole rotation hostage.

  Therefore the **token-snapshot/migration path must cover every residual
  bond**, or rotation needs an explicit **forced escrow migration that preserves
  the beneficiary**. Voluntary enumeration cannot be the only route.

  **Partitions key on a MONOTONIC ROTATION EPOCH, never the token address
  alone — and every SIGNED on-behalf authorization binds the epoch too**:
  a payer supplies the deposit call's expected-epoch argument, so an
  operator's unexpired consent signed over the token address alone can be
  replayed into a NEW epoch after A → B → A, creating tranches and
  consuming the operator's bounded state under stale consent. The
  signature covers `rotationEpoch` alongside the token.** `setVPFIToken` permits A → B → A (it rejects only a no-op
  against the currently selected token), and address-keyed sub-balances
  then conflate two distinct rotations: a retired A-partition still
  holding principal, reservations or debt shares its key with the new
  A deposits — the retired balance regains capacity, or an old liability
  watermark reaches newly posted principal, both against the
  token-epoch isolation this section requires. Every partition is keyed
  by the rotation epoch (the address is an attribute, not the key) —
  **unconditionally: the address-reuse-prohibition alternative is NOT
  equivalent and is withdrawn**. A retained A-partition holding any
  principal, reservation, or debt — a sanctions-frozen claim that
  persists until delisting being the sharpest case — would BLOCK
  governance from ever selecting A again under the prohibition,
  recreating the rotation-hostage condition the mandatory migration
  path exists to eliminate. The `ServiceCapacityDeposit` record and
  every escrow and debt partition carry the rotation epoch alongside
  `token`.

  **Rotation carries the DEBT with the balance — the per-token liability
  queue, its watermarks, and the debt-first settlement obligation migrate
  atomically with the principal.** A deferred liability adjudicated
  against old-token tranches otherwise watches its backing leave: the
  snapshot/escrow migration moves the reserved principal into beneficiary
  escrow while the debt stays in a ledger that no longer controls it, and
  the eventual release must either forgive an adjudicated offence or
  strand the escrowed withdrawal. The escrowed balance remains encumbered
  by its migrated liabilities, settled debt-first at release exactly as
  the un-migrated rule prescribes.

  **And the escrow holds the ORIGINAL asset — it does not move the principal
  "into the new token".** An earlier revision said the latter, which quietly
  assumes a conversion nobody funds: the old token may be compromised or
  worthless and the replacement differently denominated, so funding the swap
  from Diamond custody consumes assets backing other users, and an external
  swap needs an amount, pricing, slippage and failure policy this design has no
  business inventing. The operator's claim stays denominated in what they
  deposited — **token-snapshotted escrow, original asset, beneficiary
  preserved**. If governance ever wants a funded conversion, that is a
  separately specified, separately funded operation that migrates balances and
  reservations atomically — never an implicit property of rotation.

  The acceptance case is **branch-specific**, and an earlier revision required
  one sequence of both branches: for **per-token sub-balances**,
  `rotate → raise → unbond` must succeed with each principal exiting in its own
  asset; for the **rejection branch**, the same sequence asserts the raise
  REVERTS while the old balance stands, and `unbond-old → raise-new` then
  succeeds. Requiring the first sequence universally made the explicitly
  permitted rejection implementation fail its own acceptance test — a
  conforming build failing a test that asserts the other branch's behaviour.

  ⚠️ **A SANCTIONED operator's balance cannot be drained at all**, which makes
  the drain-to-zero branch conditionally impossible rather than merely
  inconvenient. The mandatory sanctions gate reverts their `unbond`, so the
  runbook's zero-exposure precondition can never be satisfied and the rotation
  blocks **indefinitely** — worst precisely when rotation is urgent because the
  old token is compromised, since the frozen balance is then denominated in the
  broken asset.

  So: **the token-snapshotted branch becomes MANDATORY whenever any frozen
  balance exists** — a sanctions-preserving escrow that keeps the frozen
  principal **in the ORIGINAL asset**, frozen and claimable only on delisting.
  This alternative said "into the new token" for one round longer than the
  forced-migration rule above it, and it is wrong here for the same reason plus
  one: the unfunded conversion rejected there, applied to a balance that is
  frozen precisely when the old asset is compromised — so the conversion would
  be least fundable exactly when this branch fires. Original asset,
  token-snapshotted, conversion only ever a separately specified and separately
  funded operation. Either way the rotation must not be gated on an operation
  the sanctions gate forbids.

**The snapshot/escrow migration is MANDATORY**, not the second of two options.
An earlier revision called draining "simpler" and preferred it, which lets an
implementation ship without the residual path and keep the exact hostage
condition the correction removes. Drain what drains — it shrinks the residual —
then migrate whatever is left. Only the migration can be relied on, because only
it requires nothing of the operator.

```
ServiceCapacityDeposit { operator; role; token; rotationEpoch; amount;
                         state; unlockAt; parkedRequest; eligibleAmount; }
// `rotationEpoch`: the monotonic rotation epoch this partition belongs to —
// the KEY, with `token` the attribute (A -> B -> A creates two distinct
// epochs for one address; a schema without this field lets retired
// principal or liabilities contaminate the new partition).
// `eligibleAmount`: the persisted ELIGIBLE (armed) balance fork C's rules
// read — capacity curve inputs, reservation cap, involuntary-debit sizing,
// withdrawal ordering all consult it, and a schema without it lets an
// implementation silently activate excess or charge the wrong fee. Under A
// (no fee-free excess), eligibleAmount == amount.
// `parkedRequest`: the outstanding parked-withdrawal amount — the CAP the
// sanctions section requires to persist. `amount` is principal and `state`
// alone cannot distinguish park-10-of-100 from park-all; the delisting
// release pays min(parkedRequest, payable), DECREMENTS `parkedRequest` by
// what it paid — and a PERMANENT debit CLAMPS the cap to the POST-DEBIT PRINCIPAL —
// `parkedRequest = min(parkedRequest, principal)` — never a blind
// pro-tanto subtraction, and never a clamp against the instantaneous
// unreserved amount: subtraction cancelled requests whose backing
// survived, while netting live reservations into the clamp PERMANENTLY
// forfeits amounts that are merely temporarily behind a reservation
// (principal 100, reserved 60, parked 80, debit 10 — the request must
// stay 80, since 90 becomes payable when the reservation expires; the
// unreserved-net clamp cut it to 30 forever). Temporary unavailability
// is the release-time min(parkedRequest, payable)'s job; the clamp only
// enforces that a request never outlives the principal that backs it.
OffenceRecorded(operator, role, kind, refId)   // role, not just operator
// NAMING IS NORMATIVE for every PUBLIC identifier — struct, selectors,
// events, errors, user-facing copy: capacity-deposit naming, never "bond".
// This document's own shape rules make avoiding that word a hard requirement
// (a non-confiscatable principal described as a bond is the prohibited
// characterization, handed to every integrator through the ABI), yet this
// schema said `ServiceBond` for fifty rounds. Mapping, so the review history
// stays readable: struct `ServiceBond` -> `ServiceCapacityDeposit`;
// `postBond` -> `postCapacityDeposit`; `unbond` -> `withdrawCapacityDeposit`;
// lifecycle events named `CapacityDeposit{Posted,Raised,Withdrawn,Parked}`.
// The PROSE of this document keeps the shorthand ("bond", `unbond`) purely as
// review-history continuity — shorthand is not part of the ABI, and an
// implementer takes identifiers from THIS block. `RecycleSource.ServiceBondSlash`
// alone keeps its name: it is an already-merged enum member in LibVpfiRecycle
// (append-only, reserved, MUST stay unused in v1), and renaming a merged enum
// member to launder a word out of an internal slot is churn without a user.
// v1: `state` is `Active` or `SanctionsParked` — nothing else — and
// `unlockAt` is unused. When the delayed-unbond machinery DOES arm,
// `unlockAt` is a CACHE, never the state: release is computed at claim
// time as the max over the withdrawal's outstanding actions' horizons,
// each read under ITS verifier's pausable clock. A scalar snapshotted at
// request time cannot represent independently paused verifiers — pause
// V1 after the snapshot and the stored deadline releases the principal
// V1's still-valid proof should hold; extend the scalar instead and an
// unrelated quarantine freezes V2-backed principal and every other
// withdrawal with it. The outstanding-action set carries an explicit COUNT
// cap per (operator, role) — with INVALIDATED epochs' actions excluded
// AT READ TIME (the count consults the same tri-state the value reads
// consult, or an O(1) per-epoch counter joined by generation): a stored
// scalar decremented only by lazy cleanup keeps refusing new admissions
// after an invalidation that promised immediate capacity restoration,
// and cleanup may never run. And the PHYSICAL set is bounded too, not
// just the effective count: records live in PER-EPOCH sub-lists and
// invalidation unlinks the epoch's list from the claim-time iterable in
// O(1) — filtering invalidated records at read time while they stay in
// one flat list lets fill-to-cap/invalidate cycles grow the traversal
// without bound, and the claim-time maximum walks it back over the gas
// limit with the effective count never exceeding its cap. NATURAL
// EXPIRY is bounded the same way: an admission that uses capacity freed
// by an expired action UNLINKS that expired record in the same act (the
// admission pays the O(1) cleanup), so expire-and-replace cycles inside
// one long-lived valid epoch cannot grow the list past the cap either — the ratio cap alone does not bound it: at a
// 50% cap and 1% rate an operator can raise ~2% and admit another action
// indefinitely, every admission satisfying the ratio, until the
// claim-time scan over thousands of records exceeds the gas limit and
// strands the principal behind its own protection. Admission past the
// count cap is refused; the claim-time max is then a bounded read. `SanctionsParked` is REQUIRED in v1, not predicate
// machinery: the committed first-flag transition (park the withdrawal,
// persist the confirmation, refuse the payout without reverting) must
// PERSIST something, and an Active-only schema forces the implementation to
// choose between reverting (rolling back the confirmed flag — the
// later-oracle-outage escape the sanctions section exists to prevent) and
// holding a parked amount no state represents, ambiguous to every release
// path. The parked record persists the REQUESTED AMOUNT alongside the
// state — withdrawals may REDUCE rather than close a deposit (the raise/
// reduce lifecycle), so a 10-of-100 first-flag park with no stored figure
// leaves the delisting release unable to tell pay-10-retain-90 from
// pay-all; an emitted delta is not contract state. The persisted figure
// is a CAP, not a promise: a delayed proof accepted BEFORE the park may
// debit the deposit while it sits parked, and paying "exactly" the
// stored figure is then insolvent or permanently reverting. Release pays
// min(persisted request, what the deposit still holds net of debits and
// reservations) — the park queues a withdrawal, it does not escrow one.
// Its release transition is delisting: an authoritative clean read
// re-screens and pays that capped figure through the normal withdrawal
// path.
// `unlockAt` and the remaining states exist for the
// DELAYED-UNBOND machinery that any delayed-proof predicate requires, NOT for
// the liveness tier specifically. An earlier revision said "the liveness
// tier's delayed unbond"; if equivocation ships without liveness, an
// implementer following that could permit immediate withdrawal after
// conflicting statements are signed — the slash-and-run hole rule 2 now
// prohibits. Revocation and `unlockAt` attach to the predicate, not the tier.
```

**Events — every bond lifecycle mutation, not just the offence.** This section
defined only `OffenceRecorded`, which leaves an implementation compliant with
the design and unusable in practice: `(role, address)` bond mappings are not
enumerable, so with no deposit event the app and indexer cannot discover a bond
exists or reconstruct its balance, and an operator cannot enumerate their
old-token liabilities during the VPFI rotation procedure. It also conflicts with
the repository requirement that detailed events are emitted for each relevant
state change (`docs/FunctionalSpecs/ProjectDetailsREADME.md` §Event Emission).

Required: posting, raising, withdrawal request, withdrawal completion, the
slash itself, **and the RESERVATION lifecycle — created, consumed, released.**

The reservation events are easy to omit because **the bond amount does not
change** when one is taken or freed, so none of the balance-bearing events
exposes the mutation at all. Yet reservations decide whether a later action is
admitted, and the bond mapping is not enumerable — so without them an indexer
cannot reconstruct available backing, and an operator cannot tell when their
capacity became usable again. Each carries the action and config epoch, the
tranche allocation, and the **post-reserved total**.

**Eligible-balance mutations are exposed on every event that causes
them, for the same reason.** Under C, arming previously deposited excess
changes the persisted eligible balance while the deposit balance stands
still — principal delta and post-balance alone leave indexers unable to
reconstruct actual capacity or interpret an excess-first withdrawal. So
arming, deposit, withdrawal, and every involuntary-debit event carries
the **eligible delta and the post-eligible balance** alongside the
principal fields.

**Deferred synchronous liabilities get the same lifecycle treatment, for
the same reason — and the liability-created event extends to DELAYED
adjudications, emitted in the committed adjudication transaction.** The
adjudication consumes the reservation (lowering the indexed reserved
total) while the debit event is still in the future — between the two,
an indexer reading only `OffenceRecorded` (no amount, no allocation)
reports the backing as available while the contract holds it encumbered.
The event carries the converted amount, the reservation's tranche
allocation, the token epoch, and the post-outstanding encumbrance
total.** Creating a clamped-debit shortfall changes what the
deposit is economically worth and what a future release will confiscate —
while moving neither the balance nor the reserved total, the exact
invisible-mutation shape the reservation events exist for. So:
liability-created, liability-collected, and liability-extinguished events,
each carrying the partition (collateral-token epoch), the recorded tranche
reach, the amount, and the **post-outstanding liability total** — without
which an indexer cannot reconstruct withdrawable backing and a release-time
debit arrives unexplained by the mandated event stream.

**Three EPOCH-LEVEL events are explicit EXCEPTIONS to the field list below:
QUARANTINE, RESTORE and INVALIDATE.** An earlier revision excepted only
invalidation — but quarantine and restoration also change proof eligibility and
the evidence-horizon clock in O(1) across many operators, so requiring per-bond
fields on them forces one event per reservation, which defeats the bounded
incident path the quarantine exists to provide. Emitting nothing instead leaves
indexers and **provers** unable to tell that horizons paused or resumed — and a
prover who cannot tell is a prover who misses a window.

**Quarantine and restoration events carry the VERIFIER identity, the
MISMATCH KIND (code vs config) and — for a config fault — the CAUSAL
config epoch** (the containment flag is verifier-wide either way, but
governance must invalidate the faulted epoch and restore the sound
siblings, and a consumer shown only the verifier cannot tell an
E2-only config fault from a verifier-wide code fault), plus the
observation block **and the RESTORED active-clock value — the
checkpoint the rollback rewound to**: a mismatch observed at 201 that
restores the clock to 140 extends every dependent proof and release
horizon by the difference, and a consumer shown only 201 cannot
reconstruct the window the rollback exists to give provers back); the per-epoch schema written here earlier could not represent the
one-write verifier quarantine at all — one epoch's event leaves indexers and
provers unaware that sibling horizons paused, and one event per dependent
epoch is the unbounded enumeration the O(1) incident path exists to avoid.
Consumers derive the affected epoch set from the epoch-creation events they
already index (each names its verifier), so horizons are read as paused from
a verifier's quarantine and resumed from its restore; **the per-epoch
invalidation event keeps epoch identity**, because invalidation genuinely is
an epoch-state transition.

**The epoch-invalidation event is an explicit EXCEPTION to the field list
below.** It is deliberately O(1) and covers reservations belonging to many
operators, so it cannot truthfully carry an operator, role, delta or
post-balance — and emitting one per affected operator would require exactly the
unbounded iteration the emergency path forbids, which could prevent the
invalidation itself. Its schema is the **invalidated epoch** (plus the
predicate it belonged to and the block), and an indexer reads it as "stop
counting every tracked reservation for this epoch". The per-reservation release
events arrive later from cleanup and do carry the per-bond fields.

Every OTHER event carries the operator, the role, the delta, the
**post-balance**, the token/config identity, and the withdrawal state. Post-
balance rather than delta alone, because a consumer that missed one event can
otherwise never resynchronise against a mapping it cannot enumerate.

**Epoch-creation and configuration events are the third exemption, with
their own schema.** The verifier-wide quarantine relies on consumers
learning the verifier-to-epoch relationship from the epoch-creation event —
but a global configuration act has no truthful operator, role, delta,
post-balance or withdrawal state to carry, so the blanket rule either forces
fabricated values or makes the discovery event nonconforming. Their schema
is configuration-shaped: the **config/predicate epoch id, the verifier
identity, the predicate, the parameter/cost-schedule hash, and the block** —
everything a consumer needs to bind epochs to verifiers (and later to read
a verifier-keyed quarantine as covering them), nothing invented.

**`OffenceRecorded` is the second explicit exemption, and its companion
carries the money.** The offence record is the ADJUDICATION fact — operator,
role, kind, refId — and at recording time under a delayed predicate there may
be no balance mutation in the same call at all. Requiring the balance fields
on it left two incompatible normative ABIs for one event. The mutation is
reported in TWO stages per the durable-adjudication rule: the
**liability-created event at committed adjudication** (amount, tranche
allocation, token epoch, post-encumbrance total **AND the post-reserved
total — the adjudication consumes the reservation and creates the
liability in one act, so one event carries BOTH mutations**; without
the reserved figure, an indexer following the reservation-lifecycle
mandate counts the consumed reservation and its replacement liability
at once), then `CapacityDepositDebited` at settlement, which carries
the full mandatory field set and joins by **AGGREGATE id** — the
adjudication/liability-created event carries both the offence `refId`
and the aggregate id it coalesced into, so a settlement of coalesced
liabilities names the aggregate alone (a singular offence `refId` there
would force an arbitrary constituent or per-offence settlement records,
rebuilding the iteration the aggregate removed). Three
facts, three events, one join key — v1 emits none, since v1 has no
offences. (An earlier revision said "two facts, two events", which let
an implementation skip the adjudication-time event and leave indexers
blind between adjudication and settlement.) ABI and
indexer wiring ship with them, with focused tests; a lifecycle event nobody
decodes is the same gap one step later.

| Role | What the bond unlocks | Slash conditions (objective) |
| --- | --- | --- |
| Solver / matcher | larger match-batch sizes ONLY. **Priority-window access is NOT a bond entitlement** — it is E-2's spend-gated perk with its own flat VPFI fee, and bonds neither gate it nor grant it. An earlier revision listed it here, which would let an implementation either require a bond ON TOP of the E-2 purchase or hand priority out for bonding alone; both change the perk's gate and its permanent absorption. Bond buys capacity; spend buys priority; the two never substitute | ⚠️ **NO slash predicate in any shipped tier.** Precondition lies are knowledge-based, and §2 establishes that neither attested branch recovers a slash for those — so routing them through the offence dispatcher would confiscate an honest matcher's principal after intervening state changes, the defect that removed the predicate in the first place. Any future slashing here waits on a separately specified **knowledge-free** predicate (equivocation). **v1 has no matcher slash predicate at all** (see the offence-recording bullet and the fork). The surviving in-call contradictions should REVERT rather than record an offence, so an implementation must not build a v1 slash path from this row. (An earlier revision's trailing clause still instructed an immediate fixed-bps debit per recorded offence — machinery for a future predicate-enabled tier, mis-attached to a row that states there is no predicate. The debit mechanics live with the tranche/reservation rules and apply only when a knowledge-free predicate exists.) |
| Keeper (opt-in roles) | higher per-pass action counts for granted `KEEPER_ACTION_*` roles. **A liveness commitment must be suspended, cancelled or extended — without an offence — whenever the protocol itself blocks performance**: a guardian pause, a role kill switch or a selector-level switch makes the required call revert while the commitment's clock keeps running, so every enrolled operator with a live window misses it and is slashed *for the protocol's own incident*. That is objectively detectable (the switch state is on-chain), so it belongs in the predicate rather than in an operator's appeal. A pause spanning a deadline is the acceptance case, and missing-liveness must not be admitted as a slash predicate until it passes | ~~repeated out-of-grant-scope attempts~~ — **LEAVES v1 for the same reason staleness did**: `setKeeperActions` / `revokeKeeper` can remove a grant after a keeper broadcasts an authorized call but before it executes, so an honest pending action is out-of-scope at execution, and worse with several queued. Grant state is not carried by the submission. **Does NOT return with the attested tier either** — §2 establishes that grant scope has no slashable form in either attested branch, so an implementation following an earlier "returns with the attested tier" note would slash an honest keeper whose grant was revoked after broadcast. Any future slashing here waits on a separately specified knowledge-free predicate (liveness or equivocation), not on the tier arriving |

- ~~**Offence recording (Codex round-1 finding):**~~ **REJECTED FOR v1 — retained
  as historical reasoning only, and must not be built.** Under either selectable
  fork the principal is non-confiscatable, and §2 concludes that the surviving
  in-call contradictions should **REVERT** rather than record an offence: v1 has
  no failure to record, so a dispatcher that succeeds as a no-op and immediately
  debits the bond would be exactly the v1 slash path the fork rules out. The
  argument below is correct for a tier that HAS a predicate, and is kept for
  whenever one is specified.

  The original reasoning: a slashable failure must
  not be a plain revert — a reverted tx leaves no state to slash against.
  Bonded-operator entry points therefore run precondition checks in a
  non-reverting outer dispatcher: on a precondition lie (e.g. a submission whose
  own arguments or effects contradict a precondition it asserted — NOT a
  stale-listing fill, which left v1's predicates; see below), the call
  **succeeds as a no-op**, records `OffenceRecorded(operator, role, kind,
  refId)`, and debits that `(role, address)` bond IMMEDIATELY — the threshold
  is one (see the decisions below). The counter is keyed by role too, and
  survives only as a lifetime tally for observability; nothing reads it to
  decide a slash. An earlier revision of this bullet described a
  per-OPERATOR counter driving a deferred threshold slash, which left an
  implementation with no role to select the bond from and no reason to debit
  on the spot. ~~Honest failures are excluded by a SUBMITTED-AGAINST
  SNAPSHOT.~~ **REJECTED — do not implement this.** It survives here only
  because the WAY it fails is the argument for everything below it. An
  earlier revision exempted only same-block changes and required the
  predicate to reference state committed before the operator's submission;
  that does not hold: a transaction can sit
  pending while the disqualifying state commits in an EARLIER block than its
  execution, so at execution the predicate sees state that preceded the call
  even though the operator could not have known it when signing. Ordinary
  congestion or builder ordering would then turn an honest fill into a
  recorded offence and slash a good bond — the worst failure this design can
  have, because it punishes the operators it exists to attract.

  A caller-supplied snapshot does NOT fix this, and that was the previous
  attempt: if the submission carries the state version it claims to have
  validated against, a dishonest operator simply attaches a version from
  immediately before the mutation it already knows about. Nothing
  authenticates when a snapshot was observed, so every staleness slash
  becomes evadable while honest congested calls stay exposed to whatever the
  rule does not exempt.

  **So STALENESS LEAVES the v1 slash predicates entirely** — it fails v1's
  own bar rather than needing a better mechanism. v1 is *objective lies
  only*: a fact the chain can check without judging what the operator knew.
  A stale fill is only a lie if the operator KNEW the listing was stale, and
  knowing is exactly what the chain cannot see — not through timing, which
  builders control, and not through a self-declared snapshot, which the liar
  picks. Both attempts failed in opposite directions, and that is the
  signature of a predicate that is not objective.

  **AND THAT LEAVES v1 WITH NO SLASHABLE PREDICATE — which is the finding,
  not a gap to fill.** Apply the same test to the other v1 candidate and it
  fails too: a keeper's out-of-grant-scope call can be produced by a
  revocation landing between broadcast and execution, and grant state is not
  carried by the submission either.

  What survives the test is only a submission whose OWN arguments contradict
  a precondition it asserted — and such a call should simply REVERT. The
  offence dispatcher exists for failures that must commit because reverting
  would cost the protocol something; an internally inconsistent call costs
  nothing to reject. So the class that is objective, in-call, AND must not
  revert is empty for v1.

  Three predicate attempts have now collapsed under review, in three
  different directions. That is evidence about the problem rather than about
  the attempts: slashing needs an adjudicable notion of what the operator
  knew, and v1 deliberately has no attestation to supply one. ⚠️ **Staleness
  and grant scope do NOT "return with the attested tier"** — an earlier revision
  of this sentence said they did, and the analysis immediately below refutes it:
  attestation cannot prove knowledge acquired after issuance, so neither
  attested branch makes them slashable. Following the old sentence revives the
  rejected path and confiscates an honest operator's principal after intervening
  state changes. What the attested tier may do with them is **non-punitive** —
  authorize, or revert — never debit. Liveness has its own separate problems
  below.

  **But an expiry-bounded protocol commitment does NOT make "knew" decidable,
  and an earlier revision of this bullet claimed it did.** A protocol-issued
  snapshot authenticates what the operator observed *at issuance*. It says
  nothing about what they learned afterwards. An operator can take a
  live-listing commitment, watch the listing cancel one second later, and
  knowingly submit while the commitment is still unexpired — and the chain sees
  evidence identical to an honest operator who never saw the cancellation. The
  window narrows the gap; it does not close it, and a predicate that is only
  probabilistically right is not an objective one.

  So the attested tier has its own fork, and it should be recorded here rather
  than discovered during its design:

  1. **Make the commitment an AUTHORIZATION rather than evidence** — a temporary
     protocol grant whose use stays valid despite intervening state changes. The
     operator is then never lying about the world; they are exercising a
     permission the protocol issued. Nothing needs to be adjudicated, because
     nothing is being alleged.

     **This collides with cancellation, and the collision has to be resolved
     before the option is viable.** "Valid despite intervening state" includes a
     creator's cancellation: `OfferCancelFacet.cancelOffer` releases the locked
     principal or collateral (`:117-124`), and standing-intent capital is
     likewise withdrawable after cancellation (`LenderIntentFacet.sol:370-394`).
     So an implementation faces three choices and all three are bad as stated —
     override a completed cancellation, try to spend assets already returned, or
     reject the authorized use and break the option's own guarantee.

     The only coherent readings are: **issuance RESERVES the exact assets until
     the authorization expires** (cancellation then cannot release them, and the
     creator's capital is locked for the window — a real cost to them), **or
     cancellation REVOKES outstanding authorizations** (which re-admits
     intervening state and so re-opens the knowledge question this option exists
     to close). Neither is free, and the choice belongs to whoever designs the
     attested tier — but the option must not be presented as viable until one is
     taken.
  2. **Keep knowledge-based predicates out of the slash tier entirely** — accept
     that staleness and grant scope revert rather than slash, permanently.

  **Neither option recovers a slash, and an earlier revision claimed option 1
  did.** That claim contradicted option 1's own definition one paragraph
  above it: if every use inside the window is valid despite intervening state,
  and nothing is being alleged, then there is no offence to slash for. What
  remains is a missing or expired authorization — an objective in-call
  precondition failure, which this document already says should REVERT rather
  than record an offence. A revert is not a slash.

  So the honest statement is stronger and worse than the one it replaces:
  **staleness and grant scope have no slashable form in either branch of the
  attested tier.** Option 1 makes them safe by construction, which is a good
  outcome and not a punitive one; option 2 admits the same thing without the
  mechanism.

  **This is the main fork one level down**: five predicate attempts have now
  collapsed, and every one of them collapsed on the same question. Recovering a
  slash for the attested tier requires a predicate that does not depend on what
  the operator KNEW at all — a strict liveness obligation or an equivocation
  (two conflicting signed statements), where the offence is visible in the
  artifacts themselves. Anything else keeps landing here.

  Consequently, **any later statement that option B "completes the performance
  security objective" is withdrawn**: B completes it only if such a
  knowledge-free predicate is found, and none has been.
- Bond sizes: governance-bounded config. **NOT unlock tiers** — capacity
  rises CONTINUOUSLY with the bond and nothing is unlocked at a threshold.
  This bullet said "unlock tiers" until rev 7, and an implementation
  following it would assign no incremental capacity below a tier boundary,
  reintroducing both a threshold and the implicit minimum the continuous
  curve exists to remove.
- **Unbond delay** — NOT in v1 (rev 4). It exists to stop a slash-and-run
  inside a misbehaviour window, and v1 has no such window **because it has no
  delayed evidence at all** — both selectable forks are non-confiscatable, so
  there is nothing to record and nothing to debit. An earlier revision said
  "every offence is debited in the same call that records it", which explains
  v1's shape by attributing a debiting mechanism to it; same-call debiting
  belongs to a future predicate-enabled tier. The delay, and the privilege
  revocation and retune-pinned claim-time horizon rule that make it sound
  (`unlockAt` being only the non-authoritative cache — see the schema),
  arrive with **the first
  predicate whose proof can land after the action** — whichever that turns out to
  be. Not with the liveness tier specifically: equivocation is now the only
  viable candidate, so binding the machinery to a tier that may never ship would
  leave the one that might entirely unprotected.
- Slashed VPFI → treasury **recycle bucket** through the programme's single
  chokepoint, `LibVpfiRecycle.credit(RecycleSource.ServiceBondSlash, …)`.

  ⚠️ **An OLD-TOKEN slash cannot take that path.** If the dual-token branch
  retains an old-token tranche across a rotation and a delayed proof later
  slashes it, `LibVpfiRecycle.credit` checks the balance of the **new live**
  `s.vpfiToken` and increments a single scalar `recycleBucket` — so the slash
  either reverts for lack of new-token backing, or labels unrelated new tokens as
  recycled while the confiscated old asset stays stranded. Both outcomes are
  worse than not slashing at all.

  So either **per-token recycle accounting**, or — much simpler, and consistent
  with the rotation section — **old-token slash exposure is CARRIED, not waited out.** An earlier revision
  required all such exposure to resolve before rotation — which a long-horizon
  delayed action, or a horizon whose active-block clock stalls during a chain
  halt, turns back into the stuck rotation the mandatory residual migration
  exists to remove. Worst when the old token is the compromised one, which is
  when rotation is urgent.

  So rotation **preserves outstanding old-token reservations** and accounts for
  any later debit **per token**, rather than waiting for every proof to expire.
  The recycle-credit problem that motivated the original rule is then handled
  where it actually lives — a slash resolving against an old-token tranche
  credits per-token, or is settled out of band — not by blocking the rotation. That makes it one more item on the rotation's drain inventory
  rather than a new accounting dimension.
  That enum member is ALREADY reserved and must be used rather than a new
  generic one — appending a duplicate would split service-bond absorption
  from the metrics class reserved for it. (This bullet said
  `VpfiRecycled(SLASH,...)`; there is no such source.)
  joining the netting loop; never burned, never redistributed to a
  "reporter" (bounty-shaped payouts reintroduce the promotional-
  distribution pattern #694 flags — slashing benefits the program, not an
  informant).
- Escrow separation: bonds are a fourth tracked balance class alongside
  user LIF custody, unclaimed budgets, and the recycle bucket; the
  Diamond-balance invariant extends to cover it (the #892/L13 commingling
  discipline).
- Permissionless baseline preserved: **no role requires a bond** — bonds
  raise limits above the free tier; they must never become an entry
  barrier (that would gate permissionless matching/keeping, contradicting
  the §5a competitive-matching intent).

## What was considered and rejected

- **Bond yield / fee-share to bonded operators** — the staking-as-a-service
  shape; rejected outright.
- **Slash bounties to reporters** — promotional-distribution risk;
  rejected. Detection is protocol-verifiable, needing no informant market.
- **Mandatory bonds for all matchers** — breaks permissionlessness;
  rejected.

## Decisions (owner, 2026-08-31)

1. **Slash conditions v1 = OBJECTIVE LIES ONLY.** Ratified. The liveness
   tier is a later opt-in and is out of v1 scope — so v1 ships no clock-based
   slash, and an operator who simply goes quiet is never slashed. That keeps
   every v1 slash anchored to a fact the chain can check without a timing
   judgement. ⚠️ **Superseded in effect:** objective-lies-only collapsed to NO
   predicate at all (§2), so **v1 ships no slash of any kind** — the ratified
   scope stands, and what it scopes turned out to be empty. The dispatcher
   reference here describes machinery for a predicate-enabled tier, not v1.
2. **Unbond delay: RATIFIED — v1 has NONE.** Rev 4 removed it rather than
   sizing it, because v1 has no evidence arriving after an operator stops
   acting; the reasoning is below. Immediate withdrawal and the
   clamp-on-decrease were decided together and are both invariants, not
   recommendations — **with one qualification the mechanism requires**: a
   capacity or curve retune either settles elapsed credit under the old capacity
   **or** invalidates the affected buckets and forfeits their pre-retune credit.
   An earlier revision of this decision demanded settlement unconditionally,
   which the conservative branch §3 permits cannot satisfy, so a conforming
   implementation would violate the decision. Never silently re-credited under
   the new capacity is the part that is absolute.

   A delay arrives with **the first delayed-proof predicate**, not with the
   liveness tier — see rule 2.
   **Bond sizes are DEFERRED TO IMPLEMENTATION**, not a proposal awaiting
   ratification: §3 defers `bondAt4x` and `refillWindow` until the
   implementation pass defines their units and envelope. The owner-facing list
   asks for the A/C fork and, under C, the fee parameters — those are the open
   decisions; an earlier revision pointed here at "two open numbers at the end",
   which made an undefined capacity number look ready to ratify.
3. **No-yield refundable-deposit shape: RATIFIED.** The legal glance is
   discharged. Bonds earn nothing, are refundable at will subject to the
   any unbond delay in force. NAMING IS CONDITIONAL on the fork below and
   this paragraph must not be read as ratifying one term: "operational
   security deposit" only where **a slash predicate is actually ENABLED** — not
   under the attested tier as such, whose authorization branch recovers no slash
   and leaves the principal fully refundable (§2). An earlier revision of this
   decision keyed the name to the tier, which rule 4 prohibits. Under (A) and (C) the principal
   is never at risk, so it is an "operational capacity deposit" — and C's
   separate arming fee does not change that, since a fee purchased
   alongside a deposit does not make the DEPOSIT security. Never
   staking, never earning.

### Proposed: bond sizes and capacity (rev 4)

This section has been through four revisions, and the shape of that history
is itself the finding: revs 1-3 each added a parameter to make the previous
parameter safe. Rev 4 stops extending and removes two mechanisms v1 does not
need — the unbond delay, and the fixed epoch — which answers five review
findings by deletion rather than by specification.

**1. The debit formula — every recorded offence creates its LIABILITY
immediately, against the OFFENDING ROLE's bond** (the DEBIT settles per
the durable-adjudication rule — "debits immediately" was the pre-split
wording, and an immediate debit sharing the observation's transaction
rolls the adjudication back whenever the recycle-backing check or an
old-token leg reverts, ageing the offence out).**

Rev 1 said "slash at a counter threshold" AND "10% per offence, ten offences
to zero", which are not the same rule: for any threshold above one it is
undefined whether the earlier offences debit, whether crossing the threshold
takes 10% once or the accumulated total, and what the counter does afterwards.

**The threshold is ONE.** Each `OffenceRecorded` creates a liability of
`slashBps` against the `(role, address)` bond whose entry point recorded
the offence — settled into the recycle bucket per the
durable-adjudication rule, never debited in the recording transaction
(a reverting recycle-backing check or old-token leg would roll the
record back with it) — **and the base depends on when the offence is recorded:**

- **Synchronous recording (a future predicate-enabled tier, NOT v1):** the
  FIGURE is `slashBps` of the action's **collateral-token-epoch partition's
  ELIGIBLE (armed) balance, NET of that partition's outstanding collectible
  liabilities** — never the whole partition, which under C includes
  fee-free excess that secured nothing: a partition-sized 25% of a
  100-armed/900-excess deposit is 250, and even with collection confined
  to eligible tranches the 150-unit uncollectable tail distorts liability
  totals and every later offence base computed net of them; the immediate
  DEBIT clamps to the partition's unreserved portion; and any shortfall is
  recorded as a **deferred liability against that partition, collected at
  reservation release within it** — a released amount pays the partition's
  outstanding sync liabilities (oldest first) before returning to the
  operator's unreserved backing. Two qualifiers, each closing a hole the
  bare TOTAL-base rule left:

  - **Partitioned, because the totals rule already is.** Rotation leaves
    old-token reservations beside new-token balance, and a cross-partition
    figure or collection mixes incomparable units — a new-token offence
    confiscating old-token principal, or the reverse, through decimals
    alone. The figure, the debit, and the liability all live in the
    partition of the token the offending action was admitted under, exactly
    as the reservation accounting already requires.
  - **Net of outstanding liabilities, because a promise is spending.** On a
    gross base, an operator at zero unreserved keeps generating
    `slashBps × gross` per offence — liabilities that can sum past all
    reserved principal, forcing either forgiveness or confiscation of
    top-ups never held for those offences. On the net base the arithmetic
    is geometric across offences and the total outstanding can never
    exceed the partition's collateral at recording time; a liability never
    reaches deposits made AFTER the offence (the action-time-reach rule,
    applied to debts); and a fully-encumbered operator's next offence
    records zero BY ARITHMETIC — every unit is already promised — with the
    correct response being the role's encumbrance gating, not a promise
    larger than the collateral behind it.

    **"Never reaches later deposits" is enforced by BINDING, not by the
    stated intention: each deferred liability records the TRANCHE SET
    reachable when it was recorded, and collects only from releases of
    those tranches.** A partition-wide oldest-first collection contradicts
    the reach rule the moment tranches mix ages — delayed proofs consume
    the action-time tranches, a post-offence deposit's reservation releases
    into the same token epoch, and partition-scoped FIFO hands that new
    capital to the old debt. Collection is therefore tranche-filtered; and
    when a liability's recorded tranche set is EXHAUSTED (consumed by
    proofs and collections), the remainder is **EXTINGUISHED, explicitly**
    — recorded as uncollectable, never carried forward — because the
    collateral that stood behind the promise is gone and every other rule
    in this section refuses to let a debt outlive what secured it.

    **And the liability QUEUE is bounded by the same argument that bounds
    the tranches, or the geometric tail is a gas grenade.** At a permitted
    1% rate over an 18-decimal balance, repeated offences against a fully
    reserved partition can append thousands of tiny records, and an
    oldest-first collection at release then exceeds the block gas limit —
    blocking proof resolution and principal recovery behind an iteration
    the offender manufactured. So: a reach is stored as a **WATERMARK, not a set** — the
    tranche-creation index at recording time, reaching every LIVE tranche
    created at or before it — and **liabilities whose watermarks separate
    the same live tranches AND share a predicate/config epoch are
    EQUIVALENT and COALESCE into an AGGREGATE
    liability with its OWN identity** — the epoch is part of the
    equivalence key, because quarantine pauses and invalidation
    extinguishes PER EPOCH: one aggregate spanning two epochs could
    neither selectively pause nor selectively resolve its constituents.
    And ordering survives coalescing through **BOUNDED SEGMENTS**: the
    queue is a recording-ordered list of (class, aggregate) segments,
    consecutive same-class entries coalescing within their segment —
    which preserves EVERY cross-class boundary (a per-class merge by
    earliest position would process `A1+A2` ahead of an intervening
    `B1`, re-ordering exactly what the recording rule protects). The
    segment COUNT carries a hard cap — and overflow merges the two
    OLDEST segments into one MIXED segment holding per-class subtotals
    at the older position, **with allocation inside a mixed segment
    running NARROWEST-REACH-FIRST** (the newest-same-class backward
    merge was wrong: pulling a later broad-reach debt in front of an
    intervening narrow one let the broad aggregate drain the contested
    tranche first and strand the narrow debt's only source — collection
    LOST, an operator alternating classes to the cap could shrink its
    own liabilities). Narrowest-first within the merged pair is
    collection-MAXIMIZING by the exchange argument — contested tranches
    go to the debt with no alternative — so the summary never collects
    less than any true ordering; the merged pair are the two oldest and
    collect at the front either way, and each class keeps its own reach
    and epoch inside the subtotals. Alternation-to-grow-segments is
    bounded by the cap, and each alternating offence still costs the
    attacker its own liability. The class
    count is bounded by the live tranche boundaries plus one, per the
    watermark argument, times the bounded live epochs — so the
    representation is ordering-compatible AND bounded, where a flat
    coalesce of non-adjacent same-reach entries would have re-ordered
    them past an intervening different-reach debt (amounts sum; what each can touch
    is identical — and the audit join survives WITHOUT per-offence
    traversal at settlement, because it lives at ADJUDICATION: each
    offence's adjudication event carries its `refId` and names the
    aggregate id it coalesced into, so the settlement event joins to
    the AGGREGATE alone and the constituent set reconstructs from the
    adjudication stream. Retaining constituent ids for iteration at
    collection would rebuild the gas grenade coalescing removes;
    discarding them would break the audit mandate — the aggregate id is
    how both survive). Exhausted tranches leave every
    reach automatically (a watermark reaches only what still exists), so
    tranche TURNOVER cannot mint distinct records: keep one old tranche
    alive, cycle the second slot through B1, B2, B3 … and set-valued
    reaches `{A,B1}`, `{A,B2}` … never coalesce, where the watermark
    representation collapses them the moment each Bi dies. Distinct
    outstanding liabilities per partition are then bounded by live tranche
    boundaries — the tranche bound plus one — and settlement iterates a
    list no longer than the tranche list it already iterates, under the
    gas argument already made there.

  Why three parts (figure, clamp, deferral) rather than something simpler:
  the two one-step rules each failed. A raw-total DEBIT consumes collateral
  a delayed action has already reserved — reserve 50 of 100, land three
  synchronous 25% debits, and the balance falls below the standing 50, so
  later proofs clamp, reach the wrong tranche, and settle differently
  depending on which offence class resolved first. **A reservation is
  inviolable by EVERY consumer, not merely by other delayed actions.** And
  a plain unreserved-base FIGURE lets clean reservations DISCOUNT the
  offence — fill the cap with clean delayed actions and a 25% offence costs
  12.5, repeat until unreserved is exhausted and further offences cost ZERO
  while the clean reservations later release untouched — the offence shield
  again, built this time out of good behaviour. The penalty is sized on
  what the operator holds; only its COLLECTION waits on what is currently
  free. The acceptance test for any deployment enabling both modes on one
  role is interleaving-independence — the delayed reservations settle to
  the same figures whatever order the synchronous offences land in.

  **This makes `maxConcurrentReservedBps` an ADMISSION gate, not a continuous
  invariant — deliberately.** A synchronous debit shrinks the balance the cap
  is a ratio of (100 held, 50 reserved under a 50% cap; a 25% debit of the
  unreserved 50 leaves 87.5 held with 50 still reserved — now above the
  ratio), and the two candidate repairs are both worse than the breach:
  clamping the debit so standing reservations stay within the cap turns heavy
  reservation into an OFFENCE SHIELD — reserve to the cap, then misbehave
  synchronously with impunity, the shielding attack by another door — and
  releasing reservations to restore the ratio is the amnesty this section
  spends its length forbidding. So the cap binds when a reservation is
  CREATED, against the then-current balance, and never retroactively:
  standing reservations above the ratio after a debit are preserved
  liability that blocks NEW delayed admissions until proofs resolve.
  Solvency is not the cap's job — it comes from reservations being
  inviolable in absolute terms (the debit could not touch the reserved 50);
  the cap is a throughput throttle on new exposure, and a throttled operator
  post-offence is the correct outcome.

  An earlier revision labelled this "v1's in-call dispatcher". **v1 has no
  dispatcher and no offences** — both selectable forks are non-confiscatable —
  so a reader taking that label at face value builds the principal-slashing path
  the fork rules out. The branch is real machinery for whenever a predicate
  exists; it is not v1's.
- **Delayed proof (attested tier):** the **immutable amount RESERVED at action
  acceptance** — not a figure recomputed from whatever the named tranches still
  hold — **allocated across the reachable tranches OLDEST-FIRST at
  admission, with that exact allocation persisted** for release and proof
  execution. The aggregate alone under-specifies: oldest-first versus
  newest-first changes which tranche stays withdrawable, which
  action-time reaches survive, and whether a later deposit can safely
  coalesce, while both pass the aggregate checks and debit the same
  nominal. One traversal (the same oldest-first used everywhere else in
  this design), decided once, stored with the reservation. Recomputing re-introduces resolution-order dependence, since an
  overlapping proof resolving first changes that remainder; the reservation
  exists precisely so nothing is computed at resolution. Never the current
  aggregate either.

An earlier revision stated the aggregate rule unconditionally and left it
standing after tranche provenance was made mandatory. Followed literally for a
delayed proof submitted after the original tranches were consumed and the
operator topped up, it confiscates the new tranche — the exact reach defect the
tranche section exists to prevent, restored by the sentence above it.

**Adjudication is DURABLE independently of settlement — a consumed-flag
written in the same transaction as a fallible debit is not consumed —
and this is a rule about ADJUDICATION, synchronous included, not about
proofs.** A synchronous observation sharing one call with a fallible
settlement (the recycle backing check among them) rolls back WITH it:
`OffenceRecorded` and the liability vanish, the offender need not
retry, and the same settlement-dependent escape returns one tier down.
Synchronous observation likewise commits an encumbering liability in a
non-reverting transition, with settlement separately retryable.**
The EVM rolls the earlier write back with the reverting settlement, and
the settlement CAN revert — a failed recycle backing check, an
old-token escrow path that cannot complete — so a proof "consumed" this
way through the whole evidence horizon never committed at all, and the
reservation releases despite valid evidence. The proof-to-debit path is
therefore TWO transitions: a **non-reverting committed adjudication**
(proof consumed, reservation converted to a durable adjudicated
liability — no external calls, no fallible legs) and a **separate
settlement** of that liability, whose failure leaves the liability
standing encumbered and retryable. Nothing about a broken settlement
path un-adjudicates an offence. **And every adjudicated liability BINDS
its verifier epoch, with quarantine PAUSING its settlement**: a forged
proof adjudicated moments before the defect is detected leaves a
durable liability anyone could otherwise settle into recycling while
governance deliberates — the fast containment ineffective for exactly
the evidence the broken verifier accepted last. Quarantine pauses
settlement of every liability bound to the flagged verifier's epochs,
alongside proofs and admissions; restoration resumes them; invalidation
explicitly resolves or extinguishes the rejected verifier's
liabilities in the same governance act that releases its reservations.

**Each proof is consumed before it debits.** Under attested-tier delayed
adjudication the offence arrives as a submitted proof rather than as an in-call
observation, and nothing in this design or in the code beneath it stops the same
proof being submitted twice: the lifetime counter is expressly observational,
and `LibVpfiRecycle.credit` performs no `refId` deduplication despite taking one
(`:174-217`). An unbounded replay of one valid proof drains the role bond to
zero.

So: a canonical **domain-separated offence ID** over chain, contract, operator,
role, offence kind, the action, and the commitment; marked consumed **before**
the debit, not after; with duplicate submission and cross-role replay both
tested.

**For a MULTI-ARTIFACT offence the identity is the SLOT, not the pair.**
A naive recipe double-debits twice over: hashing `(A, B)` and `(B, A)`
yields two ids for one offence — and sorting the pair fixes only that,
because with three conflicting statements the sorted pairs `(A,B)`, `(A,C)`,
`(B,C)` are still three distinct ids, and four statements yield SIX
debit-capable proofs for what the reservations provisioned as at most a
handful of actions. One round of this document had the sorted-pair rule and
called it order-independent, which it is — it just is not
COUNT-independent. The offence id is therefore the **equivocation DOMAIN
SLOT** — the duty instance the conflicting statements attach to (round,
height, request id — whatever the predicate defines as the thing one may
sign only once) — and **each slot is consumed AT MOST ONCE**: the first
accepted proof debits it, and every further pair from the same slot is the
same offence resubmitted, reverting as a duplicate regardless of which
statements it packages. Signing ten conflicting statements in one slot is
one equivocation, not forty-five.

**And the slot binds ONE canonical reservation, fixed at ADMISSION — or
consume-once decides the wrong thing deterministically.** If several
enrolled actions can share a slot, their reservations differ (balance,
rate, config epoch, tranche set all move between admissions), and "first
accepted proof debits it" lets the SUBMITTER choose which: package the
pair tied to the smallest reservation first, consume the slot, and the
larger liability can never be applied — proof ORDER now controls both the
confiscation and which tranches release, which is the
resolution-order-dependence this section exists to remove, handed to the
adversary as a feature. So slot uniqueness is enforced where reservations
are created: **the FIRST action enrolling a slot binds it, and a second
enrollment of the same slot is REFUSED at admission** — one duty instance,
one reservation, and a proof for the slot executes that reservation and no
other. Nothing is left for packaging to select. **Reversed-order
submission, third-statement resubmission, and second-enrollment refusal
are all acceptance cases.** v1 does not need this at
all: it has no offences to identify, since both selectable forks are
non-confiscatable. An earlier revision said "v1's immediate in-call recording",
which attributes a recording mechanism to a version that must not have one. For
a predicate-enabled tier, the observation and the FIGURE-fixing share
one call, while the DEBIT follows the durable-adjudication rule: the
observation commits the encumbering liability non-revertingly and the
settlement retries separately (an earlier phrasing here said
"observation and debit are the same call", which a reverting
recycle-backing check or old-token leg turns into a rolled-back
observation — the escape the two-transition rule closes) — which is
exactly why it is easy to omit when
the attested tier lands, and why it is written down here rather than there.

**Which `slashBps`, when adjudication is delayed.** Immediate recording makes
this moot for a synchronous tier, and **v1 has no offences at all** — both
selectable forks are non-confiscatable, so nothing is recorded and nothing is
debited. An earlier revision said "moot in v1", implying v1 records
immediately. The attested tier records an offence only after its
observation or adjudication window closes, and governance can retune `slashBps`
inside that gap. Unbound, an operator acting at 10% can lose 25% because
governance raised the rate before the evidence resolved — and a reduction in the
same window would discount an offence already committed. Both are the rule
changing after the act.

**Bind the BASE to the action too, not only the rate.** Debiting `slashBps` of
the CURRENT balance means an operator who raises their bond after the offending
action but before its proof resolves has the top-up confiscated — capital that
was not securing anything when the action was accepted. The action-time rate
snapshot does not help: it fixes the percentage and leaves the principal it
applies to floating upward.

So the **action-consumption record carries the bond balance as well as the
rate**. An earlier revision then specified
`min(actionTimeBalance × slashBps, currentBalance)` and called deposit-epoching
an equivalent formulation. **They are not equivalent, and the clamp is wrong on
two counts** — both of which need the tranche accounting, so it is mandatory
rather than an alternative:

- **The clamp bounds the SIZE and not the REACH.** `currentBalance` carries no
  provenance. If other proofs consume the capital that secured the action and the
  operator then tops up, a delayed proof measures against the replenished
  aggregate and confiscates the later deposit — exactly the harm the action-time
  snapshot was introduced to prevent, arriving through the clamp instead.
- **It destroys geometric slashing for concurrent proofs.** Two offences both
  accepted at a 100-token balance snapshot the same base, so each debits 10 —
  the second taking 10 rather than 10% of the remaining 90, and ten concurrent
  proofs reaching zero. That directly contradicts the geometric rule above,
  whose whole point is that the bond falls away rather than hitting zero at a
  fixed count.

**So: deposit TRANCHES — bounded or coalesced, with a proven gas bound.**
There is no minimum bond or raise size, so an operator can create an unbounded
number of tiny tranches; every delayed action then names the live ones, and
later reservation, allocation and withdrawal iterate them. Linear storage and
iteration eventually exceed the block gas limit, which does not merely slow
things down — it prevents action admission, proof execution, **and recovery of
the operator's own principal**, i.e. it is a self-inflicted permanent lock. So:
a bounded tranche count with coalescing on deposit, or an aggregate epoch/range
representation, with the gas bound demonstrated rather than assumed.

**Coalescing must preserve ACTION-TIME REACH.** Merging a new deposit into a
tranche an outstanding action already names makes the new principal reachable
by that old proof — confiscating a top-up that secured nothing, which is the
exact provenance guarantee the tranches exist to provide. So: coalesce only
into tranches with **identical outstanding exposure** (or none), keep epoch
boundaries in the representation, and **reject the deposit when no safe merge
exists** rather than merging unsafely to stay under the count. A refused
deposit is recoverable; a silently widened proof reach is not.

Each deposit is a tranche with its own epoch; an
action-consumption record names the tranches live when the action was accepted;
a proof debits **the amount RESERVED against those tranches at acceptance** —
never a figure recomputed from what they still hold, and never the aggregate.
An earlier revision said "`slashBps` of what remains of those tranches", which
re-introduces resolution-order dependence the moment an overlapping proof
resolves first and changes that remainder.

Provenance follows from the structure: a later deposit is in no tranche any
outstanding proof names, so it is unreachable however the proofs resolve. The
**amount** follows from the reservation, computed once at acceptance.

This matters more than it looks: without it, raising a bond while any proof is
outstanding increases your exposure to offences you have already committed,
which is a direct disincentive to add capacity — the opposite of what the
capacity deposit is for.

**Bind the rate to the action, not to the commitment.** An earlier revision said
to stamp the epoch into the commitment, which does not work: the commitment is
issued BEFORE the action — that is the entire point of it — so an immutable
commitment can only carry the ISSUANCE-time rate. A retune between issuance and
submission then lets an operator hold an older favourable rate, or exposes them
to a stale unfavourable one. Either way it is not the rule in force when the
action was accepted, which is the rule that should apply.

**The record also binds an immutable PREDICATE/CONFIG EPOCH, not just the
numbers.** Stamping the rate, base and tranche reach leaves the offence's own
SEMANTICS floating: governance changing a delayed predicate's verifier or
parameters between acceptance and resolution would either apply new offence
semantics retroactively, or make an offence valid under the old rules
unprovable under the new ones. Both contradict the pre-change-liability
principle the rest of this section preserves.

**And the epoch pins the verifier's BEHAVIOUR, not merely its address.** An
address is a name; an upgradeable proxy or a verifier reading mutable
configuration can change what that name DOES with no new epoch and no
quarantine — historical actions then accept forged proofs or reject
evidence that was valid when admitted, through a pin that never moved. So
the epoch records the verifier's **code hash and the hash of every config
input its verdicts read** — and **EVERY dependent touch re-checks them,
not resolution alone**: admission, proof submission, and the
release/claim path that reads the verifier's clock. A resolution-only
check detects drift only if someone resolves — with no proof in flight,
the flag stays clear, the active clock keeps running, and the withdrawal
releases reserved principal before anything ever looks. The check at each
touch is O(1) (two hash comparisons); on mismatch the touch PERSISTS and
EMITS the quarantine (then refuses or parks), so the first path to
observe the drift is the path that arms the containment.

**And detection rolls the clock back to the LAST VERIFIED point, because
the interval between drift and first touch already elapsed unobserved.**
Drift at block 150, horizon ending at 200, first touch at 201: refusing
the release at 201 cannot un-count the 51 active blocks the horizon and
artifact validity already absorbed — restore the pin and the evidence is
expired, the containment an amnesty after all. So the checkpoint SPLITS BY WHAT A TOUCH ACTUALLY VERIFIES: the
**verifier CODE checkpoint is verifier-wide** — any epoch's passing
touch proves the bytecode sound for every epoch it backs, so one
epoch's traffic protects its stale siblings against code drift — while
**each epoch's CONFIG-INPUT checkpoint is its own**, advanced only by
that epoch's touches, because E1's check reads E1's pinned config
hashes and proves nothing about E2's distinct inputs (E2's config
drifts at 150, busy E1 advances a shared checkpoint to 200, E2 detects
at 201 — a shared rollback reaches 200 and counts 50 unsound blocks,
E2's window expiring over them). A detected mismatch **restores the
shared pausable clock to the matching checkpoint — code for code
drift, the epoch's own config checkpoint for config drift**: the unverified interval never counts, since
nothing proves the verifier was sound during it. (The split resolves
the tension a single choice could not: a purely per-epoch checkpoint
under-protected CODE drift — busy E1's rollback left stale E2's
unverified interval counted — while a purely verifier-wide one
under-protected CONFIG drift, E1's touches advancing a checkpoint past
inputs they never read. Code is shared, so its checkpoint is; configs
are distinct, so theirs are.) Conservative in the only safe
direction — horizons lengthen, principal waits, nothing is forgiven.
Immutable verifier deployments make all of this vacuous, which is the
argument for them — and it is now the RULE, not a preference: **a
delayed-proof verifier is immutable, or it maintains an on-chain
APPEND-ONLY mutation log the touches check**. Point-in-time hash checks
cannot see a TRANSIENT drift (mutate, exploit, restore between touches):
both hashes match at the next touch, `lastVerified` advances across the
unsound interval, and the rollback never fires because nothing is
currently mismatched. Continuity must be provable, and only two things
prove it — code that cannot change, or a record that every change must
append to (the touch compares the log's mutation COUNT against
`lastVerified`'s snapshot; any growth triggers the same
quarantine-and-rollback as a live mismatch, restored or not). A mutable
verifier with no such log is not eligible to adjudicate delayed proofs.
**And "immutable" means the TRANSITIVE closure of behavioural inputs,
not the bytecode alone**: immutable code reading its own mutable
storage, an upgradeable oracle, or a registry is the same continuity
hole one call deeper — the dependency mutates and restores between
touches, the hashes match, no counter grew. The exemption applies only
to a verifier whose every behavioural input is itself immutable; any
mutable input either routes its mutations through an immutable
append-only logging chokepoint the touches also check, or disqualifies
the verifier exactly as mutable bytecode would. A mismatch is
QUARANTINE-EQUIVALENT for the affected epochs: proofs refuse,
horizons pause on the shared clock, and governance resolves restore-or-
invalidate exactly as for a flagged verifier. Immutable deployments
satisfy this trivially; anything else earns the check.

**One exception, and it must be a distinct path rather than a special case of
retuning: a verifier RETIRED FOR SECURITY.** If a predicate version is disabled
because its verifier accepts forged evidence, retaining it through every old
action's horizon keeps the vulnerability live — the attacker keeps submitting
forged proofs and confiscating those reservations after governance has already
identified the hole. Rule 2's "disabling does not cancel prior liability" is
right for a routine retune and exactly wrong here.

So the emergency machinery has TWO distinct operations, held by different
authorities, and this passage previously described them in interleaved layers
that contradicted one another — it is stated once here, and any earlier phrasing
that survives elsewhere is subordinate to this statement:

**1. QUARANTINE — the fast, off-timelock authority. O(1), atomic, and the ONLY
thing the fast key can do. It keys on the VERIFIER, not on one config epoch.**
Routine parameter retunes multiply config epochs over an unchanged verifier,
and different operators keep different historical epochs alive through their
horizons — so an epoch-scoped quarantine is not O(1) containment at all: the
sibling epochs the same broken verifier adjudicates stay open for forged
proofs while the fast key chases them one transaction at a time. The
quarantine is therefore **a single global flag on the verifier identity,
consulted by every dependent epoch** — an epoch is quarantined-in-effect iff
its verifier is flagged — and that is the ONLY quarantine there is: an
earlier revision added "(or it is individually flagged)" in passing, a second
quarantine path the verifier-scoped event schema cannot represent (a verifier
event over one epoch pauses every sibling in consumers' eyes; no event leaves
provers blind to the pause). An epoch-level concern is contained by
quarantining its VERIFIER — over-broad and safe, exactly what an off-timelock
incident lever should be — and resolved per-epoch by governance, which can
restore the untainted siblings in the same timelocked decision. One flag, so one write contains
every epoch at once. In that one call it (a) disables proof submission
against the suspect verifier — every epoch it backs — and (b) stops NEW
predicate-governed admissions under those epochs — while
**preserving every reservation and its horizon**
(horizons pause; nothing is released, nothing debited). **And "pause"
governs ONE clock that both the horizon and the EVIDENCE read.** Pausing
the reservation horizon while an equivocation artifact's own validity
window keeps counting wall-clock time lets the evidence EXPIRE inside the
quarantine: on restoration the reservation resumes but the verifier can no
longer accept the proof — an amnesty nobody granted, or a permanently
unresolvable reservation, delivered by the incident lever meant to prevent
exactly that. So artifact and proof validity are measured against the same
pausable ACTIVE clock as the horizon (quarantined blocks do not age the
evidence), and restoration returns the full remaining submission window
that existed when the quarantine began. The forgery stops;
nobody's liability moves; no iteration occurs. A compromised or mistaken fast
key can therefore inconvenience, but cannot amnesty and cannot confiscate.

**2. INVALIDATION — governance, timelocked, and only after a quarantine.
Resolution stays PER-EPOCH even though the quarantine was verifier-global.**
Governance decides between **restore** (the suspicion was wrong: the
verifier's flag lifts, horizons resume everywhere it applied) and
**invalidate** (the verifier is genuinely broken: the affected epochs'
reservations are released, since their liability is no longer provable by
trustworthy means) — and it may invalidate some of a verifier's epochs while
restoring others, because the containment needed one write but the
consequences are epoch-specific accounting. Invalidation is itself a **single O(1)
epoch-state transition** — the per-operator reserved accounting is
**partitioned over a bounded active set on BOTH axes: predicate/verifier epoch
AND collateral-token epoch.** The first is what makes this invalidation one
write; the second is what keeps the sums meaningful at all, and the round-49
consolidation deleted it — restored here, because rotation carries old-token
reservations, so a single figure across tokens adds incomparable raw units: a
large-decimal old reservation blocks every new-token action, and the reverse
rotation understates the old liability against the cap. Unreserved backing and
the concurrency cap are kept per collateral-token epoch (or an explicit
conversion precedes any summing) — **and the token-epoch axis is
BOUNDED by the same discipline as the predicate axis**: every claim,
cleanup, and accounting operation addresses ONE named partition in
O(1) (nothing anywhere enumerates the accumulated set), and rotation
carries BACKPRESSURE — a new rotation is refused when the **PROSPECTIVE
post-rotation count** of partitions holding actively drainable residual
principal would exceed the bound (counting the CURRENT live partition
wherever it will retain residual — gating on the existing count alone
lets exactly-at-bound rotate into bound-plus-one and overrun any
structure sized to it), with the mandatory forced-migration duty as the drain that
makes the bound reachable — **and MIGRATED-ESCROW epochs are excluded
from that bound**: a lost-key or sanctions-frozen balance preserved in
original-asset escrow cannot be drained by anyone (the frozen claim
persists until delisting), so counting it against the rotation bound
rebuilds the hostage — enough undrainable epochs and governance can
never replace a compromised token again, with migration unable to help
because it MOVES these claims rather than ending them. Escrowed
partitions move to a non-blocking, epoch-addressable ARCHIVAL ledger:
fully accounted, claimable on their own terminals, invisible to the
rotation gate. Repeated rotate-and-leave-residue cycles otherwise grow the
partition set without limit, while evicting a partition would strand
its principal, reservations, and liabilities — bounded by refusal at
the source, never by eviction. **And the reads FILTER on a TRI-STATE: admission counts partitions whose
global predicate epoch is VALID or QUARANTINED, and excludes only
INVALIDATED ones — NET, in every case, of the outstanding synchronous
liabilities bound to the partition's tranches.** Invalidation releases a
reservation in O(1) by flipping the epoch state, but a tranche-bound sync
debt recorded against that backing is ALREADY ADJUDICATED — it does not
evaporate with the epoch that happened to hold the reservation. Without
the netting, the released backing reads as withdrawable the instant the
filter flips, and the operator withdraws or re-reserves it before lazy
cleanup collects — leaving collection to eat later liability or forgive
the offence. So every read that exposes backing (withdrawable, unreserved,
admission capacity) subtracts the outstanding liabilities **PER TRANCHE,
under ONE deterministic allocation: debts in recording order, each
walking its reachable tranches oldest-first and DECREMENTING its
remaining amount as it allocates** — a debt is counted once across the
tranches it reaches, never clamped independently in each (a 10-unit debt
reaching two 100-unit tranches withholds 10, not 20, and not 0 in
whichever tranche a different implementation chose to skip). A debt's
COLLECTIBLE amount is what that walk can actually place — **against a
SHARED per-tranche residual that the walk itself decrements**, so each
unit of backing is allocated to at most ONE debt: two debts reaching the
same 10 surviving units collect 10 between them in recording order, never
10 each (`min(nominal, live reachable backing)` evaluated independently
per debt double-counts exactly there — the read withholds 20 of backing
that holds 10, and the phantom half discounts later offences). And
**every base that nets liabilities nets
the COLLECTIBLE figure, not the nominal**: the synchronous offence base
included, which otherwise lets a mostly-extinguished old debt (25
recorded, 1 still reachable after delayed proofs consumed its tranche)
discount new offences against a fresh 100-unit deposit it cannot touch.
The per-tranche figures are then summed — and any
touch that would expose invalidation-released backing settles the
liabilities reaching it FIRST. The per-tranche scoping is not detail: a
partition-WIDE subtraction would withhold a post-offence deposit for a
debt that cannot reach it — 10 owed against fully-reserved tranche A must
not freeze 10 of later tranche B while A's reservation sits valid or
quarantined through a long horizon — which is the never-reaches-later-
deposits invariant broken by the very read that was added to protect it.
The debt rides the same lazy mechanism as the cleanup, and the release
the operator sees is always the post-debt figure for the backing that
debt could actually claim. An earlier revision said "only VALID", which collides with
the quarantine's own rule that liability is preserved: filtering quarantined
partitions out lets the operator **overcommit the same collateral through
another live predicate** while the epoch is under review, and a later
restoration then exposes reservations exceeding the cap or the bond. Quarantine
pauses horizons; it does not lighten the balance sheet — the invalidation write
changes the epoch's global state, not the stored per-operator totals, so a read
that does not filter keeps counting the stale partitions until lazy cleanup
(blocking the operator, the opposite of the promise) or forces per-operator
writes back into the incident path. The filter at read time is what makes the
one global write sufficient: the invalidated amount then
leaves unreserved backing and the concurrency cap with one write, no iteration,
and reservation RECORDS are reclaimed by bounded, permissionless **lazy
cleanup** that emits the per-reservation release events afterwards. Releasing is
a judgement about unprovable liability, and judgements belong on the slow path.

**3. Repeated quarantine must not become a freeze.** Horizons pause under
quarantine, so a compromised fast key that re-quarantines a healthy epoch —
undoing each governance restore — holds every delayed unbond backed by that
epoch in suspension indefinitely: the capital freeze this note forbids for the
ordinary pause, rebuilt out of the horizon clock. So **governance's resolution
is terminal at the VERIFIER level, bound to the KEY GENERATION** — not
per-epoch, because quarantine itself is not per-epoch: a restore of
verifier V's epochs bars the SAME fast-key generation from flagging V
again (a fresh quarantine of V requires a rotated key generation, or
governance acting directly), and a governance path exists to **revoke and
replace the fast authority** in the same act. Binding terminality to the
epoch instead would force a later legitimate quarantine of V to either
re-pause the restored epoch (the freeze this rule forbids) or exempt it
from the verifier flag (a per-epoch exception the single-flag invariant
and the verifier-scoped events cannot represent). One flag, one
generation, one terminal bar — **and the restore that bars a generation
ATOMICALLY installs a usable replacement, or the verifier stays closed
until one exists**. A restore that merely bars leaves the next genuine
compromise of V with no fast lever at all: containment would need
another timelocked action, handing forged proofs the full delay this
section calls unacceptable. Bar and replace in one act, or do not
reopen. An emergency lever the incident
cannot turn against its own operators is the design goal of all three rules.

**And the bound needs an exhaustion rule.** Long evidence horizons overlapping
enough routine retunes let an operator hold reservations in every slot, and the
three obvious responses are each wrong: growing the set makes the "bounded" scan
unbounded, evicting a still-valid epoch **grants an amnesty on its liability**,
and refusing outright locks the operator out after a legitimate governance or
security retune they did not cause.

So: **backpressure, never eviction.** When an operator's active-epoch slots are
full, their new predicate-governed actions are refused — their ordinary capacity
is untouched — until a horizon expires and frees a slot. That preserves all old
liability, keeps the scan bounded, and puts the cost on the party whose
outstanding exposure caused it. **Cap exhaustion is an acceptance case**, since
this is reached by ordinary operation rather than by attack. **The invalidation emits its OWN event**, carrying the invalidated epoch — not
only the later per-reservation ones. On-chain capacity is restored immediately,
so if cleanup is delayed or never called an indexer with only per-reservation
events keeps reporting the operator as fully reserved and cannot satisfy the
reconstruction requirement in §Events. The epoch event lets it stop counting
every tracked reservation for that epoch at once.

Their storage is then reclaimed
by **bounded or permissionless lazy cleanup**, which emits the per-reservation
release events as it goes — so the indexer sees the same event stream, just
arriving after the incident rather than during it. An operator whose capacity is
restored need not wait for cleanup; cleanup is bookkeeping, not the remedy.

"Immediate" is not a property of naming it so. Ordinary configuration sits behind
the timelocked `ADMIN_ROLE`; if the **quarantine** is built as just another
predicate setter, **the attacker gets the whole governance delay** to keep
submitting forged proofs and confiscating reservations — which is precisely the
window the emergency path exists to close. (An earlier revision said this of
*invalidation*, which implies invalidation belongs on the fast key. It does
not: quarantine alone closes the window, because it stops the forged proofs —
and invalidation is the half that releases, so putting it on a fast key is the
amnesty described below.) The repository already separates these:
`PAUSER_ROLE` is the fast-key multisig for incident levers, `ADMIN_ROLE` the
timelocked one (`AdminFacet.sol:873-880`).

So this authority is **narrowly scoped to QUARANTINE** — in one atomic call it
disables proof submission against the suspect verifier **AND stops new
predicate-governed admissions under EVERY epoch that verifier backs** (the
verifier-keyed flag above; "under that epoch" survived here for a round after
the quarantine was made verifier-wide, and an implementation following this
summary would have left sibling epochs open for new reservations during the
quarantine — exactly the capacity-consumption-in-anticipation-of-amnesty path
the next paragraph describes), while **preserving every
reservation and horizon accepted before the quarantine**.

Blocking only proof submission is not enough: operators could keep consuming
bonded capacity under a verifier known to be broken, **knowing governance will
release those reservations if it invalidates** — and honest traffic alone could
fill the concurrency cap for the whole timelock. Admissions stop; existing
liability is untouched. It does NOT invalidate the
epoch, does not release capacity, and does not touch the reservation records.

**Invalidation is governance's**, per the split above: an off-timelock key that
can invalidate is an off-timelock key that can grant an amnesty — a compromised
or mistaken holder frees every affected reservation and operators withdraw
during the governance delay. An earlier revision of this paragraph gave the fast
authority the invalidation as well, which reinstates exactly that. An earlier revision said it "release[s] its reservations, atomically",
which puts an unbounded iteration back inside the incident call — the failure
this passage exists to prevent. Governance handles recovery afterwards on the
normal path. Narrow scope is what makes an
off-timelock key acceptable. Those
liabilities are unprovable by any trustworthy means once the only verifier for
them is known-broken, so releasing them is the honest outcome rather than a
concession — holding capital against evidence that can no longer be soundly
adjudicated is not caution, it is a freeze.

So each action carries the predicate version in force when it was accepted, and
**that verifier is retained through the evidence horizon** — or the change is
forbidden until every affected action resolves. Retention is preferable:
forbidding changes lets one long-horizon action block a governance fix
indefinitely.

So the rate is stamped in the **action-consumption record** written when the
submission is accepted, or the action rejects a commitment whose epoch no longer
matches the live one. The first is better — a rejection makes an ordinary retune
invalidate every outstanding commitment, which is a liveness problem for honest
operators.

The acceptance case is the ordering itself: **issue → retune → submit**, and it
must resolve to the rate at SUBMIT. Same snapshot-at-init discipline as the loan
fee stamps, applied at the right moment.

**Keyed by role, not by address.** One address may hold solver, matcher and
keeper bonds at once, and an offence recorded through a matcher entry point
must debit the matcher bond — not another role's, and not all of them. The
offence record and its counter therefore carry the role alongside the
operator, or the same event admits three materially different losses. That is the
whole rule:

- Geometric, not linear — 10% of what remains, so the bond falls away rather
  than hitting zero at a fixed count. "Ten offences to zero" in rev 1 was
  wrong arithmetic as well as an ambiguous rule.
- **Rounding is computed ONCE over the aggregate, then allocated across the
  tranches** — never per tranche, and **for a delayed proof the aggregate is
  the ACTION-TIME total, rounded when the immutable reservation is recorded,
  not the eligible remainder at resolution**. "Eligible remaining tranches"
  survived in this rule after the reservation was made immutable, and
  computing rounding at resolution re-imports exactly the resolution-order
  dependence the reservation removed — the 29-versus-30 arithmetic below, via
  the rounding instead of the base. Round once at acceptance, freeze the
  figure into the reservation, and resolution executes it; the synchronous
  case (observation and figure-fixing in one call — the debit settles
  separately, per durable adjudication) rounds ONCE over the FIGURE'S
  OWN BASE — the partition balance net of outstanding deferred liabilities
  — and only the resulting figure's COLLECTION clamps to unreserved
  backing. (This sentence previously said the synchronous rounding runs
  "over the current unreserved balance, where the two figures coincide" —
  they coincide only when nothing is reserved: at 100 held, 50 reserved,
  25% rate, the unreserved-base rounding computes 12.5 where the
  partition-net rule requires 25, which is the clean-reservation offence
  shield resurrected through the ROUNDING sentence after being evicted
  from the base rule. Rounding follows the base; clamping follows the
  collection; the two are different steps.) The
  per-tranche prohibition stands for both: deposit
  fragmentation must not change the penalty — an operator splitting 100 units
  into 100 one-unit deposits would, under per-tranche ceiling-rounding, be
  debited all 100 units at a 10% slash, and under per-tranche flooring be
  debited **zero**. Rounding once over the aggregate debits 10, the answer
  that does not depend on how the operator arranged their deposits —
  **with ceiling rounding applied to the POSITIVE NET-of-liabilities
  base only: a zero net base records ZERO** (the "any positive balance
  debits at least one unit" phrasing predated the net-base rule; against
  a zero net base it mints a liability with no action-time backing).
  Allocation across the tranches is then a distribution question for **that
  proof** — but it is **not unconstrained**, because it changes what later proofs
  can reach.

  Concretely: an older pending action names tranche A, a newer one names A+B.
  Resolve the newer first and take its debit from A, and the older proof's
  remaining base shrinks; take it from B and that base is untouched. Same debit
  now, different total loss across the pair — so allocation moves value between
  proofs even though it cannot move the current proof's total.

  **An earlier revision proposed "consume uncontested tranches first, then
  contested oldest-first" and claimed that made totals order-independent. It does
  not.** With `A = B = 100`, an older 10% proof naming `A` and a newer naming
  `A+B`: resolving the newer first debits 20 from the uncontested `B`, then 10
  from `A` — **30**. Resolving the older first debits 10 from `A`, leaving the
  newer a 190 base — **29**. Transaction ordering changes the confiscation, which
  is exactly what the rule was supposed to prevent.

  **The fix is to compute and RESERVE each proof's liability when the action is
  accepted, not when the proof resolves.** At acceptance, the debit is
  `slashBps` of the **action-time TOTAL eligible tranche balance** — not of what
  is left after earlier reservations — and that amount is reserved against the
  named tranches. Resolution then executes the reserved figure (clamped to what
  survives).

  **The base is the total, at every step.** An earlier revision said "eligible
  remainder" here and explained below that prior reservations shrink the next
  action's base, which reproduces the 10, 9, 8.1 … sequence and leaves the
  admission check unable to exhaust anything — the shielding attack surviving in
  the canonical computation while the corrected rule sat two paragraphs down.

  **Reservations are a finite resource, and that has to be admission-controlled
  or the scheme is gameable in one direction and self-locking in the other.** If
  every accepted action reserves part of the eligible tranches, an operator can
  fill their pending window with **clean** actions, leaving a later malicious
  action almost no unreserved backing to reserve against — so its liability is
  near zero — then recover the clean reservations when their horizons close,
  having paid almost nothing. And if clean reservations never release, ordinary
  operation locks the bond indefinitely instead.

  Both are closed by treating reserved backing as **the same resource bonded
  capacity already meters**:

  - **A reservation RELEASES when its evidence horizon closes with no proof.**
    That is the same horizon rule 2 uses for the unbond delay, so no new clock is
    introduced.
  - **Liability is `slashBps` of the action-time TOTAL eligible tranche balance
    — NOT of the unreserved remainder.** An earlier revision used the remainder,
    which makes the admission check below **tautological**: with 100 tokens at
    10%, successive actions reserve 10, 9, 8.1, 7.29 … and every one passes,
    because a liability computed *from* the remainder can never exceed it. The
    check could never reject, so the shielding attack survived the fix intended
    to close it, with the malicious action still getting an arbitrarily small
    reservation.

    Sized from the action-time total instead, each action reserves a **fixed**
    10 out of 100, so ten pending actions exhaust the backing and the eleventh
    is refused. That is the non-circular threshold the check needs.
  - **An action is only ACCEPTED if unreserved backing covers that liability
    AND total outstanding reservations stay within `maxConcurrentReservedBps`.**
    When either fails, the action is refused — exactly as it would be if the
    operator had exhausted their rate-limited capacity, because it is the same
    exhaustion. Bonded capacity and slash backing stop being two things.

    ⚠️ **The cap bounds the loss; it does NOT make a burst geometric, and the
    two rules give different answers.** Five 10% actions against a 100-unit
    balance reserve 10 each and debit **50**; "10% of what remains" applied five
    times gives **40.951**. Both were normative, so two conforming
    implementations would confiscate different amounts for the same burst.

    **Decided: concurrent liabilities are bounded action-time SNAPSHOTS, and the
    geometric claim is retired for bursts.** Geometric describes the sequence of
    RESOLVED debits over time — each action accepted after the previous one had
    resolved, so each sees a genuinely smaller balance. Within a burst every
    action was secured by the same capital, so there is no smaller balance for
    any of them to see, and pretending otherwise is arithmetic without a
    referent. The cap is what stops a burst reaching the whole bond; geometry is
    what shapes the long run. Two mechanisms, two jobs.

    **Dust: the cap and ceiling-rounding can leave a tiny bond with NO
    conforming outcome, so participation gets an explicit minimum.** A one-unit
    bond's 10% liability rounds UP to one unit, while a 5 000-bps cap permits
    half a unit. Rounding the cap down refuses that operator's first delayed
    action forever — the implicit minimum the continuous curve exists to
    remove — and rounding it up admits a reservation that can consume 100% of
    the bond, contradicting the burst guarantee.

    Neither invariant should yield, so the resolution is scoped instead: a bond
    whose ceiling-rounded single-action liability exceeds its cap allowance
    **cannot admit delayed-proof actions**, while keeping its ordinary capacity
    in full. That is an explicit minimum **for slash-enabled predicates only**,
    not a minimum bond — the continuous curve and the no-minimum rule are
    untouched for everything else, which is what they were actually protecting.

    **The cap needs a positive FLOOR, not only an upper bound.** Set below
    `slashBps` — or left at zero by fresh storage — the first action's liability
    already exceeds it, so **every** action under that predicate is refused
    however much bond backs it. So: `maxConcurrentReservedBps >=` the maximum
    permitted single-action liability, or values below that are defined as an
    explicit DISABLED mode rather than silently bricking admission.

    **The concurrency cap is what reconciles fixed reservations with the
    admission check, and an earlier revision had the geometric rule
    contradicting it.** Fixed
    10-of-100 reservations mean ten actions accepted before any proof resolves
    could collectively debit the whole bond — linear to zero at a fixed count,
    which §2 rejects. Geometric slashing is about the balance falling **across
    time as offences are proved**; it says nothing about a burst, and cannot,
    because every action in a burst was secured by the same capital.

    So concurrency gets its own bound rather than being squeezed into the
    geometric one: **no NEW action is admitted whose reservation would take
    total outstanding reserved liability above `maxConcurrentReservedBps` of
    the then-current ELIGIBLE balance** (never the whole bond: under C, 900
    fee-free excess beside 100 armed at a 5,000-bps cap reads as 500 of
    permitted reservations — a hundred 1% actions admitted, and a proof
    burst zeroes the armed principal the cap exists to protect) (a governance parameter, bounded well below
    10 000 — 5 000 is the natural starting value). At 10% per action that
    admits five concurrent pending actions and refuses the sixth. An earlier
    phrasing said the total "may never exceed" the ratio — a continuous
    invariant that a permitted synchronous debit falsifies by shrinking the
    denominator, leaving an implementation the choice between the
    offence-shield clamp and the amnesty release, both rejected where the
    admission-gate rule is stated. Admission-time, here too: standing
    liability above the ratio is preserved and blocks new admissions until
    proofs resolve. The bond
    cannot be zeroed by a burst, geometry is preserved across time, totals stay
    order-independent, and the admission check can still exhaust — all three
    properties at once, which no single rule delivered.

  That removes the attack rather than pricing it: the clean actions in the setup
  above consume the operator's own capacity in **fixed-size chunks** while they
  are pending, so the malicious action they were meant to shield is refused
  rather than cheapened.

  **Only a COMPLETED DEBIT reduces a later action's base — where "base"
  means the DELAYED-reservation base, and the exception covers pending
  DELAYED reservations alone: outstanding deferred SYNCHRONOUS
  liabilities DO reduce every later synchronous offence base**, per the
  net-of-collectible-liabilities figure — pricing new offences from the
  gross balance while old promises stand unpaid mints nominal liabilities
  past the collateral reachable at recording. **A pending reservation
  does not** — it constrains ADMISSION through the cap above, never the base. An earlier revision said "an action taken after an earlier
  reservation sees a smaller total", which reproduces 10, 9, 8.1 … for
  sequential clean actions against an unchanged 100-token balance — the fixed-
  size rule undone by its own explanatory paragraph, and the shielding attack
  back with it.

  **This does not conflict with geometric slashing**, which is about the balance
  falling across TIME as offences are **proved**: two actions taken at the same
  balance reserve the same amount because the same capital secured both, while an
  action taken after an earlier proof has **resolved and debited** sees a genuinely
  smaller total and reserves proportionally less. The geometry lives in the
  realised balance, not in the reservation arithmetic — and a reservation is a
  claim on capital, not a reduction of it.

  Order-independence follows because nothing is computed at resolution time.
  Geometry survives too, and in the form that is actually correct: a **later
  action** sees the earlier **completed debit** — not a pending reservation — and
  so takes 10% of a smaller base, while
  **two actions taken at the same balance** both reference that balance — which
  is the honest reading of "the capital that secured the action", since the same
  capital did secure both.

  **Overlapping eligibility sets are an acceptance case**, with the specific
  assertion being that both resolution orders produce identical totals.
- **Rounding is UP.** `balance * 1_000 / 10_000` FLOORS to zero once the
  balance drops under ten units, leaving a permanently unslashable positive
  bond that still buys capacity; an earlier revision described that
  asymptote as a feature, when in Solidity it is a floor at which slashing
  silently stops. Ceiling division alone fixes it — any positive balance
  yields a debit of at least one unit, so the bond strictly decreases and
  reaches zero.

  A previous revision ALSO said a balance below the minimum is consumed
  entirely. That case cannot arise under ceiling division and the two rules
  contradicted: no positive balance is below a one-unit debit. The sweep
  rule is dropped rather than the rounding.
- **The decay question dissolves.** Rev 1 asked whether the offence counter
  should decay, to stop a long-lived honest operator accumulating sparse
  offences into a slash. With immediate debit there is no accumulator to
  decay: each offence is priced once, at the time, against a bond that is
  already smaller for every previous one. The counter survives only as a
  lifetime tally for observability, and nothing reads it.
- Governance-bounded: `slashBps` default **1,000** (10%), **floor 100**
  (1%) — restored in rev 7 after rev 6's restructure dropped it. A zero
  leaves bonds granting elevated capacity while every proven offence debits
  nothing, which is a performance bond in name only and worse than none,
  because capacity is still being handed out on the strength of it. Ceiling
  **2,500**
  (25%), following the `MAX_*_BPS` convention in `ConfigFacet`.

**2. v1 HAS NO UNBOND DELAY — and that is the honest answer, not a gap.**

Revs 1–3 specified a delay, then privilege revocation to make the delay
mean something, then an `unlockAt` snapshot to stop retunes moving it. Review
then asked the question that dissolves all three: **what pending evidence is
the delay waiting for?**

In ratified v1 scope, nothing. Every offence is an objective lie, detected by
the outer dispatcher and debited **in the same successful call** — ⚠️ **which
v1 does NOT have.** Both selectable forks lack a confiscation predicate, so v1
has no offences to record and no dispatcher; its immediate withdrawal follows
from the ABSENCE of delayed evidence, not from same-call debiting. This
paragraph describes a tier that has a predicate, and is retained for whenever
one is specified. The liveness
tier — **a** source of evidence that arrives *after* an operator stops —
**and NOT the only one, which an earlier revision claimed: equivocation's
second conflicting statement can surface after the operator stops acting too,
and it is now the LIKELIER delayed-proof predicate. The delayed-unbond
machinery attaches to every delayed-proof predicate (rule 2), so shipping
equivocation without liveness still requires it in full.** The liveness tier as
originally imagined
acting — is explicitly out of v1. So there is no adjudication in flight when
an operator unbonds, and a 3–30 day lock protects nothing. It is a pure
lockup, and it sits badly beside a shape whose legal spine is
"refundable at will".

**So v1 unbonds immediately.** Bond, capacity, and the whole withdrawal
machinery collapse to: reduce the bond, capacity follows continuously (see
below), withdraw — **with the decrease clamping any accrued credit in the
same step.** That clamp is load-bearing here rather than incidental: without
it, immediate withdrawal hands back the capital while leaving the accrued
capacity spendable, which is the slash-and-run this section argued v1 does
not need a delay to prevent.

The delay is specified as arriving **with the first predicate that creates
delayed evidence** — which revs 1–3 assumed would be the liveness tier, and now
is more likely to be equivocation. The rules those revs worked out are kept for
whichever it is rather than discarded: privileges revoke at the request (or the
window does not cover actions taken inside it), and the horizon
parameters are pinned against RETUNES at the action's ADMISSION — where
the immutable config epoch binds — with the request only aggregating the
already-fixed horizons (pin at the request and the admission-to-request
interval is retunable in both directions) — **but "pinned" is the schema's cache rule, not a scalar
snapshot**: release still computes at claim time as the max over the
withdrawal's outstanding actions' horizons, each under ITS verifier's
pausable clock, with the retune-pin meaning a governance retune moves NONE of those
horizons after the action's ADMISSION — in either direction, and
admission is the binding moment, not the withdrawal request: the action
already binds its immutable config epoch when it is accepted, so its
horizon parameters freeze there with it. Pinning only at the request
left the admission-to-request interval retunable — shorten a 100-block
horizon to 10 after admission, wait out the 10, and the principal
releases while evidence is valid under the terms the action was actually
admitted on; a lengthening locks it under terms adopted after the fact.
The withdrawal request AGGREGATES the already-fixed per-action horizons;
it fixes nothing itself. "Cannot shorten" was
one round's wording and it permits the other half: a lengthened evidence
horizon re-locking already-requested principal under terms adopted after
the action, against both the earlier both-directions rule and the
immutable action-time config epoch. The horizon PARAMETERS freeze at the action's
ADMISSION (per the config-epoch rule above — this sentence said "at the
request" for one round after that rule landed); only the verifier's
pausable clock advancing changes when each fixed horizon completes, and
the request merely aggregates them. An earlier phrasing said
"`unlockAt` is snapshot at the request", which a verifier quarantine
falsifies in both directions — the frozen scalar releases collateral a
paused verifier's still-valid proof should hold, and extending it globally
lets an unrelated quarantine freeze every withdrawal. Those
were right answers to a question v1 does not ask yet — and they are answers
about **delayed evidence**, not about liveness, which is why they transfer.

This is the third revision in which a parameter was added to make a previous
parameter safe. That is the signal to stop extending and check whether the
mechanism is needed at all — it was not.

**3. Capacity — the DECISION, and why the mechanism is not specified here.**

**The decision, which is what this note is for:** a bond buys capacity
*continuously and proportionally*, with **no minimum bond**, up to a ceiling
of **4× the free tier per `(role, address)`** — the same key the bond record and the buckets use, where ADDRESS is the charged actor defined by an exhaustive selector→(role, actor) table that implementation must produce. That table is not optional and not inferable: `BackstopFacet.backstopFill` routes through `BackstopVaultImplementation.executeFill` into `OfferMatchFacet.matchIntent`, so the inner `msg.sender` is a SHARED vault rather than the initiator, and adapter fills likewise replace the keeper or principal with the adapter. Keying on the inner caller would pool unrelated activity and let one contract's bond subsidise every routed caller; charging wrappers without a closed mapping risks bypass or double-charging instead. Direct and routed paths both have to appear in it. Not per address across roles: an address holding solver, matcher and keeper bonds gets an independent ceiling for each, because their action units are not commensurable and a shared cap would let one role suppress another's capacity.

**Any CHANGE in capacity — up or down — must settle elapsed credit under the
OLD capacity before the new one takes effect, OR invalidate the affected
buckets and forfeit their pre-retune credit.** What is absolute is that the
credit is never **silently re-credited under the new capacity**; the two
branches are the two honest ways to avoid that. An earlier revision of this
statement required settlement unconditionally, which the conservative branch
§3 permits cannot satisfy — so a reset-based implementation was simultaneously
conforming and nonconforming. **Fourth site of this rule**; it is stated in
full at each rather than cross-referenced, because cross-references are what
let the first three drift.

Downward is the obvious half: a withdrawal, a slash, or a retune that lowers
the curve, `bondAt4x` or the free tier must reconcile outstanding credit down
before that bucket's next admission.

Upward matters just as much and an earlier revision missed it. With lazy
refill, an address can leave an empty unbonded bucket untouched, post
`bondAt4x` after a long idle stretch, and have its next admission accrue that
whole interval at the new 4× rate — elevated throughput for time during which
the capital was not locked. An upward governance retune does the same to every
stale bucket at once. So an increase checkpoints first: settle accrual to the
change timestamp at the old rate, then activate the new capacity.

Bond-decrease-only is not sufficient, and the gap is easy to miss: raising
`bondAt4x` leaves every bond BALANCE untouched while buying less capacity,
so an unvisited bucket keeps credit above the new ceiling indefinitely.
Config changes cannot walk every bucket, so the reconciliation is lazy — but
a stored epoch alone is NOT enough, which an earlier revision stopped at. Two
or more retunes before a bucket is touched cannot be reconstructed from one
stale epoch plus the current config, so reconciliation would either accrue
the whole gap at the latest rate or discard credit legitimately earned under
an intermediate one.

> ⚠️ **The cumulative index described in this paragraph is WITHDRAWN.** It is
> retained because two later findings are about it and the reasoning matters,
> but do not build it — the corrected mechanism is at the end of this section.
> A global rate-seconds index cannot serve a per-bond curve at all, and each
> revision of it fixed one symptom and exposed the next.

Use a **cumulative accrual index**: a monotonically increasing rate-seconds
total that governance settles at the OLD rate before writing each new one. A
bucket stores the index it last sampled, and its accrual over any span is
`index[now] − index[sampled]` — correct across any number of intervening
retunes, with no per-epoch history to retain. It is the same shape as a
borrow index, and this is the problem borrow indices exist for. A bucket
spanning multiple retunes before its first admission is the acceptance case.

**The index settles the RATE and not the CEILING, and that is a second
problem, not a footnote to the first.** An earlier revision of this paragraph
claimed correctness "across any number of intervening retunes" without
qualification. It is correct across any number of intervening *rate* retunes.
A capacity retune is a different operation: it changes the **clamp**, and a
clamp is applied at a moment, not accrued over a span.

The case that breaks it — and it should be an acceptance case, because it is
the one a plausible governance sequence produces:

> An untouched bucket is full at 4×. Governance lowers capacity to 1×, then
> restores it to 4× before that bucket is next admitted.

Sequential settlement clamps at the first retune and the bucket keeps 1×; the
later increase grants nothing retroactively, because capacity is a ceiling and
not a credit. Applying an accumulated index against the *final* ceiling instead
preserves the original 4× — reinstating capacity the clamp was supposed to have
destroyed, and doing it invisibly, because no record of the intermediate
ceiling survives to contradict it.

So the index must **either** retain intermediate ceiling/clamp information
alongside the rate-seconds total, **or** conservatively reset the buckets a
capacity decrease affects at the moment it is written. The second is cruder and
strictly safe: a reset can only under-credit, and under-crediting an operator
costs them throughput they can re-earn, where over-crediting hands back capacity
governance deliberately withdrew. Absent a reason to pay for the first, take the
second.

Note the two are settled by different actors at different times — the rate by
governance at each retune, the clamp by whoever touches the bucket next — which
is precisely why one index cannot carry both.

**And a third problem, which invalidates the global index outright: there is no
single "OLD rate" to settle.** The curve is continuous and per-`(role, address)`
— that is the point of it, and the reason the threshold was removed — so a
governance retune of a curve PARAMETER moves different bonds by different
factors, not all bonds by one factor.

Raising `bondAt4x` from 100 to 200 takes a 50-token bond from 2.5× to 1.75×
while a 200-token bond stays capped at 4× and does not move at all. A single
global rate-seconds total cannot settle both of those stale buckets, because
they did not accrue at a common rate to begin with. This is not fixed by the
ceiling handling above; it is a defect in the index's premise, and an earlier
revision introduced it while fixing the epoch problem.

So the accrual mechanism has to either **retain enough curve history to
integrate each bond's OWN rate over its own span**, or **conservatively
invalidate the affected buckets on every curve retune** — the same
under-credit-is-safe reasoning as the ceiling case.

**And that is still not enough, which is what finally condemns the index.** An
earlier revision concluded "reset on retune is the mechanism, and the index is
only an optimization while the curve is untouched". Wrong: the index is not
correct even *within* an untouched epoch. A zero-bonded, a partly-bonded and a
fully-bonded bucket all accrue **simultaneously at different rates**, so one
scalar difference credits them equally — which is the original defect, present
with no retune involved at all.

A global value can only be shared by buckets that share a rate, and on a
continuous per-`(role, address)` curve none of them do.

#### The corrected mechanism — no global index

Each bucket accrues from **its own** last-touch timestamp at **its own**
snapshotted rate:

```
accrued = min(ceiling(bond), balance + rate(bond) × (now − lastTouch))
```

`rate(bond)` is read from the curve at touch time and `lastTouch` is per bucket,
so nothing is shared and nothing needs settling globally. A curve retune resets
the affected buckets (per the ceiling finding above); between retunes each
bucket integrates its own rate over its own span, which is the quantity that was
wanted from the start.

This is simpler than any version of the index, and the index's whole appeal —
"settle once globally, sample cheaply per bucket" — was an optimization for a
problem the per-bond curve does not have. Three revisions were spent rescuing a
primitive borrowed from a system where every borrower DOES share one rate. This is a decision, not an
implementation detail, because without it the bond is bypassable: an
operator accrues elevated credit, withdraws the bond, and still spends
bonded capacity with nothing left to slash. It is also what makes v1's
immediate withdrawal safe — the two were decided together, and separating
them re-opens exactly the slash-and-run the delay was originally proposed to
close. "Capacity follows the bond continuously" is not sufficient on its own
and was the wording that hid this. Any bond, including none, is valid; a
larger bond buys proportionally more throughput; nothing is unlocked by
crossing a threshold. That is the shape the owner is being asked to ratify.

**The limiter's FORM is deliberately left to implementation**, and rev 6
removes the specification revs 2–5 accumulated. That is a change of position,
so here is the reasoning.

Four revisions specified a limiter, and each one's parameters created the
next round's findings: a fixed epoch needed initial-credit semantics; a leaky
bucket needed a refill floor; initialising buckets full created a
bond-recycling vector (deposit, take a full bucket, spend, withdraw, repeat
on a fresh address); making a zero window mean "dark" raised whether
withdrawals survive darkness; specifying `refillWindow`'s zero left
`bondAt4x`'s zero dividing by itself. Every one of those findings is
correct. None of them is a decision the owner needs to make, and none can be
settled well in prose without the code, the tests, and a call-site inventory
of what an "action" costs in each role.

Specifying it here had a cost beyond wasted rounds: it repeatedly asserted
guarantees the mechanism did not deliver. A one-budget rolling ceiling was
claimed for the epoch, then for the bucket; neither has it. Writing a
limiter's *envelope* honestly is exactly the thing that needs the
implementation in front of you.

**What implementation must settle** — the output of those rounds, kept as a
checklist rather than as a design:

1. The bond→capacity curve's arithmetic: precision, rounding direction, and
   the amount that reaches 4×. Rounding must not create an implicit minimum.
2. The limiter's envelope, stated as what it actually admits over a rolling
   window rather than as a round number.
3. Fresh-storage and zero semantics for **every** divisor and knob, and
   whether a role is dark until all of them are set. `bondAt4x` and the
   refill parameter both divide.
4. What "dark" preserves: withdrawals must stay callable and the free tier
   must keep working, or disabling the feature strands escrowed VPFI and
   breaks the permissionless baseline.
5. Initial capacity for an unseen `(role, address)`, chosen so a bond cannot
   be recycled through fresh addresses to mint repeated full-capacity bursts
   — the aggregate cost claim in §4 depends on this.
6. Cost units per role — per fill, per action, per admission — with only
   executed items charged, so batching cannot walk through the limit.

**4. The 4× ceiling bounds an ADDRESS, not an operator — stated as such.**

Rev 1 claimed the ceiling stops bonds becoming de-facto exclusivity. It does
not, and the claim is withdrawn. Solver and matcher entry points are
permissionless, so one controller splits its bond across two addresses for 8×
aggregate, and across `N` for `4N×`. The ceiling is not a Sybil bound and
nothing here makes it one.

What is actually true, and all that is claimed:

- **Per address**, capacity is bounded at 4× the free tier.
- **In aggregate**, dominance costs capital LINEARLY — `N` addresses at the
  ceiling require `N × bondAt4x` bonded and idle — **and that claim does not
  survive the free tier either.** It is withdrawn.

  The free tier is mandatory and unbonded by design, so a controller can run
  `4N` fresh addresses on their free allowance and reach the same aggregate
  throughput as `N` addresses bonded at the ceiling, for no VPFI at all.
  Preventing an initially-full bucket delays that; it does not price it.
  There is no aggregate cost curve without non-Sybil identity or friction on
  the free tier, and this note deliberately adds neither.

  So the honest statement is narrow: **a bond is an optional PER-ADDRESS
  convenience** — it raises one address's throughput up to 4×, and buys the
  operator fewer addresses to manage rather than capacity nobody else can
  have. It is not an aggregate bound and not an aggregate cost. This is the
  third revision of this claim; the first two said it bounded an operator,
  then that it priced one. **It holds only if a fresh
  address cannot be handed a full capacity balance on first touch**: with
  immediate withdrawal and a full initial bucket, one `bondAt4x` can be
  walked through fresh addresses to mint repeated bursts, and the claim
  collapses to the cost of one bond. That is item 5 of the implementation
  checklist above, and this claim depends on it being settled correctly.
- **Even where roles are GRANTED, the bound is still PER ADDRESS.** Rev 2
  claimed the keeper `KEEPER_ACTION_*` tiers could aggregate capacity under
  the granted principal. Checked against the wiring, that does not hold
  either (rev 3): `LibVaipakam.Storage.approvedKeeperActions` is keyed
  `[principal][keeper]` and `LibAuth.requireKeeperFor` authenticates
  `msg.sender`, so the protocol learns **no identity shared by several
  grantee addresses**. A controller takes the same grant on `N` addresses and
  gets `N` separate caps.

  Keying capacity to the granting PRINCIPAL instead is worse, not better: a
  principal's approved keepers are typically unrelated parties, so they would
  consume one another's quota and one keeper could starve the rest.

  So the honest statement is the same in both cases — **a per-granted-address
  bound**. A genuine per-operator bound needs an operator identity mechanism
  that does not exist here, and inventing one is out of scope for this note.
  This is the second revision in a row where a per-operator claim did not
  survive contact with the wiring; it should not be made a third time without
  that mechanism landing first.

**Bond sizes: still no minimum.** A VPFI-denominated floor is a price-varying
entry cost, and the design forbids bonds becoming an entry barrier. The
continuous credit above is what makes "no minimum" implementable rather than
merely stated.

### THE DECISION THIS NOTE NOW NEEDS — v1 has no slashable predicate

Three predicate attempts have collapsed under review, in three different
directions, and the third took the last candidate with it. Staleness needs an
unobservable "knew"; a timing rule slashes honest operators; a caller-supplied
snapshot exculpates dishonest ones; keeper grant-scope fails identically. What
survives is only the internally-inconsistent call, which should revert rather
than record an offence.

**So v1 as specified is a bond with nothing to slash.** That is not a gap to
fill with a fourth attempt — it is what the evidence says, and the owner should
choose between two coherent shapes rather than have me keep trying:

**(A) Ship v1 WITHOUT slashing.** Bonds buy capacity continuously, are
refundable at will, and nothing is confiscated — an operational CAPACITY
deposit, named as such. `ServiceBondSlash` stays reserved and unused.

*Two costs, both of which review surfaced and neither of which an earlier
draft of this fork admitted:*

- **It drops half this card's objective.** The stated goal at the top is a
  *temporal + permanent* VPFI sink. A refundable deposit is only the temporal
  half; the permanent route is the slash, and (A) leaves it unused. So (A) is
  not "the useful half shipped early" — it is a deliberate deferral of
  permanent absorption, and choosing it should be recorded as an objective
  change rather than a scoping detail.
- **Revocation does not answer every covered operator.** An earlier draft of
  this fork said misbehaviour is answered by role revocation. That holds only
  for DELEGATED keeper access. `OfferMatchFacet.matchSignedOffer` has no
  per-matcher authorization to revoke, and `matchIntent` is open whenever
  `requiresKeeperAuth` is false — so a permissionless matcher simply
  continues, from the same address or another. Under (A) those paths have no
  operator-specific response at all.

**The attested tier's unbond delay must cover the full EVIDENCE HORIZON**,
not a round number. Revoking privileges at the request stops new actions; it
does not preserve collateral for evidence already pending. So an operator
who acts immediately before requesting unbond, with an observation
commitment or adjudication window that outlives the snapshotted `unlockAt`,
walks away before the offence can be proven — slash-and-run restored by a
delay that looked generous. The floor must therefore be bound to the maximum
commitment plus adjudication window, or unlock must wait until every
pre-request commitment has expired or resolved. Test the boundary, not the
middle.

**Enrolment is required if the attested tier later arrives**, and "no
migration" was wrong. Activating predicates against balances deposited under
capacity-only terms would make them confiscatable by the activation
transaction itself, which immediate withdrawal does not protect against —
the owner never had a chance to exit. So the tier must require **explicit per-operator enrolment**, or **version
deposits and only debit enrolled ones**. ⚠️ **A withdrawal grace period is NOT
a third option and an earlier revision listed it as one:** an operator who is
offline, has lost their key, or simply does not watch governance has their
deposit converted from explicitly non-confiscatable terms into slashable
collateral the moment the window lapses. **An opportunity to exit is not
affirmative enrolment** — it inverts the default, which is exactly what the
capacity-only terms promised would not happen.

Un-enrolled deposits therefore stay **non-slashable** and simply **stop
granting predicate-enabled capacity** until converted. That keeps the incentive
to enrol without touching anyone's principal on a timer.

**(B) Ship nothing until the attested tier — and (B) IS NOW UNRESOLVED, not a
third path.** This option previously read "wait for the observation commitment
that makes 'knew' adjudicable, and land capacity, bonds and slashing together",
which survived the correction above and directly contradicts it: §2 establishes
that no commitment reveals later knowledge, that neither branch of the attested
fork recovers a slash, and that no knowledge-free predicate has been found.

So B has **no defined predicate**, and "wait for the attested tier" is waiting
for something nobody has specified. It cannot be selected as a single decision,
because selecting it decides nothing — the later table's promise of confiscation
under B is a promise about a mechanism that does not exist.

B becomes selectable only when a **concrete knowledge-free predicate** is
written down — a strict liveness obligation, or an equivocation (two conflicting
signed statements), where the offence is visible in the artifacts themselves and
no inference about the operator's state of mind is required. Until then B means
"defer the whole feature indefinitely", and the owner should be choosing it on
that basis rather than on the expectation of eventual slashing.

**(C) Ship (A) plus a non-refundable ARMING FEE.** A fee charged when a bond
is posted or raised, credited through the recycle chokepoint and never
returned. It needs no adjudication of anything — a spend is objectively a
spend — which is exactly why the perk channel works, and it is the same
shape: spend is permanent absorption, deposit is temporal.

**The fee is charged only for capacity the raise actually grants.** Capacity is
clamped at the 4× ceiling per `(role, address)`, so an operator already at or
above `bondAt4x` gains nothing from raising further — and charging a
non-refundable fee for an operation that changes no entitlement is taking
permanent value for nothing, which is precisely the representation problem the
shape rules exist to prevent. There is no maximum bond and no no-op rejection
today, so this must be stated rather than assumed.

Either **reject a raise whose post-bond capacity does not increase**, or
**accept the excess deposit and charge no fee for it**. The second is friendlier
— an operator over-depositing is not doing anything wrong, and their principal
is still refundable — and it keeps the rule simple: the fee tracks capacity
granted, never the transaction.

**And the arming call binds the CAPACITY, not only the fee.** A `maxArmingFee`
parameter protects an operator from a re-priced fee and does nothing about a
re-priced curve: if governance raises `bondAt4x` while their transaction is
pending, the same bond buys materially less capacity, the raise stays positive
so the capacity-neutral rejection above does not fire, and the operator pays the
full non-refundable fee for something other than what they reviewed. Same
substitution the perk channel binds against, and for the same reason — a
non-refundable spend must settle on the terms its payer saw.

So the call carries a **minimum post-arming capacity, the expected
COLLATERAL-TOKEN EPOCH, and the expected ACTION-COST CONFIG EPOCH for the
role — all three mandatory; none of this is the optional config-epoch
branch**. Two of the three bind what the deposit IS; the third binds what it
BUYS: a governance retune of the role's per-action cost or limiter landing
while the transaction is pending leaves both the token epoch and the raw
capacity figure matching — this document itself records that identical
capacity parameters yield materially different throughput when cost units
change — so without the third binding the payer still pays the
non-refundable fee for fewer executable operations than they reviewed.
Equivalently stated as the entitlement it protects: the call binds a
**minimum executable throughput** — at least the reviewed number of
minimum-cost actions of the role, under the cost schedule in force when it
executes — and reverts if any of the three bindings fails.

**And a cost or limiter retune reconciles credit ALREADY STORED, exactly
as a capacity retune must**: the epoch binding protects the in-flight
arming call and nothing else — a bucket holding 100 units at
cost-10-per-action that survives a retune to cost 1 silently buys 100
actions instead of 10, a retroactive burst granted with the raw capacity
untouched. The settle-or-invalidate decision applies here identically — **and
"settle" means the STORED balance is RESCALED, not merely checkpointed**:
settling elapsed accrual under the old schedule still leaves 100 stored
units that the new cost immediately reads as 100 actions. The stored
balance converts to preserve its old-schedule EXECUTABLE ENTITLEMENT
(scaled by the cost ratio, so 100 units at cost-10 become 10 units at
cost-1 — the same 10 actions either way), or the affected bucket
is invalidated and its credit forfeited, before the new cost prices
anything. **The rescale branch exists only for DOWNWARD cost moves** —
an upward move preserving entitlement needs a stored balance above the
bucket ceiling (10 actions at cost-20 is 200 units in a 100-unit
bucket), and either clamping (entitlement silently cut) or over-ceiling
grandfathering (a burst above the limiter envelope) breaks something
the ceiling exists for. **Upward-cost retunes take the invalidation
branch**, and both directions are acceptance cases. Minimum capacity alone survives a token
rotation that lands while the arming transaction is pending: with both assets
approved, the selector pulls the REPLACEMENT token and charges the
non-refundable fee against it, and identical raw amounts or capacity can
satisfy the bound while the replacement differs in value or decimals — the
payer settles on terms they never reviewed, passing the very check added to
prevent that. Every value-pulling arming or deposit call therefore binds the
token epoch it was signed against and reverts on mismatch; the config-epoch
form (fee + curve together) remains the stronger optional binding on top.

**Selecting (A) or (C) also changes the programme's definition of done, and
that consequence has to be recorded rather than discovered.**
`VpfiRecyclingCompletionPlan.md` §6 defines #1219 as decided when *either* the
legal glance passed **and** the slash path `credit(ServiceBondSlash, …)` is
"built and live", **or** an explicit owner deferral is recorded — and it says
"pending" is not a done state.

A live A or C implementation is **neither**: it ships, so it is not a deferral,
and it has no slash path, so the first branch is unsatisfiable by construction.
The M7 completion gate would stay permanently unmet while the feature is
finished — the worst combination, because nothing in the programme would ever
signal that it is waiting on something impossible.

So whichever of A or C is selected, the plan's §6 clause is amended in the same
change: a **third done state — shipped without a slash path**, on the reasoning
in this note, with `ServiceBondSlash` remaining an unused enum slot reserved for
the attested tier. That amendment is part of the fork decision, not a follow-up
to it.

*What C restores, precisely:* the **permanent SINK**, not the performance
bond. An earlier draft said it "restores the objective" and that overclaimed
— the principal is still never at risk for misbehaviour, and the permanent
payment purchases capacity rather than securing performance. C carries the
same operator-response loss as A; what it adds back is absorption, not
deterrence.

*What C needs specified before build, and these belong in the owner
decisions rather than to an implementer's discretion:*

- **Formula and transfer.** Flat per arming, or proportional to the raise?
  Paid IN ADDITION to the deposit, or deducted from it? A floor-rounded
  proportional charge lets sufficiently small raises contribute nothing,
  which defeats the property C exists to restore — so proportional needs
  ceiling rounding and a minimum, or the fee should simply be flat.
  Proposed: **flat per arming, paid in addition, governance-set with a
  ceiling**, because it is the variant with no rounding hole.
- **The arming call must BIND the fee it accepted** — `maxArmingFee`, or an
  expected fee, or a config epoch, reverting on adverse drift. Governance can
  re-price while an arming transaction is pending, and if the implementation
  debits a preapproved allowance or an internal balance, an upward retune
  charges more than the operator agreed to. This is the same defect the perk
  channel had and fixed (`purchasePerk` binds `maxTotalVpfi` and the exact
  entitlement); a fee invented in this note should not have to relearn it.
- **Its own `RecycleSource`.** `LibVpfiRecycle.credit` needs a concrete
  member and the enum is append-only. `ServiceBondSlash` must NOT be used —
  C performs no slash, and reporting fee purchases as offences would
  corrupt the metric that member exists for. Borrowing a perk or generic
  class merges distinct absorption. So C appends
  **`RecycleSource.CapacityArmingFee`**, with its own event and test. (An
  earlier revision named it `ServiceBondArmingFee` in the same document that
  makes capacity-deposit naming normative for every public identifier and
  grants exactly ONE exception — the already-merged `ServiceBondSlash`. A NEW
  append-only member is precisely where the naming rule bites: once appended
  it is exposed through recycle events forever, so it is named correctly
  BEFORE deployment, not grandfathered after.)

**Arming stored excess creates a FRESH exposure epoch — old liability
watermarks must not reach newly armed principal.** A deferred liability
persists a tranche watermark from when its offence was recorded; if
arming later flips eligibility inside the same stored tranche, a debt
recorded against zero eligible backing becomes collectible from
principal that was not eligible when the offence occurred — action-time
reach violated through the eligibility flag rather than the tranche
list. Armed-from-excess principal therefore enters as a NEW
tranche/exposure epoch (beyond every existing watermark) — **and the
fresh epoch is MANDATORY, not one of two equivalents**: the
per-liability-cap alternative this rule once offered breaks the
coalescing bound (liabilities sharing one watermark but carrying
different caps are not equivalent and cannot merge), and with no
minimum raise or offence size the oldest-first queue grows past the gas
limit again — the same grenade, rebuilt out of the supposedly
equivalent option. One approach, the one that preserves every invariant
already proved.

**Fee-free EXCESS never becomes armed capacity by retune.** An operator
who pre-deposits above the current ceiling pays no fee on the excess —
correct at deposit time, since it grants no capacity — but a later curve
retune must not silently activate it: deposit 100 to the ceiling, add 900
free, let `bondAt4x` rise, and the 900 preserves full entitlement that a
post-retune deposit of the same 900 would have paid for. **Both capacity
CURVE inputs — the ceiling read and the rate read — take the persisted
ELIGIBLE balance NET of outstanding collectible and adjudicated-frozen
liabilities, never the undifferentiated bond amount**: encumbered
backing must not buy capacity — 100 eligible units fully encumbered by
an adjudicated liability whose settlement keeps failing would otherwise
grant the full 4× rate, and synchronous offences would be admitted
against a net base of zero — a formula fed
the whole deposit re-prices all 1,000 units at the next bucket touch
after a retune and silently activates the excess without its arming fee,
the exact bypass the eligibility split exists to prevent. The excess is
therefore recorded as **capacity-INELIGIBLE until separately ARMED**, and
the arming call charges the fee on the capacity being activated — the fee
tracks capacity granted, whichever transaction grants it.

**And withdrawals drain the INELIGIBLE excess first, deterministically.**
Once a deposit holds both armed and fee-free principal, an unspecified
partial withdrawal lets implementations disagree about everything that
matters — whether 100 withdrawn from a 100-armed/900-excess deposit
preserves full capacity or zeroes it, and how much a later top-up owes.
Excess-first is the order because the operator PAID for the armed
capacity: consuming armed principal while free excess sits idle destroys
value the fee bought. Armed principal is reached only when the excess is
exhausted, capacity reduces accordingly, and the persisted
eligible-balance figure is updated in the same act — re-arming withdrawn
capacity later is a new grant and owes a new fee, per the rule above.

**Every deferred-liability COLLECTION re-screens sanctions, and a flagged
operator's liability converts to the frozen-encumbrance form instead of
collecting.** The parked-adjudication rule covers a proof arriving after
the flag; a liability adjudicated while the operator was CLEAN and still
deferred behind reservations is the symmetric case — a later
confirmation must not let a reservation release, an invalidation, or a
permissionless cleanup collect it into recycling while the balance is
frozen. On a flagged read — **including the FIRST authoritative flagged read,
persisted in the same committed act, exactly as on the proof and
withdrawal paths** (a reverting screen on cleanup's path rolls back the
marker AND the conversion, and a later oracle outage then collects the
frozen principal through the never-confirmed fail-open branch) — the
collection converts the liability to the
same adjudicated-frozen encumbrance (netted from every withdrawable
figure, custody unmoved) and settlement waits for the delisting
re-screen, exactly as for the parked
adjudication.

**INVOLUNTARY debits are SIZED ON and CONFINED TO the action-time
ELIGIBLE backing — the excess is not confiscatable at all.** A slash or
deferred-liability collection is not a withdrawal, and "armed first,
excess when exhausted" would still have been wrong twice over: the
synchronous figure sized on the whole partition takes 25% of a
100-armed/900-excess deposit as 250 — consuming all the armed principal
and 150 of excess that, by this section's own premise, never secured
anything. Non-capacity-bearing principal cannot back an offence and
cannot pay for one. So every involuntary figure computes on the
ELIGIBLE (armed) balance net of its outstanding liabilities, the debit
and any deferred collection are confined to that eligible backing (its
action-time tranches, as already required), capacity and the persisted
eligible balance update in the same transition — and the fee-free
excess is untouchable by adjudication, exactly as untouched as a
different operator's deposit. Voluntary exits preserve what the fee
bought; punishment reaches what backed the misbehaviour, and nothing
else.

**Recommendation: (C), else (A)** — and the real question is **not** "ship now
or wait for the adjudicating tier". An earlier revision of this summary framed it
that way and promised later deterrence, which survives from before B was
withdrawn and can still make waiting look actionable: §2 states that no route to
deterrence is specified under any fork, so there is nothing to wait *for*.

The actual decision is narrower and entirely about the **permanent sink**: (A)
ships a purely temporal capacity deposit, (C) ships the same thing plus a
non-refundable arming fee that is permanently absorbed. Both are non-slashable
capacity deposits; neither becomes a performance bond later unless a
knowledge-free predicate is specified, and specifying one is separate work with
no schedule attached to it.

Everything in this note that survived review is about capacity; everything that
collapsed is about slashing.

**Open for the owner.** The fork is the **first** blocking decision, and under
one branch it is not the last: choosing **(C)** immediately raises item 2, which
§3 states is not buildable without a number. So **(A) is the single-decision
path and (C) is the two-decision path** — B is not a path at all, having no
predicate, and is removed from the selectable forks below. An earlier revision
of this sentence still counted it as one, which is enough for an owner to treat
it as ratifiable.

Saying "exactly ONE decision blocks a build" — as an earlier revision did — is
wrong in exactly the case the recommendation points at, and its failure mode is
an owner who selects C, believes the fork discharged, and leaves the
implementation underspecified.

**1. Select the fork: (A) or (C).** Not "does v1 ship" — that question was in an
earlier revision of this list and a "yes" to it leaves an implementer unable to
tell whether anything is confiscated.

**(B) IS NOT ON THIS LIST, and an earlier revision offered it here while §2 was
establishing that it cannot be selected.** B has no defined predicate; ratifying
it would hand an implementer a choice between deferring indefinitely and
inventing a slash condition this document spent five attempts rejecting. It
returns to the list when a concrete knowledge-free predicate exists — strict
liveness, or equivocation — and not before.

The two selectable forks differ in what a deposit IS:

| | confiscates? | permanent sink? | deposit is called |
| --- | --- | --- | --- |
| **A** | no | no | operational capacity deposit |
| **C** | no | yes (arming fee) | operational capacity deposit |
| ~~**B**~~ | ~~yes, once attested~~ | ~~yes (slash)~~ | **unavailable — no predicate** |

Recommendation **(C), else (A)**. Both abandon performance security. Note this
is no longer a choice about *when* deterrence arrives, because no route to it
has been specified — see item 3.

**2. If (C): the arming fee's value, floor and ceiling — and the FLOOR MUST BE
POSITIVE.** Flat per arming, paid in addition to the deposit, per §3. Without a
number (C) is not buildable, and its permanent-sink property is exactly what the
number sets.

**The permissionless FREE TIER needs a positive floor too**, for the same class
of reason and in the opposite direction. Dark mode is specified to preserve the
free tier, but if governance retunes free-tier capacity to zero — or fresh
storage simply leaves it there — that preservation grants nothing, every
unbonded operation is refused, and the optional bond becomes an **entry gate**.
This note already imposes positive floors on the arming fee and on `slashBps`
for analogous zero-value failures; leaving the baseline that defines
"permissionless" unconstrained is the omission that matters most, because it
converts the product into a different one silently.

So: a free-tier floor that **covers at least ONE complete minimum-cost action
per role**, or a separate hard-coded permissionless allowance that no retune can
reach. "Non-zero" was the earlier wording and it is satisfiable while every
zero-bond operation is still refused: cost units are deferred to implementation,
so a role's minimum action charge can exceed a merely positive floor and the
free bucket never accumulates one action's worth — governance compliant, product
converted. **Operation at the configured floor is the acceptance case**: a
zero-bond operator performs one minimum-cost action of each role.

**A zero floor collapses C into A silently.** Governance could later tune the
flat fee to zero while bond posting and raising stayed enabled — no absorption,
no permanent sink, and nothing anywhere would notice, because the programme
would still record C as shipped. That is the same zero-value failure this note
already guards against for `slashBps`, where §2 imposes a positive floor for
precisely this reason; leaving C's floor unconstrained applies the lesson in one
place and not the other.

So: **the floor and the active fee are both positive**, or zero is defined as
DARK — the channel disarmed, posting and raising refused — so that fee-free
arming cannot occur by omission. The first is simpler; the second is only worth
it if governance needs a way to pause arming without a redeploy.

**3. UNRESOLVED — the liveness tier's PREDICATE, not its timing.** An earlier
revision of this item said the liveness tier "makes 'knew' adjudicable" and that
the choice was *when*, not *whether*. §2 refutes both halves: no commitment
reveals knowledge acquired after issuance, and neither attested branch recovers
a slash. Scoping this item as written would let an implementation revive exactly
the knowledge-based slash this document rejects — the retracted claim surviving
in the owner-facing list is how that happens.

What is genuinely open is **whether a knowledge-free predicate can be defined at
all**. Two candidates, neither yet specified:

- **Strict liveness** — a committed window, missed. **Weaker than it looks, and
  possibly not viable at all.** The kill-switch suspension rule handles the case
  where the protocol forbids performance, but it cannot distinguish an operator
  who did nothing from one whose timely transaction was censored by builders, or
  from a chain halt across the deadline — no global, role or selector switch
  changes in either case, so the stated exception never fires. An absent on-chain
  action is then read as an offence, which is the builder-ordering failure this
  note already rejected once for staleness.

  Making it viable needs **inclusion-independent evidence** (something the
  operator can produce that proves timely intent without depending on being
  included) plus an outage and grace model. Absent both, strict liveness is not a
  candidate and equivocation is the only one left.
- **Equivocation** — two conflicting signed statements from one operator. The
  offence is visible in the artifacts themselves and requires no inference about
  what anyone knew, which is what makes it the strongest candidate.

Until one is written down, **there is no route to deterrence under any fork**,
and the unbond delay, the revocation rule and the retune-pinned claim-time
horizon rule from revs 2–3 (with `unlockAt` as its non-authoritative cache)
are machinery waiting on a predicate rather than a tier waiting on a
schedule.

**NOT for the owner, deliberately — deferred to implementation:**

`bondAt4x` and `refillWindow` were listed here as owner numbers, and that was
wrong. The same `refillWindow` yields materially different throughput
depending on bucket size, initialization and whether a cost is charged per
fill, per action or per admission — none of which is settled (§3's checklist
is exactly that list). Ratifying numbers whose operational meaning is
undefined would produce two conforming implementations with different limits.
The implementation pass defines the units and the envelope, then brings the
numbers back with their actual throughput meaning attached.

**Already ratified, recorded here so nothing re-opens them:** the no-yield
refundable-deposit shape; objective-lies-only for v1 (which collapsed to no
predicate at all — see the fork); the 4× ceiling per `(role, address)` as an
invariant rather than a suggestion; no minimum bond; **no v1 unbond delay —
because v1 has no delayed-proof predicate, NOT because the delay belongs to the
liveness tier** (an earlier revision of this list said the latter, which would
let an implementer ship equivocation without liveness and permit immediate
withdrawal after conflicting statements are signed, exactly as rule 2 now
forbids); and
clamp-on-any-capacity-reduction.

## Tests

Rev 6's restructure deleted this section along with the limiter it was
retiring. That was a regression: the cases below are acceptance criteria for
the bond's SAFETY, not for the limiter's shape, and they survive whatever
form the limiter takes.

**Fund accounting and lifecycle — restored, and the reason they matter is
that everything else is throughput and these are custody:**

- Bond / unbond lifecycle, including that v1 withdrawal is IMMEDIATE and that
  the withdrawal clamps accrued credit in the same step. A test that
  withdraws and then spends is the one that catches the bypass.
- **[ANY PREDICATE-ENABLED TIER — deferred under plain (A)/(C), like
  every slash test; "attested tier only" was the earlier scope, and it
  under-covered: the first slash predicate may arrive through the
  explicit enrolment path on A or C rather than as the attested/B tier,
  and the rotation rule preserves old-token reservations for EVERY
  delayed predicate]
  An OLD-TOKEN slash settles through the per-token path, never the live
  `LibVpfiRecycle.credit`.** An earlier revision left this criterion unscoped,
  so a conforming v1 build — which has no slash path and must keep
  `ServiceBondSlash` unused — would have had to add the forbidden path or fail
  its own suite. Rotation now CARRIES old-token reservations, so a
  delayed proof can resolve against one after the rotation — and the live credit
  checks the balance of the new `s.vpfiToken` against one scalar bucket, so it
  reverts for want of new-token backing or credits unrelated new tokens as
  recycled. The criterion therefore exercises whichever mechanism §Mechanics
  selects — per-token recycle accounting or escrow settlement — with its own
  accounting event, and asserts the confiscated OLD asset is what moves.
- **SANCTIONS, on every value-moving bond selector.** VPFI deposits and
  withdrawals are Tier-1 BLOCK in the repository's sanctions matrix, and the
  gate is per SELECTOR — each entry point screens the value's owner or
  recipient itself.

  **`unbond` PARKS rather than reverts on the FIRST authoritative flag.** An
  earlier revision of this criterion required a revert, which rolls back the very
  write recording `sanctionsConfirmedFlagged` — so a later oracle outage routes
  that balance down the never-confirmed fail-open branch. A revert is the right
  refusal only where nothing new must persist, and this is the case where
  something must.

  **`unbond` needs the FAIL-CLOSED branch and its own outage test.** Requiring
  only `LibVaipakam._assertNotSanctioned` is satisfiable with the fail-open
  helper alone, which releases a previously frozen balance during an oracle
  outage — contradicting rule 2's freeze and the rotation reasoning that treats a
  flagged balance as undrainable. So the criteria require
  **`assertNotSanctionedFailClosed` on the release path for confirmed-flagged
  balances**, plus a focused test: operator confirmed flagged, oracle then unset
  or reverting, `unbond` MUST refuse — **reverting when the flag is already
  persisted, PARKING when this call is the first authoritative observation.**

  **So `unbond` does NOT call `_assertNotSanctioned` on the first-flag path.**
  That helper is a `view` that reverts, so any flag write or parked-withdrawal
  transition in the same transaction rolls back with it — restoring the
  later-outage escape this rule exists to close. The first flagged `unbond`
  reads the **non-reverting tri-state** and commits the parked state; the
  reverting helper is used only on paths that need to persist nothing. And a companion asserting an operator never
  confirmed flagged still withdraws during the same outage — otherwise an
  implementation could pass by freezing everyone.

  **Post-request unenrolled calls DEMOTE to the free tier — "non-slashable"
alone left the capacity armed.** If the non-slashable alternative merely
labels post-request calls, the deposit (posted until its horizon ends)
keeps feeding the capacity curve while the new calls create no
reservations or liabilities: up to 4× throughput for the whole delay
with no collateral exposed to it, against both the
privileges-revoke-at-request rule and the rule that unenrolled deposits
grant no predicate-enabled capacity. The branch demotes such calls to
the free-tier allowance outright — bonded capacity is REMOVED from them,
not just their slashability.

**EVERY first authoritative `Flagged` refusal commits the marker —
single-party calls included, on every selector.** The committed
transition was specified for proofs, withdrawals, collections and the
mixed multi-party result, which left the ordinary case uncovered: a
plain `postCapacityDeposit` whose sole party is freshly flagged would
refuse through the reverting helper, roll back the confirmation, and
hand the next outage a "never confirmed" wallet whose fail-open deposit
and withdrawal paths accept and release principal. Wherever a screen
reads `Flagged` for a wallet with no persisted marker, the refusal is a
COMMITTED, value-unmoving transition that writes
`sanctionsConfirmedFlagged` — **and it is VISIBLE: the call returns an
explicit refusal status and emits a dedicated refusal/marker event**. A
committed refusal that looks like ordinary EVM success deceives every
integrating contract (which cannot read events mid-call) into
continuing a workflow on a deposit that does not exist, and leaves
indexers unable to reconstruct the newly persisted marker. Integrations
MUST branch on the returned status; the plain reverting helper remains for wallets
whose marker is already persisted.

**A delayed proof against a CONFIRMED-SANCTIONED operator adjudicates
without moving the funds.** The blanket per-selector screen cannot simply
reject the proof: a reverted proof leaves the horizon expiring, the
operator delists later, the reservation releases, and an otherwise valid
debit is escaped — while executing it normally transfers frozen principal
into recycling, against the repository rule that sanctioned funds freeze
rather than move. So proof submission on a flagged operator — **including the FIRST
authoritative flagged read, when no confirmed marker exists yet** —
follows the committed-transition pattern: the ordinary reverting screen
would roll back the very observation (the first-flag rule again, on the
prover's path), leaving the proof unconsumed, the horizon expiring, and
the debit escaping at delisting. The transition persists the confirmed
marker in the same committed act; the proof is CONSUMED and the offence
ADJUDICATED (the evidence landed; the horizon question ends), the
reserved amount converts to an **adjudicated liability held frozen** —
no custody moves, nothing reaches the recycle bucket — and the liability
settles on ONE terminal only: **executed into recycling after an
authoritative delisting re-screen — there is no disposal branch.** An
earlier revision added "or disposed with the rest of the frozen balance
under whatever terminal the sanctions machinery prescribes", which is an
open-ended licence the repository's policy does not grant: frozen funds
are never seized, redirected, or released, and become claimable only
after delisting (`LibVaipakam.sol:9850-9854`). The liability stays
frozen and encumbered until delisting, however long that is; a disposal
terminal, if the owner ever wants one, is a separately approved change
to the sanctions POLICY — never an open branch in a bond design. **And it is an ENCUMBRANCE on every withdrawable-balance
read from the moment of adjudication — RETAINED IN FULL before any
parked release pays out** (retained, not settled: settlement is
fallible and retryable, per the retain-and-release-net rule below —
"settled before" would hand a broken recycle path a full-balance
freeze).** The parked-withdrawal release pays the request cap
net of debits and reservations; converting the reservation into a
liability without joining that netting lets a release-first
implementation return the reserved units at delisting and leave nothing
to recycle. The adjudicated liability persists in the withdrawal
accounting (netted from every payable figure) — and the delisting
release **retains the liability's EXACT amount in escrow and pays the
net remainder immediately**, never holding clean principal hostage to
the settlement's health: settlement is allowed to fail and retry, so
release-after-settlement turns a broken recycle or old-token path into
a full-balance freeze of an operator the oracle has delisted, when
retaining the encumbered 10 of a 100-unit deposit fully secures the
liability and the 90 owes nobody anything. Settle-then-release becomes
retain-and-release-net; the escrowed amount settles whenever the path
heals. The debit is never escaped and the freeze is never violated;
the two rules meet at a parked adjudication.

**Both parties are screened on a deposit-on-behalf**, not just the caller. The
  repository's sanctions rule requires the actual recipient or position holder in
  addition to the sender wherever a call acts for someone else
  (`ProjectDetailsREADME.md` §sanctions). Screening only the caller lets a
  sanctioned operator acquire a funded bond through a clean payer; screening only
  the operator lets a sanctioned payer move value into protocol custody. Both
  identities, and the withdrawal recipient bound to whichever ownership model
  §Mechanics selects. So `postBond`, any deposit-on-behalf or permit
  variant, and (under C) the arming-fee payer each need
  screening — **and the arming-fee payer's screen is the REGISTRY-AWARE
  tri-state gate, not the plain helper**: `_assertNotSanctioned` is
  fail-open on an oracle outage and never consults
  `sanctionsConfirmedFlagged` (`LibVaipakam.sol:9934-9945`), so a payer
  already confirmed through another path could wait out an outage and
  have a non-refundable fee moved into recycling against freeze-not-
  seize. Previously confirmed payers are rejected during an outage;
  fail-open remains only for addresses never confirmed flagged — **and BOTH non-trivial branches write**: a first authoritative
  `Flagged` read on the arming path persists the confirmed marker in a
  COMMITTED, value-unmoving transition (the call returns refused, the
  observation stays — a plain revert rolls the marker back, and the
  payer retries through the fail-open branch during the next outage,
  moving the fee into recycling as "never confirmed"; flag → arm →
  outage → arm is the acceptance case); and an
  authoritative CLEAN read SELF-HEALS the stale
  marker, as the release and position-movement paths already do: a
  view-style gate that merely ignores the marker on a healthy read
  leaves it standing, and the next outage bars a payer the oracle
  authoritatively delisted in between. Delist → arm → outage is the
  acceptance case. The
  other selectors keep `_assertNotSanctioned` for their REFUSALS — but
  every party screen that observes an authoritative CLEAN result on a
  wallet carrying a stale confirmed marker SELF-HEALS it in that call —
  **with ALL party statuses read BEFORE effects, and a mixed result
  landing as a COMMITTED, value-unmoving refusal that writes BOTH
  directions — every party read `Clean` self-heals its stale marker AND
  every party read `Flagged` persists its `sanctionsConfirmedFlagged`
  bit in the same act** (a refusal that only heals leaves a first-flag
  operator "never confirmed": the next outage's fail-open branch then
  accepts and later releases their principal against the earlier
  authoritative flag): a permit/on-behalf
  call that heals the payer and then reverts on the flagged operator
  rolls the heal back with everything else, and the next outage blocks
  that authoritatively-delisted payer from their own fail-closed paths
  (`postCapacityDeposit`, the permit/on-behalf party screens, all of
  them): the plain helper is a view, so a clean read that merely passes
  leaves the marker standing, and the next outage freezes the newly
  deposited principal of an operator the oracle authoritatively
  delisted in between. Flag → delist → deposit → outage → withdraw is
  the acceptance case — and each selector needs its focused
  test — **but `unbond` does
  NOT take the reverting helper**, and this list said it did for one round
  after the paragraph above established why it cannot: when `unbond` is the
  first authoritative observation of the flag, a revert rolls back the
  committed `sanctionsConfirmedFlagged` + parked-withdrawal writes, and a later
  oracle outage then routes the same balance through the never-confirmed
  fail-open branch. `unbond` uses the committed non-reverting tri-state
  transition (park, persist the flag, refuse the payout); a plain revert is
  acceptable there only once the flag is ALREADY persisted, because then there
  is nothing new to keep. Omitted from an
  earlier revision of this list entirely, which would have let a flagged
  operator post, withdraw or pay a fee through an unscreened path.
- **PAUSE AND REENTRANCY GUARDS, on the inflow and fee selectors.** The
  repository's own coding standard (`docs/FunctionalSpecs/TokenomicsTechSpec.md`)
  requires every new VPFI vault-deposit, fee-deduction and treasury-receipt
  function to carry the project-standard reentrancy guard and the global
  pausable mechanism unless it is a pure/view helper. This list previously
  required sanctions screening and stopped there, which would have satisfied
  the design while leaving `postBond`, any permit / deposit-on-behalf variant,
  and (under C) the arming fee callable during an incident, or exposing an
  unguarded external token-transfer path.

  **`unbond` is the deliberate exception and must stay one.** It is the exit,
  and an exit that a pause can close is a freeze on operator capital rather
  than a containment lever — the same asymmetry that took `whenNotPaused` off
  the perk setter. So: guard and pause the inflows; guard the exit, never
  pause it. Two focused tests, one per direction, because a single test that
  only proves the pause blocks something would pass on an implementation that
  pauses everything.

  **Omitting `whenNotPaused` is necessary and not sufficient — the app has a
  SECOND gate.** `apps/app/src/contracts/tosWriteGate.ts` closes every write
  for an operator who has not accepted a newly published Terms version, and it
  is an allowlist: only selectors in `EXIT_WRITES` stay reachable. A contract
  that cannot be paused is still unreachable through the official client if the
  gate does not list it, so a Terms update would freeze operator capital exactly
  as a pause would — with the note still promising the exit is open.

  So **`withdrawCapacityDeposit`** — the ACTUAL selector; `unbond` is prose
  shorthand existing in no ABI, and `tosWriteGate.ts` compares exact
  function names, so the shorthand in this instruction would leave the
  real exit blocked whenever Terms acceptance is stale — goes in
  `EXIT_WRITES` and on an exempt route (with the focused gate test naming
  it too), while `postCapacityDeposit`,
  any deposit-on-behalf or permit variant and (under C) the arming fee stay
  gated — the same inflow/exit split as the pause. The stale-Terms case needs
  its own test: it is a different mechanism from the pause and passes none of
  the pause's tests.

- **SHIPPING PREREQUISITE, not a test: reward-funding isolation (#1566).**
  `RewardClaimFacet` takes `backingRoom` from `LibVpfiRecycle.backingPosition`,
  which treats every VPFI outside `recycleBucket` as reward backing — so a
  refundable bond deposited into the Diamond becomes available for transfer
  to reward claimants. Bonds cannot ship before that is closed.

  An earlier revision listed only the escrow accounting invariant here, as
  though extending the enumerated Diamond-balance check were the remedy. It
  is not, and `TokenomicsTechSpec` records why: per-custody subtraction was
  REJECTED, because related reward clocks can advance while payouts are
  blocked, and it says outright that new custody classes must wait for the
  delivered-for-rewards bound. A bond is exactly such a class. #1566's own
  design note says the same thing from the other side — "new custody classes
  should wait for this".

  The escrow accounting invariant still applies once that lands: bonds are a
  fourth tracked balance class alongside user LIF custody, unclaimed budgets
  and the recycle bucket, and the Diamond-balance invariant must cover it
  (#892 / L13). It is necessary and it was never sufficient.
- **ANY PREDICATE-ENABLED TIER (was "(B) / attested tier only" — same rescope as the criterion above: the first slash predicate may arrive by enrolment on A or C)** — Slash → recycle **through the per-token or
  escrow settlement path**, never the live single-token
  `LibVpfiRecycle.credit`: rotation CARRIES old-token reservations, so a
  post-rotation resolution would otherwise check and credit the **replacement**
  token rather than the confiscated old asset — reverting, or corrupting recycle
  accounting. `ServiceBondSlash` remains the source classification; only the
  transport changes — which means the criterion must **not** name
  `LibVpfiRecycle.credit` at all for this path, and an earlier revision still
  did while forbidding it one sentence above. The API exercised is the selected
  **per-token credit or escrow settlement**, whose event carries
  `RecycleSource.ServiceBondSlash` and not a new generic source. (An earlier
  revision then went on to mandate the live `credit(...)` call in the very next
  sentence — describing the change and then naming the forbidden API. The
  classification survives; the call does not appear in this criterion at all.)
  Under (A) there is no production call that can satisfy this, so it is
  deferred rather than left unwritable.
- **ANY PREDICATE-ENABLED TIER (was "(B) / attested tier only" — same rescope as the criterion above: the first slash predicate may arrive by enrolment on A or C)** — each objective slash predicate proven
  on-chain-verifiable and proven to fire on committed state rather than a
  revert. Under (A) and (C) the predicate set is empty by construction, and
  the acceptance case inverts: **only an owner-authorized deposit or
  withdrawal may change the principal, and NO path transfers it to
  recycling.** Stated that way rather than as "every entry point leaves the
  balance unchanged", which is not writable — bond and unbond necessarily
  change it, so that phrasing forces an ad-hoc exclusion or fails the
  lifecycle requirement. Under (C) the arming fee is the one permitted
  transfer to recycling, and it is charged at arming rather than by an
  operational path.
- **No v1 predicate depends on external state moving between broadcast and
  execution** — the acceptance case is the ABSENCE of such a predicate. An
  earlier revision required testing a caller-supplied snapshot, which is the
  mechanism this note rejects, so that test could not have been written
  honestly.
- **ANY PREDICATE-ENABLED TIER (was "(B) / attested tier only" — same rescope as the criterion above: the first slash predicate may arrive by enrolment on A or C)** — dust slashing **over a POSITIVE NET base only: ceiling rounding applies to the computed net-of-liabilities figure, and a zero net base records ZERO** (the fully-encumbered rule — a minimum-one-unit debit against a zero net base mints a liability with no action-time backing, spurious or reaching protected later deposits): a 1-unit balance still
  debits 1 unit under ceiling division and reaches zero, so no positive
  balance survives a slash unchanged. Under (A) and (C) there is no slash
  path for this to exercise, so it is deferred with the others; the ceiling
  -division helper itself can still be unit-tested in isolation, which is
  where the rounding property actually lives.
- Free-tier operation at ZERO bond, for every role. This is the
  permissionless baseline the whole design is built to preserve, and it is
  the case a capacity bug silently breaks.
- Dark mode preserves withdrawals and the free tier: disabling the feature
  must not strand escrowed VPFI or block unbonded operation.

**Limiter shape** — deferred with the mechanism, per §3's checklist, but its
acceptance criteria are:

- **No implicit minimum, tested DISCRIMINATINGLY.** "A small bond eventually
  affords an action" is vacuous: the mandatory zero-bond free tier eventually
  affords the same action, so an implementation that rounds every small bond's
  incremental capacity to zero passes it — while violating the continuous
  curve it is meant to prove. The test must hold the free allowance constant
  or exhausted and show measurable additional admission, or a measurably
  shorter wait, ATTRIBUTABLE TO the small bond. Same rule this programme
  applies elsewhere: reachability is not discrimination.
- The stated envelope holds over a rolling window.
- **A capacity or curve retune either settles the elapsed credit under the old
  capacity OR invalidates the affected buckets and forfeits their pre-retune
  credit — never silently re-credits it under the new capacity.** An earlier
  revision of this decision required settlement unconditionally, which the
  corrected mechanism's permitted conservative branch cannot satisfy: that branch
  invalidates by design. Stated unconditionally, a reset-based implementation
  would satisfy the mechanism and violate the decision.
- A capacity change of any cause — up or down — settles elapsed credit under
  the old capacity before the new one takes effect, **OR invalidates the
  affected buckets and forfeits their pre-retune credit** — never silently
  re-credits it under the new capacity, which is the part that is absolute. The corrected mechanism explicitly permits the
  conservative branch — invalidate the affected buckets on a curve or capacity
  retune — which DISCARDS pre-retune credit by design rather than settling it.
  Written unconditionally, this criterion and that branch cannot both be
  satisfied, and an earlier revision left them contradicting each other.

  So the criterion is: **either** the old accrual is settled under the old
  capacity, **or** the bucket is invalidated and its pre-retune credit
  deliberately forfeited — never silently re-credited under the new capacity,
  which is the actual failure both wordings exist to exclude. A reset-based
  implementation satisfies this by showing the invalidation; a history-retaining
  one satisfies it by showing the settlement.
