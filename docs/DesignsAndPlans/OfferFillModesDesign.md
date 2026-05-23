# ADR — Offer fill-mode flavours (Issue #125)

**Status:** Accepted
**Date:** 2026-05-23

## Context

Vaipakam's offers today are implicitly **partial-allowed**: a Range
Orders Phase 1 offer can be matched at any size in `[amount,
amountMax]`, with the remainder staying on the book. DEX / CEX order
books expose well-established **fill-mode modifiers** — AON, IOC, FOK,
POST, etc. — that let an order creator pin deterministic fill
semantics. Adopting the standard vocabulary lowers cognitive cost for
integrators (bots, frontends) who already know what these terms mean
and matches user expectations for an offer-board UX.

## Decision

Add an `Offer.fillMode` enum field carrying three modes for this PR.
The remaining DEX-style modifiers were considered and either deferred
or rejected (rationale in the alternatives section).

```
enum FillMode { Partial, Aon, Ioc }
```

`Partial` is the zero-init default — every legacy storage row and
every legacy `CreateOfferParams` construction site reads as `Partial`
without code changes, so this PR is bit-for-bit backward compatible
for existing offers.

### `Partial` — today's behaviour, unchanged

The offer is matchable at any size in `[amount, amountMax]`; the
remainder stays open. No new code path; the existing Range Orders
Phase 1 matching is the `Partial` implementation.

### `Aon` — All-or-Nothing

The offer admits **exactly one full-size fill**, sized to
`offer.amount`. Two layers of enforcement:

1. **Create-time invariant:** `amount == amountMax`. A non-trivial
   amount range under AON is structurally meaningless — only the
   full fill is ever reachable, so the min/max gap would never be
   observable. Forcing single-value at create lets the match-time
   gate be a clean equality check (`matchAmount == offer.amount`)
   without threading "the AON-required amount" through the matcher
   midpoint logic.
2. **Match-time gate:** `LibOfferMatch.previewMatch` returns
   `MatchError.AonRequiresFullFill` when either side is AON and the
   would-be matchAmount isn't its `amount`, OR when the AON side's
   `amountFilled` is already non-zero (defensive — AON should never
   admit a prior fill, but the check is belt-and-suspenders against
   any future code path that bypasses the gate). The
   `OfferMatchFacet.matchOffers` entry re-raises this as a typed
   `OfferAcceptFacet.AonRequiresFullFill(offerId, required,
   provided)` revert so the matcher's revert decoder can render
   "offer X is AON; your match would have only filled Y of Z."

Direct-accept via `OfferAcceptFacet.acceptOffer` doesn't need a
separate AON gate: that path always consumes the full offer amount
(lender's `amountMax` for ERC-20 lender offers; borrower's `amount`
for ERC-20 borrower offers), and the create-time `amount ==
amountMax` invariant makes those identical for AON offers. The AON
constraint is therefore satisfied structurally on direct-accept.

### `Ioc` — Immediate-or-Cancel

The offer is **partial-fillable, but only inside the time window**
the creator set via `expiresAt`. Past the deadline the lazy-expiry
gate (from #195) kicks in: every accept / match consumer reads
through `LibVaipakam.isOfferExpired(offer)` and refuses bound offers.
The unmatched remainder is then cleanable via the permissionless
`cancelOffer` path #195 also introduced.

The new contract surface for IOC is **purely the metadata flag**:

- `Offer.fillMode = Ioc` (vs. `Partial`) gives indexers and the
  frontend a clear discrimination signal so they can render "IOC, 60s
  window left" rather than "GTT until <date>."
- Create-time invariant: `expiresAt > 0`. An IOC without a window is
  structurally identical to `Partial` — the window IS the IOC's
  defining knob.

The runtime enforcement (lazy expiry, permissionless clear) is shared
verbatim with #195's GTT path. **No new state, no new mechanism** —
IOC is a vocabulary wrapper over the existing `expiresAt` field.

## Alternatives considered (DEX modifiers we did NOT take)

### `Fok` — Fill-or-Kill *(deferred)*

Strictly stricter than AON: must fill in full **in the same block**
or revert. For P2P lending matches that take seconds-to-minutes
(matcher bots, multi-party confirmation flows), the same-block
constraint is too tight to be useful; AON ("eventually, in full")
serves the same user intent without the tx-ordering brittleness.
Adding `Fok` to the enum is structurally trivial (one extra variant +
one match-time check) and can land in a follow-up if a real user
asks.

### `Post` — Post-Only / Maker-Only *(rejected as a no-op)*

In DEX terms, POST = "this order can never be the taker of another
order." Vaipakam's model has **every offer structurally a maker**:
the offer sits on the open-book; an acceptor (user or `matchOffers`
bot) is always the taker. An offer never acts as the taker of
another offer — the acceptor is always `msg.sender` of `acceptOffer`
or the matcher bot in `matchOffers`. POST-only would therefore be a
no-op surface that adds a confusing UI option doing nothing.
Rejected.

### `Iceberg` — visible-size vs total-size *(deferred post-mainnet)*

Useful for large lenders who don't want to telegraph their full size
on the book. Adds non-trivial storage (`visibleSize`,
`hiddenRemaining`) and refresh logic on every fill. Lower priority
pre-mainnet — revisit when actual order-book size patterns surface a
real demand signal.

### `Reduce-Only`, `Stop`, `Stop-Limit`, `TWAP` *(N/A)*

Reduce-only and stop modes don't map to Vaipakam's lending semantics
(there's no "position-closing" sense, and APR isn't a price the way a
DEX trade price is). TWAP's smoothing isn't useful at the slow
match cadence of P2P lending.

## Implementation summary

- **Enum + struct field:** `LibVaipakam.FillMode { Partial, Aon, Ioc
  }`. Packed into the Offer struct's slot 1 (1 byte of free headroom).
  Default 0 = `Partial` for backward compat.
- **Create-time validation** in
  `OfferCreateFacet._writeOfferPrincipalFields`:
  `params.fillMode == Aon` ⇒ `amount == amountMax`
  (`AonRequiresSingleValueAmount`); `params.fillMode == Ioc` ⇒
  `expiresAt > 0` (`IocRequiresExpiry`).
- **Match-time enforcement** in `LibOfferMatch.previewMatch`: after
  the midpoint matchAmount is computed, each AON side requires
  `matchAmount == offer.amount && offer.amountFilled == 0`. Violations
  return `MatchError.AonRequiresFullFill`. `OfferMatchFacet.matchOffers`
  re-raises this as a typed
  `OfferAcceptFacet.AonRequiresFullFill(offerId, required, provided)`
  for the matcher's revert decoder.
- **Event payload:** `OfferCreatedDetails`'s `OfferCreatedFields`
  carries `fillMode` so indexers and the frontend cache merges can
  render the mode chip without a follow-up `getOffer` view-call.
- **Direct-accept path:** unchanged. The create-time AON invariant
  makes the direct-accept full-consumption naturally AON-compatible;
  the IOC time gate is shared with #195's GTT lazy-expiry path
  already wired into `_acceptOffer`.

## Trade-offs accepted

- **`fillMode` is immutable for the offer's lifetime.** The #193
  modify surface does not touch this field. Changing fill mode
  mid-life would alter the offer's economic contract in ways the
  acceptor agreed to at create-time inspection; immutable is the
  conservative call.
- **IOC = GTT + metadata.** A user who sets `fillMode = Ioc` with a
  1-year `expiresAt` gets an effective GTT offer with an "IOC" badge.
  This is acceptable — the flag is descriptive metadata; the
  enforcement is the window itself, not the label. The frontend
  surfaces a recommended short window (e.g. 60s) for IOC; the
  contract doesn't cap it (the GTT horizon cap already applies).
- **No FOK / POST / Iceberg.** Documented rejection / deferral above.
  Append-only enum keeps the future addition non-breaking.

## Failure modes

- **Caller passes `fillMode = Partial` (default)** → no change; legacy
  behaviour.
- **AON with `amount != amountMax`** → `AonRequiresSingleValueAmount`
  at create. Frontend surfaces "AON offers must be single-value."
- **IOC with `expiresAt = 0`** → `IocRequiresExpiry` at create.
  Frontend surfaces "IOC offers require a window."
- **Match against AON with size mismatch (overlap doesn't admit the
  AON-required size)** → existing `AmountNoOverlap` fires (the AON
  branch is downstream of the overlap check).
- **Match against AON with partial midpoint** → only reachable if
  `amountFilled > 0`, which AON itself never admits in normal flow;
  the defensive `AonRequiresFullFill` branch catches it.
- **IOC past expiry** → reuses #195's `OfferExpired(offerId,
  expiresAt)` revert + the lazy-clear path. Documented in #195's ADR.

## Test coverage

`contracts/test/OfferFillModeTest.t.sol` — 11 cases covering:

- `Partial` default preserved + legacy storage rows read as `Partial`
  (zero-init = `Partial` sentinel).
- AON create-time: rejects `amount != amountMax`; accepts the single-
  value shape; direct-accept on AON succeeds with full fill.
- IOC create-time: rejects `expiresAt = 0`; accepts the windowed
  shape including ranged amount; offer rejects accept past
  `expiresAt`.
- AON via `previewMatch`: full-fill at the AON amount succeeds (both
  one-sided and both-sided AON); a borrower floor above the AON size
  produces `AmountNoOverlap` (upstream gate) before AON.

## Out of scope / tracked separately

- Frontend "Fill mode" dropdown on the CreateOffer form + tooltips —
  follow-up UI card under `#166`.
- FOK / Iceberg — append the enum + add the match-time branch
  whenever the user signal warrants it; non-breaking additions.
- Cross-chain fill-mode coordination — fill modes apply only to
  single-chain lending offers; the `VpfiBuyAdapter` /
  `VpfiBuyReceiver` flow is structurally best-effort.
