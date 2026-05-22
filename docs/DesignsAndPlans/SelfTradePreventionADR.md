# ADR — Self-trade prevention on direct-accept + matchOffers (Issue #194)

**Status:** Accepted
**Date:** 2026-05-22

## Context

Pre-#194, `OfferAcceptFacet.acceptOffer(offerId, true)` and
`OfferMatchFacet.matchOffers(lenderOfferId, borrowerOfferId)` happily
let a single address land on both sides of the resulting loan:

- A user posts a lender offer A. The same user posts a borrower
  offer B with a compatible range. A bot (or the user themselves)
  calls `matchOffers(A.id, B.id)` — the loan initiates with the
  user's address on both `loan.lender` and `loan.borrower`.
- A user posts a lender offer A. They call `acceptOffer(A.id)`
  from the same wallet — direct-accept goes through.

CEXs and DEXs typically reject self-trades because they obscure
order-book depth and let a user wash-trade their own positions for
fee-rebate harvesting or rank-gaming. For Vaipakam, the equivalent
risks are:

1. **LIF kickback wash-loop** — the matcher (= 1% kickback recipient
   on the 0.1% Loan Initiation Fee) is whoever submits `matchOffers`
   or whoever directly accepts. If the matcher is also the lender or
   borrower, they're paying themselves a kickback. Net cost is the
   99% treasury share; tiny in absolute terms but it's free yield on
   a low-gas chain at scale.
2. **Reward / interaction accounting pollution** —
   `RewardReporterFacet` counts a self-loan as a real interaction
   for the day's lender + borrower denominators. A user could pump
   their share of the global denominator (and the rewards that flow
   from it) with manufactured self-trades.
3. **HF / risk-metric noise** — a self-trade creates an Active loan
   for a position the user already owns. The indexer's active-loan
   list and the keeper's HF-monitoring loop both treat it as real,
   so the protocol's signal-to-noise on live lending activity
   degrades.

The card (#194) presented three branches:

- **A. Enforce** — revert when `lender == borrower`. Closes all
  three risk vectors.
- **B. Allow but tax** — keep self-trades, but zero the matcher's
  kickback when the matcher is also a counterparty. Closes only the
  LIF wash-loop; leaves reward-accounting and HF-noise unchanged.
- **C. Allow unchanged** — document why, leave behaviour as-is.

## Decision

**Branch A — Enforce.**

A single load-bearing check sits in `OfferAcceptFacet._acceptOffer`
right after the lender / borrower address resolution and BEFORE any
state mutation. The check reverts with
`SelfTradeForbidden(address party)` when `lender == borrower`. The
`party` argument surfaces the collapsed address for the revert
decoder.

The same check covers both code paths because `matchOffers` routes
through `OfferAcceptFacet.acceptOfferInternal` via cross-facet call,
which lands in `_acceptOffer` immediately after `matchOverride` is
written. No separate gate is needed in `LibOfferMatch.executeMatch` —
duplicating it would expand the audit surface for no behavioural
gain.

For ergonomics, a `SelfTrade` variant is added to
`LibOfferMatch.MatchError`, and `LibOfferMatch.previewMatch` returns
that variant early when `L.creator == B.creator`. Bots calling
`previewMatch` (e.g. `apps/keeper`'s offer-matcher loop, the public
reference `vaipakam-keeper-bot`'s `offerMatcher`) short-circuit on
the typed result instead of submitting an `acceptOfferInternal` that
the load-bearing revert would catch. The contract revert is the
authority; `previewMatch` is a UX nicety on top.

## Rationale for picking Branch A

- **All three risks addressed at once.** Branch B leaves the
  reward-accounting and HF-noise pollution untreated. The retail
  deploy's reward weights are non-trivial (cross-chain mesh feeds
  back into VPFI yield), so wash-pumping the denominator is a real
  free-yield surface, not a paper one.
- **Matches user expectation.** Every CEX and most DEX matching
  engines reject self-trades by default. A user discovering they
  could fill their own offer would correctly read it as a missing
  safety check.
- **Simplest mental surface for auditors.** A single equality check
  on two known addresses, after role resolution, is trivially
  reviewable. The alternative branches both require enumerating
  matcher-vs-party permutations.
- **No legitimate use case Vaipakam loses access to.** Branch C's
  "document why" hypothetical was position-rebalancing or
  refinance-equivalents. Vaipakam already has dedicated
  `PrecloseFacet` (`precloseDirect`, `transferObligationViaOffer`,
  `offsetWithNewOffer`, `completeOffset`) and `RefinanceFacet`
  (`refinanceLoan`) entry points for exactly those flows — they
  don't depend on self-trade as an implicit primitive, so removing
  it removes nothing the protocol uses.
- **Future fill-mode interaction is clean.** When #125 introduces
  AON / IOC / FOK / POST fill modes, the self-trade check stays a
  precondition orthogonal to the fill-mode logic — neither path
  triggers the other.

## Scope of the gate

The check fires when, *post-role-resolution*,
`loan.lender == loan.borrower`. The two ways this can happen:

| Path | How `lender == borrower` materializes |
|---|---|
| Direct-accept | `acceptor == offer.creator` — same wallet calls `acceptOffer` on its own offer |
| matchOffers | `L.creator == B.creator` — same wallet posted both the lender offer and the borrower offer |

The matchOffers case ALSO triggers when `matchOverride.counterparty`
(= `L.creator`) == `offer.creator` (= `B.creator`) — same condition,
just routed through the override slot. The single check captures all
three surface shapes.

## What's NOT in scope

- **Multi-account self-dealing** — a user with two wallets W1 and W2
  posts a lender offer from W1 and accepts from W2. The protocol
  has no on-chain identity layer beyond `address`, so this is
  fundamentally out of reach for a contract-side gate. It's the
  same out-of-scope class as Sybil attacks on the reward mesh —
  addressed (if at all) at the off-chain analytics layer, not the
  contract.
- **Approved-keeper self-trade** — if a user authorizes a keeper
  (e.g. `apps/keeper` itself) to act on their behalf and that keeper
  matches the user's lender and borrower offers, the resulting
  `_acceptOffer` still has `lender == borrower == userAddress`. The
  check fires. Keepers don't bypass it.
- **Matcher kickback policy** — Branch B's "allow but tax" implied
  changes to the LIF kickback split. Since Branch A is the chosen
  branch, the kickback math is unchanged.

## Consequences

- `OfferAcceptFacet`'s ABI gains `error SelfTradeForbidden(address)`.
  Indexer / frontend revert decoders pick up the new selector via
  the standard ABI re-export.
- `LibOfferMatch.MatchError` gains the `SelfTrade` variant. The
  `previewMatch` ABI shape is unchanged (still returns a
  `MatchResult`); the new enum value is additive.
- The bot-side matcher (`apps/keeper/src/matcher.ts` and the public
  reference `vaipakam-keeper-bot/src/detectors/offerMatcher.ts`)
  should add `MatchError.SelfTrade` to their preview-result switch
  alongside the other typed errors they already short-circuit on.
  Until they do, they'll still call `acceptOfferInternal` and waste
  gas on the revert, but they won't malfunction.
- The FunctionalSpec for the offer-accept domain (`docs/FunctionalSpecs/`)
  records the new invariant: "no single address can occupy both
  sides of a loan at initiation."

## Test coverage

`contracts/test/SelfTradePreventionTest.t.sol`:

- Direct-accept of own lender offer → revert
  `SelfTradeForbidden(creator)`.
- Direct-accept of own borrower offer → revert
  `SelfTradeForbidden(creator)`.
- `matchOffers` between two same-creator offers → revert
  `SelfTradeForbidden(creator)`.
- `previewMatch` on the same shape → returns
  `MatchError.SelfTrade` (no revert).
- Happy-path negative-control: lender = address A, borrower =
  address B → accept succeeds, no self-trade revert.

## References

- Issue #194
- `_acceptOffer` role-resolution block at `OfferAcceptFacet.sol`
  L562-572 (the check sits right after)
- `LibOfferMatch.previewMatch` early-exit block at
  `LibOfferMatch.sol` L198-211 (the `SelfTrade` classifier sits
  alongside)
- `PrecloseFacet` and `RefinanceFacet` — the legitimate
  position-mutation entry points that obviate "self-trade as
  rebalancing" as a use case.
